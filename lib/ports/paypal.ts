import { createHash } from "node:crypto";

import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import type { Order } from "@paypal/paypal-server-sdk";

import { getEnv } from "@/lib/env";

/**
 * PayPal port (HACKATHON.md F1): the ONLY module that talks to PayPal.
 * Mirrors the Paystack port — everything else depends on this interface,
 * never on the SDK or the wire format.
 *
 * - Deposits (sponsor pledges) use Orders v2 via @paypal/paypal-server-sdk.
 * - Payouts use Payouts v1 over REST (the SDK has no Payouts controller).
 * - Webhooks are verified with PayPal's verify-webhook-signature API.
 *
 * Sandbox only: PAYPAL_ENV is pinned to "sandbox" by lib/env.ts.
 *
 * Simulation mode: without PAYPAL_CLIENT_ID/SECRET (local dev, CI) the port
 * returns a local dev checkout URL served by /api/dev/paypal/checkout/[orderId]
 * that completes through the same pledge service path as a real capture.
 * Hard-disabled in production unless explicitly opted in (fail closed).
 */

// ── Money helpers (minor units ↔ PayPal decimal strings) ─────────────────

/** 1234 → "12.34". PayPal amounts are decimal strings with two places. */
export function minorToValue(amountMinor: number): string {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Invalid minor-unit amount: ${amountMinor}`);
  }
  const whole = Math.floor(amountMinor / 100);
  const cents = amountMinor % 100;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

/** "12.34" → 1234, parsed exactly (no float math). Null when malformed. */
export function valueToMinor(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const cents = Number((match[2] ?? "0").padEnd(2, "0"));
  return whole * 100 + cents;
}

// ── Port types ───────────────────────────────────────────────────────────

export interface CreateOrderInput {
  /** Our SponsorPledge id — sent as custom_id so captures map back to it. */
  pledgeId: string;
  amountMinor: number;
  currency: "USD";
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** PayPal-Request-Id: PayPal dedupes retries of the same create. */
  requestId: string;
}

export interface OrderSession {
  orderId: string;
  approveUrl: string;
  simulated: boolean;
}

export type CaptureState = "COMPLETED" | "PENDING" | "DECLINED" | "FAILED" | "UNKNOWN";

export interface CaptureResult {
  state: CaptureState;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** The custom_id we set at order creation (our pledge id). */
  customId: string | null;
  raw: unknown;
}

export interface OrderLookup {
  orderStatus: string;
  capture: CaptureResult | null;
}

/** The five transmission headers PayPal signs every webhook with. */
export interface PayPalWebhookHeaders {
  transmissionId: string | null;
  transmissionTime: string | null;
  transmissionSig: string | null;
  certUrl: string | null;
  authAlgo: string | null;
}

export function webhookHeadersFrom(headers: Headers): PayPalWebhookHeaders {
  return {
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionTime: headers.get("paypal-transmission-time"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    certUrl: headers.get("paypal-cert-url"),
    authAlgo: headers.get("paypal-auth-algo"),
  };
}

export interface PayoutItemInput {
  /** Our Payout id — PayPal's sender_item_id (idempotency per item). */
  senderItemId: string;
  receiver: string;
  recipientType: "EMAIL" | "PHONE";
  amountMinor: number;
  currency: "USD";
  note: string;
}

export interface PayoutBatchInput {
  /** Our PayoutBatch id — PayPal refuses a reused sender_batch_id. */
  senderBatchId: string;
  emailSubject: string;
  items: PayoutItemInput[];
}

export interface PayoutBatchResult {
  batchId: string;
  batchStatus: string;
  simulated: boolean;
}

export interface PayoutItemStatus {
  payoutItemId: string;
  senderItemId: string | null;
  /** SUCCESS | FAILED | PENDING | UNCLAIMED | RETURNED | ONHOLD | BLOCKED | REFUNDED | REVERSED */
  transactionStatus: string;
  amountMinor: number | null;
  errorName: string | null;
}

export interface PayoutBatchStatus {
  batchId: string;
  batchStatus: string;
  items: PayoutItemStatus[];
}

/** Explicit error type for every PayPal failure (CLAUDE.md code style). */
export class PayPalPortError extends Error {
  constructor(
    message: string,
    public kind: "network" | "provider" | "config",
    public status?: number,
    public providerName?: string
  ) {
    super(message);
    this.name = "PayPalPortError";
  }
}

export interface PayPalPort {
  mode: "live" | "simulation";
  createOrder(input: CreateOrderInput): Promise<OrderSession>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureResult>;
  /** Provider truth after an ambiguous capture error. Null when PayPal has no such order. */
  getOrder(orderId: string): Promise<OrderLookup | null>;
  verifyWebhookSignature(headers: PayPalWebhookHeaders, rawBody: string): Promise<boolean>;
  createPayoutBatch(input: PayoutBatchInput): Promise<PayoutBatchResult>;
  getPayoutBatch(batchId: string): Promise<PayoutBatchStatus>;
  getPayoutItem(payoutItemId: string): Promise<PayoutItemStatus>;
}

// ── Response parsing (pure, unit-testable) ───────────────────────────────

function mapCaptureState(status: string | undefined): CaptureState {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "PENDING":
      return "PENDING";
    case "DECLINED":
      return "DECLINED";
    case "FAILED":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/** Extract the first capture of the first purchase unit from an Order. */
export function captureFromOrder(order: Order): CaptureResult | null {
  const unit = order.purchaseUnits?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return null;
  return {
    state: mapCaptureState(capture.status),
    captureId: capture.id ?? null,
    amountMinor: valueToMinor(capture.amount?.value),
    currency: capture.amount?.currencyCode ?? null,
    customId: capture.customId ?? unit?.customId ?? null,
    raw: order,
  };
}

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 15_000;

// ── Live (sandbox) ───────────────────────────────────────────────────────

export class PayPalLive implements PayPalPort {
  mode = "live" as const;
  private orders: OrdersController;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private webhookId: string | undefined
  ) {
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      environment: Environment.Sandbox,
      // The SDK default is 0 (wait forever) — never acceptable on a money path.
      timeout: TIMEOUT_MS,
    });
    this.orders = new OrdersController(client);
  }

  async createOrder(input: CreateOrderInput): Promise<OrderSession> {
    try {
      const { result } = await this.orders.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: input.pledgeId,
              customId: input.pledgeId,
              description: input.description.slice(0, 127),
              amount: { currencyCode: input.currency, value: minorToValue(input.amountMinor) },
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: "HackVillage",
                returnUrl: input.returnUrl,
                cancelUrl: input.cancelUrl,
                userAction: PaypalExperienceUserAction.PayNow,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              },
            },
          },
        },
        paypalRequestId: input.requestId,
        prefer: "return=representation",
      });
      const approve = result.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
      if (!result.id || !approve?.href) {
        throw new PayPalPortError("PayPal order returned no approve link.", "provider");
      }
      return { orderId: result.id, approveUrl: approve.href, simulated: false };
    } catch (error) {
      throw toPortError("createOrder", error);
    }
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureResult> {
    try {
      const { result } = await this.orders.captureOrder({
        id: orderId,
        paypalRequestId: requestId,
        prefer: "return=representation",
      });
      return (
        captureFromOrder(result) ?? {
          state: "UNKNOWN",
          captureId: null,
          amountMinor: null,
          currency: null,
          customId: null,
          raw: result,
        }
      );
    } catch (error) {
      // Already captured (a replayed return or a webhook got there first):
      // the order holds the truth — read it instead of failing.
      if (error instanceof ApiError && error.statusCode === 422) {
        const lookup = await this.getOrder(orderId);
        if (lookup?.capture) return lookup.capture;
      }
      throw toPortError("captureOrder", error);
    }
  }

  async getOrder(orderId: string): Promise<OrderLookup | null> {
    try {
      const { result } = await this.orders.getOrder({ id: orderId });
      return { orderStatus: result.status ?? "UNKNOWN", capture: captureFromOrder(result) };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) return null;
      throw toPortError("getOrder", error);
    }
  }

  async verifyWebhookSignature(headers: PayPalWebhookHeaders, rawBody: string): Promise<boolean> {
    if (!this.webhookId) {
      console.error("[paypal] PAYPAL_WEBHOOK_ID is not set — rejecting webhook (fail closed).");
      return false;
    }
    const { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo } = headers;
    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      return false;
    }
    // Splice the RAW body in as webhook_event: re-serialised JSON can differ
    // byte-for-byte from what PayPal signed and fail verification.
    try {
      JSON.parse(rawBody);
    } catch {
      return false;
    }
    const body =
      `{"transmission_id":${JSON.stringify(transmissionId)},` +
      `"transmission_time":${JSON.stringify(transmissionTime)},` +
      `"cert_url":${JSON.stringify(certUrl)},` +
      `"auth_algo":${JSON.stringify(authAlgo)},` +
      `"transmission_sig":${JSON.stringify(transmissionSig)},` +
      `"webhook_id":${JSON.stringify(this.webhookId)},` +
      `"webhook_event":${rawBody}}`;
    try {
      const payload = (await this.rest("POST", "/v1/notifications/verify-webhook-signature", body)) as {
        verification_status?: string;
      };
      return payload.verification_status === "SUCCESS";
    } catch (error) {
      console.error("[paypal] webhook verification call failed", error);
      return false;
    }
  }

  async createPayoutBatch(input: PayoutBatchInput): Promise<PayoutBatchResult> {
    const body = JSON.stringify({
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        email_subject: input.emailSubject,
      },
      items: input.items.map((item) => ({
        recipient_type: item.recipientType,
        receiver: item.receiver,
        note: item.note,
        sender_item_id: item.senderItemId,
        amount: { value: minorToValue(item.amountMinor), currency: item.currency },
      })),
    });
    const payload = (await this.rest("POST", "/v1/payments/payouts", body, input.senderBatchId)) as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
    };
    const batchId = payload.batch_header?.payout_batch_id;
    if (!batchId) throw new PayPalPortError("PayPal returned no payout_batch_id.", "provider");
    return { batchId, batchStatus: payload.batch_header?.batch_status ?? "PENDING", simulated: false };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatchStatus> {
    const payload = (await this.rest(
      "GET",
      `/v1/payments/payouts/${encodeURIComponent(batchId)}?page_size=1000`
    )) as {
      batch_header?: { batch_status?: string };
      items?: RawPayoutItem[];
    };
    return {
      batchId,
      batchStatus: payload.batch_header?.batch_status ?? "UNKNOWN",
      items: (payload.items ?? []).map(parsePayoutItem),
    };
  }

  async getPayoutItem(payoutItemId: string): Promise<PayoutItemStatus> {
    const payload = (await this.rest(
      "GET",
      `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`
    )) as RawPayoutItem;
    return parsePayoutItem(payload);
  }

  // REST helper for the APIs the SDK doesn't cover (Payouts, webhook verify).
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PayPalPortError(`PayPal token request failed: ${String(error)}`, "network");
    }
    if (!response.ok) {
      throw new PayPalPortError("PayPal token request rejected.", "config", response.status);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new PayPalPortError("PayPal returned no access token.", "provider");
    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
    };
    return this.token.value;
  }

  private async rest(
    method: "GET" | "POST",
    path: string,
    body?: string,
    requestId?: string
  ): Promise<unknown> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${SANDBOX_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PayPalPortError(`PayPal ${method} ${path} failed: ${String(error)}`, "network");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let name: string | undefined;
      try {
        name = (JSON.parse(text) as { name?: string }).name;
      } catch {
        name = undefined;
      }
      throw new PayPalPortError(
        `PayPal ${method} ${path} → ${response.status}: ${text.slice(0, 300)}`,
        "provider",
        response.status,
        name
      );
    }
    return response.json();
  }
}

interface RawPayoutItem {
  payout_item_id?: string;
  transaction_status?: string;
  payout_item?: { sender_item_id?: string; amount?: { value?: string } };
  errors?: { name?: string };
}

export function parsePayoutItem(raw: RawPayoutItem): PayoutItemStatus {
  return {
    payoutItemId: raw.payout_item_id ?? "",
    senderItemId: raw.payout_item?.sender_item_id ?? null,
    transactionStatus: raw.transaction_status ?? "UNKNOWN",
    amountMinor: valueToMinor(raw.payout_item?.amount?.value),
    errorName: raw.errors?.name ?? null,
  };
}

function toPortError(operation: string, error: unknown): PayPalPortError {
  if (error instanceof PayPalPortError) return error;
  if (error instanceof ApiError) {
    const name = (error.result as { name?: string } | undefined)?.name;
    return new PayPalPortError(
      `PayPal ${operation} failed (${error.statusCode}${name ? ` ${name}` : ""}).`,
      "provider",
      error.statusCode,
      name
    );
  }
  return new PayPalPortError(
    `PayPal ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    "network"
  );
}

