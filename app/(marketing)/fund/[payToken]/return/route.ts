import { appUrl } from "@/lib/url";
import { capturePledgeOrder } from "@/services/escrow/pledges";

export const dynamic = "force-dynamic";

/**
 * PayPal returns the sponsor here after approval with ?token=<orderId>.
 * We capture server-side (idempotent), then send the sponsor back to the pay
 * page with the outcome. The PAYMENT.CAPTURE.COMPLETED webhook converges on
 * the same state if this request is lost.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ payToken: string }> }
): Promise<Response> {
  const { payToken } = await params;
  const orderId = new URL(request.url).searchParams.get("token");
  const back = (status: string) => Response.redirect(appUrl(`/fund/${payToken}?status=${status}`), 303);
  if (!orderId) return back("error");

  try {
    const result = await capturePledgeOrder(payToken, orderId);
    switch (result.outcome) {
      case "funded":
        return back(result.eventLive ? "live" : "funded");
      case "duplicate":
        return back("funded");
      case "pending":
        return back("pending");
      case "declined":
        return back("declined");
      default:
        return back("error");
    }
  } catch (error) {
    console.error(`[pledge] return capture failed token=${payToken}`, error);
    return back("error");
  }
}
