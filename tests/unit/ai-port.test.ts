import { afterEach, describe, expect, it, vi } from "vitest";

import { AiPortError, OpenAICompatibleLive } from "@/lib/ports/ai";

/** F4 AI port: the OpenAI-compatible wire format Groq speaks. */
describe("OpenAICompatibleLive", () => {
  afterEach(() => vi.unstubAllGlobals());

  const port = new OpenAICompatibleLive("groq", "llama-3.3-70b-versatile", "test-key", "https://api.groq.com/openai/v1");
  const input = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

  it("sends a tool-calling request and parses tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "hold_batch", arguments: '{"reason":"x"}' } }],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const reply = await port.chat(input);
    expect(reply).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "hold_batch", arguments: '{"reason":"x"}' } }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "llama-3.3-70b-versatile", tool_choice: "auto" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("maps provider and network failures to AiPortError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })));
    await expect(port.chat(input)).rejects.toMatchObject({ kind: "provider", status: 429, message: expect.stringMatching(/rate limited/) });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(port.chat(input)).rejects.toBeInstanceOf(AiPortError);
  });
});