// ── Simulation ───────────────────────────────────────────────────────────

/**
 * Stateless where it matters: the simulated order id encodes the pledge and
 * amount, so the dev checkout can capture it in another request (or after a
 * restart) without shared memory. Payout batches are remembered in-process
 * for status lookups only.
 */
export class PayPalSimulation implements PayPalPort {
  mode = "simulation" as const;
  private batches = new Map<string, PayoutBatchStatus>();

  async createOrder(input: CreateOrderInput): Promise<OrderSession> {
    const orderId = simulatedOrderId(input.pledgeId, input.amountMinor, input.currency);
    const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    return {
      orderId,
      approveUrl: `${base}/api/dev/paypal/checkout/${orderId}`,
      simulated: true,
    };
  }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const parsed = parseSimulatedOrderId(orderId);
    if (!parsed) {
      throw new PayPalPortError(`Unknown simulated order ${orderId}.`, "provider", 404);
    }
    return {
      state: "COMPLETED",
      captureId: `SIMCAP-${parsed.pledgeId}`,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      customId: parsed.pledgeId,
      raw: { simulated: true, orderId },
    };
  }

  async getOrder(orderId: string): Promise<OrderLookup | null> {
    const parsed = parseSimulatedOrderId(orderId);
    if (!parsed) return null;
    return { orderStatus: "APPROVED", capture: null };
  }

  async verifyWebhookSignature(): Promise<boolean> {
    // Simulation traffic never enters the webhook route.
    return false;
  }

  async createPayoutBatch(input: PayoutBatchInput): Promise<PayoutBatchResult> {
    const batchId = `SIMBATCH-${input.senderBatchId}`;
    const existing = this.batches.get(batchId);
    if (existing) return { batchId, batchStatus: existing.batchStatus, simulated: true };
    const items = input.items.map((item) => ({
      payoutItemId: `SIMITEM-${item.senderItemId}`,
      senderItemId: item.senderItemId,
      transactionStatus: simulatedItemStatus(item.receiver),
      amountMinor: item.amountMinor,
      errorName: simulatedItemStatus(item.receiver) === "FAILED" ? "RECEIVER_UNREGISTERED" : null,
    }));
    const batchStatus = items.every((i) => i.transactionStatus === "SUCCESS") ? "SUCCESS" : "PROCESSING";
    this.batches.set(batchId, { batchId, batchStatus, items });
    return { batchId, batchStatus, simulated: true };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatchStatus> {
    return this.batches.get(batchId) ?? { batchId, batchStatus: "UNKNOWN", items: [] };
  }

  async getPayoutItem(payoutItemId: string): Promise<PayoutItemStatus> {
    for (const batch of this.batches.values()) {
      const item = batch.items.find((i) => i.payoutItemId === payoutItemId);
      if (item) return item;
    }
    return { payoutItemId, senderItemId: null, transactionStatus: "UNKNOWN", amountMinor: null, errorName: null };
  }
}

