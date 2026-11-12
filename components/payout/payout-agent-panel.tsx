import { ReconcileButton, RunAgentButton, SendRemindersButton } from "@/components/payout/agent-controls";
import { Badge } from "@/components/ui/badge";
import type { PayoutAgentRun, ReconcileRun } from "@/services/agent/payout-agent";

/**
 * The payout agent's output (HACKATHON.md F4): plain-language flags, drafted
 * reminders, and its decision. The approval controls stay in the PayPal
 * panel; the agent can propose but never approve.
 */
export function PayoutAgentPanel({
  eventId,
  run,
  canRun,
}: {
  eventId: string;
  run: PayoutAgentRun | null;
  canRun: boolean;
}) {
  return (
    <section aria-label="Payout agent" className="space-y-4 rounded-control border border-ink/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-ink">Payout Agent</h3>
        {run ? (
          <Badge variant={run.mode === "live" ? "success" : "neutral"}>
            {run.mode === "live" ? `${run.provider} · ${run.model}` : "rules-only"}
          </Badge>
        ) : null}
      </div>
      {!run ? (
        <p className="text-sm text-muted">
          The agent reads the pre-flight checks, explains every problem in plain words, drafts reminders to members
          missing PayPal details, and proposes the batch when it is safe. You approve before any money moves.
        </p>
      ) : (
        <AgentRunView eventId={eventId} run={run} />
      )}
      {canRun ? <RunAgentButton eventId={eventId} rerun={Boolean(run)} /> : null}
    </section>
  );
}

function AgentRunView({ eventId, run }: { eventId: string; run: PayoutAgentRun }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink">{run.summary}</p>
      {run.fallbackReason ? <p className="text-xs text-muted">{run.fallbackReason}</p> : null}

      {run.explanations.length > 0 ? (
        <ul className="space-y-2" aria-label="Agent explanations">
          {run.explanations.map((e) => (
            <li
              key={e.issueIndex}
              className={`rounded-control border p-3 text-sm ${e.severity === "blocker" ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10"}`}
            >
              <span className="mr-2 text-xs font-bold uppercase">{e.severity}</span>
              {e.explanation}
              <span className="mt-1 block text-xs text-muted">Fix: {e.suggestedFix}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {run.reminders.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-bold text-ink">Drafted reminders</h4>
          {run.reminders.map((r) => (
            <details key={r.userId} className="rounded-control border border-ink/15 p-3 text-sm">
              <summary className="cursor-pointer font-semibold text-ink">
                To {r.memberHandle}: {r.subject}
              </summary>
              <p className="mt-2 whitespace-pre-line text-muted">{r.body}</p>
            </details>
          ))}
          <SendRemindersButton eventId={eventId} runId={run.id} count={run.reminders.length} />
        </div>
      ) : null}

      <p className="text-sm font-semibold text-ink">
        {run.decision.type === "proposed"
          ? "Decision: batch proposed. It waits for your approval."
          : run.decision.type === "exists"
            ? "Decision: a batch is already waiting for your approval."
            : `Decision: held. ${run.decision.reason}`}
      </p>
      <p className="text-xs text-muted">Logged {new Date(run.createdAt).toUTCString()} to the audit log.</p>
    </div>
  );
}

export function ReconcilePanel({ batchId, run }: { batchId: string; run: ReconcileRun | null }) {
  return (
    <section aria-label="Reconciliation" className="space-y-3 rounded-control border border-ink/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-ink">Agent Reconciliation</h3>
        {run ? <Badge variant="neutral">{run.provider === "rules" ? "rules-only" : `${run.provider} · ${run.model}`}</Badge> : null}
      </div>
      {run ? (
        <>
          <p className="text-sm text-ink">{run.summary}</p>
          {run.actions.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {run.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted">Checked {new Date(run.createdAt).toUTCString()}.</p>
        </>
      ) : (
        <p className="text-sm text-muted">Compare every payout with PayPal&apos;s own item statuses and flag anything that disagrees.</p>
      )}
      <ReconcileButton batchId={batchId} />
    </section>
  );
}
