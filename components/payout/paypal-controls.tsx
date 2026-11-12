"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FormError, FormSuccess, Input, Label } from "@/components/ui/input";
import {
  approveBatchAction,
  discardBatchAction,
  proposeBatchAction,
  savePayPalHandleAction,
  syncBatchAction,
  type PayPalActionState,
} from "@/services/payout/paypal-actions";

/** Member settings: their own PayPal email or phone. */
export function PayPalHandleForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState<PayPalActionState, FormData>(savePayPalHandleAction, {});
  return (
    <Card>
      <CardTitle>PayPal For Prize Payouts</CardTitle>
      <CardDescription>
        For USD hackathons, every team member is paid their own share directly to PayPal. HackVillage pays
        the fees. No bank details needed.
      </CardDescription>
      <form action={action} className="mt-4 space-y-3">
        <div>
          <Label htmlFor="paypalHandle">PayPal email or phone</Label>
          <Input id="paypalHandle" name="paypalHandle" defaultValue={current ?? ""} placeholder="you@example.com" />
        </div>
        <FormError message={state.error} />
        <FormSuccess message={state.message} />
        <Button type="submit" loading={pending}>Save PayPal</Button>
      </form>
    </Card>
  );
}

function useAction(run: () => Promise<PayPalActionState>) {
  const [state, setState] = useState<PayPalActionState>({});
  const [pending, start] = useTransition();
  return { state, pending, trigger: () => start(async () => setState(await run())) };
}

export function ProposeBatchButton({ eventId, disabled }: { eventId: string; disabled: boolean }) {
  const { state, pending, trigger } = useAction(() => proposeBatchAction(eventId));
  return (
    <div className="space-y-2">
      <Button type="button" onClick={trigger} loading={pending} disabled={disabled}>
        Propose payout batch
      </Button>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
    </div>
  );
}

/** Two-step approval: nothing moves until the organiser confirms the total. */
export function ApproveBatchControls({ batchId, total }: { batchId: string; total: string }) {
  const [confirming, setConfirming] = useState(false);
  const approve = useAction(() => approveBatchAction(batchId));
  const discard = useAction(() => discardBatchAction(batchId));
  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="space-y-2 rounded-control border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm font-semibold text-ink">
            Send {total} through PayPal now? Each member is paid their share in one batch.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={approve.trigger} loading={approve.pending}>
              Approve and pay {total}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={approve.pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setConfirming(true)}>Approve batch</Button>
          <Button type="button" variant="secondary" onClick={discard.trigger} loading={discard.pending}>
            Discard proposal
          </Button>
        </div>
      )}
      <FormError message={approve.state.error ?? discard.state.error} />
      <FormSuccess message={approve.state.message ?? discard.state.message} />
    </div>
  );
}

export function SyncBatchButton({ batchId }: { batchId: string }) {
  const { state, pending, trigger } = useAction(() => syncBatchAction(batchId));
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" size="sm" onClick={trigger} loading={pending}>
        Refresh PayPal status
      </Button>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
    </div>
  );
}