/** Receiver test hooks: "+simfail", "+simpending", "+simunclaimed" in the email. */
export function simulatedItemStatus(receiver: string): string {
  if (receiver.includes("+simfail")) return "FAILED";
  if (receiver.includes("+simpending")) return "PENDING";
  if (receiver.includes("+simunclaimed")) return "UNCLAIMED";
  return "SUCCESS";
}

export function simulatedOrderId(pledgeId: string, amountMinor: number, currency: string): string {
  const check = createHash("sha256").update(`${pledgeId}:${amountMinor}:${currency}`).digest("hex").slice(0, 8);
  return `SIMORD-${pledgeId}-${amountMinor}-${currency}-${check}`;
}

export function parseSimulatedOrderId(
  orderId: string
): { pledgeId: string; amountMinor: number; currency: string } | null {
  const match = /^SIMORD-([a-z0-9]+)-(\d+)-([A-Z]{3})-([0-9a-f]{8})$/.exec(orderId);
  if (!match) return null;
  const [, pledgeId, amount, currency, check] = match;
  const amountMinor = Number(amount);
  if (simulatedOrderId(pledgeId!, amountMinor, currency!) !== orderId || !check) return null;
  return { pledgeId: pledgeId!, amountMinor, currency: currency! };
}

// ── Factory ──────────────────────────────────────────────────────────────

let cached: PayPalPort | null = null;

export function getPayPalPort(): PayPalPort {
  if (cached) return cached;
  const env = getEnv();
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    cached = new PayPalLive(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_WEBHOOK_ID || undefined);
    return cached;
  }
  if (process.env.NODE_ENV === "production" && !env.PAYPAL_ALLOW_SIMULATION_IN_PROD) {
    throw new Error(
      "[paypal] PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in production. " +
        "Set PAYPAL_ALLOW_SIMULATION_IN_PROD=true to run the simulation port deliberately."
    );
  }
  console.warn("[paypal] No PayPal credentials — running the PayPal rail in SIMULATION mode.");
  cached = new PayPalSimulation();
  return cached;
}
