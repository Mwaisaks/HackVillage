"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, Input, Label } from "@/components/ui/input";
import {
  createPledgeAction,
  startPledgeCheckoutAction,
  type PledgeActionState,
} from "@/services/escrow/pledge-actions";

export function AddPledgeForm({ eventId, slug }: { eventId: string; slug: string }) {
  const [state, action, pending] = useActionState<PledgeActionState, FormData>(createPledgeAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="slug" value={slug} />
      <div>
        <Label htmlFor="sponsorName" className="text-xs">Sponsor</Label>
        <Input id="sponsorName" name="sponsorName" required maxLength={80} placeholder="Acme Cloud" />
      </div>
      <div>
        <Label htmlFor="sponsorEmail" className="text-xs">Billing email</Label>
        <Input id="sponsorEmail" name="sponsorEmail" type="email" required placeholder="sponsor@example.com" />
      </div>
      <div>
        <Label htmlFor="amount" className="text-xs">USD</Label>
        <Input id="amount" name="amount" inputMode="decimal" required placeholder="1050" />
      </div>
      <Button type="submit" loading={pending}>Add pledge</Button>
      <div className="sm:col-span-4">
        <FormError message={state.error} />
        {state.message ? <p role="status" className="text-sm font-semibold text-success">{state.message}</p> : null}
      </div>
    </form>
  );
}

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-control border border-ink/15 px-2 py-1 text-xs font-semibold text-ink hover:bg-paper"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

export function PayWithPayPalForm({ payToken, amount }: { payToken: string; amount: string }) {
  const [state, action, pending] = useActionState<PledgeActionState, FormData>(startPledgeCheckoutAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payToken" value={payToken} />
      <FormError message={state.error} />
      <Button type="submit" loading={pending} className="w-full">
        Pay {amount} with PayPal
      </Button>
    </form>
  );
}
