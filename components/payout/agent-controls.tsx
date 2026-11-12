"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormSuccess } from "@/components/ui/input";
import {
  runPayoutAgentAction,
  runReconcileAgentAction,
  sendAgentRemindersAction,
  type AgentActionState,
} from "@/services/agent/actions";

function useAgentAction(run: () => Promise<AgentActionState>) {
  const [state, setState] = useState<AgentActionState>({});
  const [pending, start] = useTransition();
  return { state, pending, trigger: () => start(async () => setState(await run())) };
}

export function RunAgentButton({ eventId, rerun }: { eventId: string; rerun: boolean }) {
  const { state, pending, trigger } = useAgentAction(() => runPayoutAgentAction(eventId));
  return (
    <div className="space-y-2">
      <Button type="button" onClick={trigger} loading={pending}>
        {rerun ? "Run the payout agent again" : "Run the payout agent"}
      </Button>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
    </div>
  );
}

export function SendRemindersButton({ eventId, runId, count }: { eventId: string; runId: string; count: number }) {
  const { state, pending, trigger } = useAgentAction(() => sendAgentRemindersAction(eventId, runId));
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" onClick={trigger} loading={pending} disabled={Boolean(state.message)}>
        Send {count} reminder{count === 1 ? "" : "s"}
      </Button>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
    </div>
  );
}

export function ReconcileButton({ batchId }: { batchId: string }) {
  const { state, pending, trigger } = useAgentAction(() => runReconcileAgentAction(batchId));
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" size="sm" onClick={trigger} loading={pending}>
        Reconcile with PayPal
      </Button>
      <FormError message={state.error} />
    </div>
  );
}
