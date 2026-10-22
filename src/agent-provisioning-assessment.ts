import type { createApplicationSessions } from "./application-session.ts";
import type { AgentProvisioningTransport } from "./agent-provisioning-dispatcher.ts";
import { AgentProvisioningConflict, compareProvisioningReport } from "./agent-provisioning-store.ts";
import type { AgentProvisioningStore, ProvisioningJournalBinding, ProvisioningReceipt } from "./agent-provisioning-store.ts";

type EvidenceStage = ProvisioningReceipt["stage"] | "none";

export type ProvisioningAssessment = { state: "idle" } | {
  state: "assessed";
  operationId: string;
  revision: number;
  deadlineExpired: boolean;
  localStage: EvidenceStage;
  workerStage: EvidenceStage | "missing";
  history: "worker-missing" | "worker-history-missing" | "equal" | "worker-ahead" | "worker-behind";
  ownership: "missing" | "session-unresolved" | "session-resolved" | "trusted-cleanup";
};

// Explicit diagnostic query, not permission to dispatch, abandon, rebind or replay.
export function createAgentProvisioningAssessment(
  store: Pick<AgentProvisioningStore, "next" | "ownership">,
  input: ProvisioningJournalBinding,
  transport: Pick<AgentProvisioningTransport, "report">,
  sessions: Pick<ReturnType<typeof createApplicationSessions>, "resolveAuthorisation">,
  options: { now?: () => number } = {},
) {
  const binding = { ...input };
  if (Object.keys(input).length !== 2 || typeof binding.customer !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binding.customer) || typeof binding.epoch !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.epoch)) {
    throw new Error("Invalid provisioning assessment binding");
  }
  const now = options.now ?? Date.now;
  let busy = false;
  return {
    async assess(cancellation?: AbortSignal): Promise<ProvisioningAssessment> {
      if (busy) throw new AgentProvisioningConflict("Provisioning assessment already in flight");
      busy = true;
      try {
        const budget = AbortSignal.timeout(5000);
        const signal = cancellation ? AbortSignal.any([budget, cancellation]) : budget;
        signal.throwIfAborted();
        const work = store.next(binding.customer, binding.epoch);
        if (work.state === "idle") return { state: "idle" };
        const command = work.intent.command;
        const report = await transport.report(command.operationId, signal);
        signal.throwIfAborted();
        const current = store.next(binding.customer, binding.epoch);
        if (current.state === "idle" || JSON.stringify(current.intent) !== JSON.stringify(work.intent) ||
            JSON.stringify(current.receipts) !== JSON.stringify(work.receipts)) {
          throw new AgentProvisioningConflict("Provisioning head or history changed during assessment");
        }
        let history: Exclude<ProvisioningAssessment, { state: "idle" }>["history"];
        let workerStage: Exclude<ProvisioningAssessment, { state: "idle" }>["workerStage"];
        if (report === undefined) {
          history = current.receipts.length ? "worker-history-missing" : "worker-missing";
          workerStage = "missing";
        } else {
          const compared = compareProvisioningReport(binding, current, report);
          history = compared.additional.length ? "worker-ahead" :
            compared.report.receipts.length < current.receipts.length ? "worker-behind" : "equal";
          workerStage = compared.report.receipts.at(-1)?.stage ?? "none";
        }
        let ownership: Exclude<ProvisioningAssessment, { state: "idle" }>["ownership"];
        if (command.action === "drain" || command.action === "revoke") ownership = "trusted-cleanup";
        else {
          const owner = store.ownership(command.customer, command.operationId);
          ownership = !owner ? "missing" : sessions.resolveAuthorisation(owner) ? "session-resolved" : "session-unresolved";
        }
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid provisioning assessment clock");
        signal.throwIfAborted();
        return {
          state: "assessed", operationId: command.operationId, revision: command.revision,
          deadlineExpired: command.notAfter <= time, localStage: current.receipts.at(-1)?.stage ?? "none",
          workerStage, history, ownership,
        };
      } finally { busy = false; }
    },
  };
}
