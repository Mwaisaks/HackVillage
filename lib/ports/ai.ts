import { getEnv } from "@/lib/env";

/**
 * AI port (HACKATHON.md F4): the ONLY module that talks to an LLM provider.
 * Tool-calling chat over the OpenAI-compatible wire format, which Groq (the
 * chosen provider, decision 13) and OpenAI both speak.
 *
 * The agent never moves money through this port. It only reads a redacted
 * view of the payout plan and calls our own tools, which validate every
 * argument server-side. Without AI_API_KEY the agent runs a deterministic
 * rules-only responder (AiSimulation), so local dev and CI need no key.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatInput {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export class AiPortError extends Error {
  constructor(
    message: string,
    public kind: "network" | "provider" | "config",
    public status?: number
  ) {
    super(message);
    this.name = "AiPortError";
  }
}

export interface AiPort {
  mode: "live" | "simulation";
  provider: string;
  model: string;
  chat(input: ChatInput): Promise<AssistantMessage>;
}

const BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};

const DEFAULT_MODELS: Record<string, string> = {
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
};

export class OpenAICompatibleLive implements AiPort {
  readonly mode = "live" as const;

  constructor(
    public provider: string,
    public model: string,
    private apiKey: string,
    private baseUrl: string,
    private timeoutMs = 30_000
  ) {}

  async chat(input: ChatInput): Promise<AssistantMessage> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AiPortError(`AI request failed: ${error instanceof Error ? error.message : String(error)}`, "network");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiPortError(`AI provider returned a non-JSON response (${response.status})`, "provider", response.status);
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "message" in body.error
          ? String((body.error as { message: unknown }).message)
          : `HTTP ${response.status}`;
      throw new AiPortError(`AI provider error: ${message}`.slice(0, 400), "provider", response.status);
    }
    return parseAssistant(body);
  }
}

function parseAssistant(body: unknown): AssistantMessage {
  const choice =
    body && typeof body === "object" && "choices" in body && Array.isArray(body.choices) ? (body.choices[0] as unknown) : null;
  const message = choice && typeof choice === "object" && "message" in choice ? (choice.message as unknown) : null;
  if (!message || typeof message !== "object") throw new AiPortError("AI provider returned no message", "provider");
  const m = message as { content?: unknown; tool_calls?: unknown };
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(m.tool_calls)) {
    for (const raw of m.tool_calls) {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof call.id === "string" && typeof call.function?.name === "string") {
        toolCalls.push({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
          },
        });
      }
    }
  }
  return {
    role: "assistant",
    content: typeof m.content === "string" ? m.content : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Deterministic stand-in: a scripted responder decides the tool calls from
 * the conversation so far. Used without an API key and in tests.
 */
export class AiSimulation implements AiPort {
  readonly mode = "simulation" as const;
  readonly provider = "rules";
  readonly model = "deterministic";

  constructor(private responder: (input: ChatInput) => AssistantMessage) {}

  async chat(input: ChatInput): Promise<AssistantMessage> {
    return this.responder(input);
  }
}

/** The configured live port, or null when no key is set (use the rules responder). */
export function getAiPort(): AiPort | null {
  const env = getEnv();
  if (!env.AI_API_KEY) return null;
  const provider = (env.AI_PROVIDER || "groq").toLowerCase();
  const baseUrl = BASE_URLS[provider];
  if (!baseUrl) {
    console.warn(`[ai] Unknown AI_PROVIDER "${provider}"; the payout agent runs rules-only.`);
    return null;
  }
  return new OpenAICompatibleLive(provider, env.AI_MODEL || DEFAULT_MODELS[provider]!, env.AI_API_KEY, baseUrl);
}
