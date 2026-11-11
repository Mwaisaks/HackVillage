import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { escapeHtml } from "@/lib/notifications/html";
import { getPayPalPort } from "@/lib/ports/paypal";
import { appUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/**
 * DEV SIMULATION CHECKOUT for the PayPal rail — mirrors PayPal's approval
 * page when no PayPal credentials are configured. "Approve" redirects to our
 * real return URL with ?token=<orderId>, exactly like PayPal, so the capture
 * runs through the production code path. Disabled in production and
 * whenever live (sandbox) credentials exist.
 */
function simulationEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && getPayPalPort().mode === "simulation";
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>
      body{font-family:-apple-system,system-ui,sans-serif;background:#f5f7fa;color:#001c64;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
      .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;max-width:420px;width:100%;padding:32px;text-align:center}
      .brand{font-weight:800;font-size:20px;margin-bottom:16px}
      .sim{background:#ffc439;color:#001c64;display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700}
      .amount{font-size:36px;font-weight:800;margin:12px 0}
      form{margin-top:24px}button{font:inherit;border:0;border-radius:999px;padding:12px 28px;font-weight:700;cursor:pointer;width:100%}
      .pay{background:#ffc439;color:#001c64}.cancel{display:inline-block;color:#6b7280;margin-top:12px}
    </style></head><body><div class="card">${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> }
): Promise<Response> {
  if (!simulationEnabled()) return new Response("Not Found", { status: 404 });
  const { orderId } = await params;
  const pledge = await prisma.sponsorPledge.findUnique({
    where: { paypalOrderId: orderId },
    include: { event: { select: { title: true } } },
  });
  if (!pledge || pledge.status !== "PLEDGED") {
    return page("Checkout unavailable", "<p>This checkout session is no longer active.</p>");
  }
  return page(
    "Simulated PayPal checkout",
    `<p class="brand">PayPal <span class="sim">SIMULATION</span></p>
    <p>${escapeHtml(pledge.event.title)}: prize pool pledge from ${escapeHtml(pledge.sponsorName)}</p>
    <p class="amount">${formatMoney(pledge.amountMinor, pledge.currency)}</p>
    <p style="font-size:13px;color:#6b7280">order <code>${escapeHtml(orderId)}</code></p>
    <form method="post"><button class="pay" type="submit">Approve simulated payment</button></form>
    <a class="cancel" href="${appUrl(`/fund/${pledge.payToken}?cancelled=1`)}">Cancel and go back</a>`
  );
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> }
): Promise<Response> {
  if (!simulationEnabled()) return new Response("Not Found", { status: 404 });
  const { orderId } = await params;
  const pledge = await prisma.sponsorPledge.findUnique({ where: { paypalOrderId: orderId } });
  if (!pledge) return new Response("Not Found", { status: 404 });
  // Approval done — hand back to our return URL like PayPal does.
  return Response.redirect(appUrl(`/fund/${pledge.payToken}/return?token=${encodeURIComponent(orderId)}`), 303);
}
