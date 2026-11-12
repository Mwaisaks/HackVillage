import { webhookHeadersFrom } from "@/lib/ports/paypal";
import { processPayPalWebhook } from "@/services/escrow/paypal-webhook";

export const dynamic = "force-dynamic";

/**
 * PayPal webhook endpoint (HACKATHON.md F1). Reads the RAW body so signature
 * verification sees the exact bytes PayPal signed. 200 on accepted/duplicate;
 * non-200 makes PayPal retry, which the replay guard makes safe.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  try {
    const result = await processPayPalWebhook(rawBody, webhookHeadersFrom(request.headers));
    if (!result.ok) {
      return Response.json({ received: false, reason: result.reason }, { status: result.status });
    }
    return Response.json({ received: true });
  } catch (error) {
    console.error("[webhook] PAYPAL unexpected processing failure", error);
    return Response.json({ received: false }, { status: 500 });
  }
}
