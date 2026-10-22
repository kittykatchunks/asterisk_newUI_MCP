import { AgentProvisioningConflict } from "./agent-provisioning-store.ts";
import type { AgentProvisioningStore, ProvisioningIntent, ProvisioningJournalBinding,
  ProvisioningReport } from "./agent-provisioning-store.ts";

export interface AgentProvisioningTransport {
  report(operationId: string, signal: AbortSignal): Promise<ProvisioningReport | undefined>;
  accept(intent: ProvisioningIntent, signal: AbortSignal): Promise<ProvisioningReport>;
}

export interface ProvisioningDispatchResult {
  state: "idle" | "expired" | "blocked" | "accepted" | "reconcile" | "verified";
  operationId?: string;
}

// Injected transport must authenticate the pinned worker and honour cancellation.
export function createAgentProvisioningDispatcher(store: AgentProvisioningStore,
  input: ProvisioningJournalBinding, transport: AgentProvisioningTransport,
  options: { now?: () => number } = {}) {
  const binding = { ...input };
  if (Object.keys(input).length !== 2 || typeof binding.customer !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binding.customer) || typeof binding.epoch !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.epoch)) {
    throw new Error("Invalid provisioning dispatcher binding");
  }
  const now = options.now ?? Date.now;
  let busy = false;
  return {
    async dispatch(): Promise<ProvisioningDispatchResult> {
      if (busy) throw new AgentProvisioningConflict("Provisioning dispatcher already in flight");
      busy = true;
      try {
        const work = store.next(binding.customer, binding.epoch);
        if (work.state === "idle") return { state: "idle" };
        const command = work.intent.command;
        const operationId = command.operationId;
        if (command.epoch !== binding.epoch) throw new AgentProvisioningConflict("Provisioning dispatcher authority mismatch");
        if (work.state === "blocked") return { state: "blocked", operationId };
        const signal = AbortSignal.timeout(5000);
        let report = await transport.report(operationId, signal);
        signal.throwIfAborted();
        if (report === undefined) {
          // Missing remote history cannot erase local evidence of an earlier effect.
          if (work.receipts.length) throw new AgentProvisioningConflict("Worker history missing; reconciliation required");
          const current = store.next(binding.customer, binding.epoch);
          if (current.state === "idle" || current.intent.command.operationId !== operationId) {
            throw new AgentProvisioningConflict("Provisioning head changed during dispatch");
          }
          if (current.state === "blocked") return { state: "blocked", operationId };
          if (current.receipts.length) throw new AgentProvisioningConflict("Provisioning history changed during dispatch");
          const time = now();
          if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid provisioning dispatcher clock");
          if (current.state === "expired" || command.notAfter <= time) return { state: "expired", operationId };
          report = await transport.accept(work.intent, signal);
          signal.throwIfAborted();
        }
        if (report.operationId !== operationId) throw new AgentProvisioningConflict("Worker returned a different provisioning operation");
        store.reconcile(binding, report);
        const operation = store.operation(binding.customer, operationId);
        if (!operation) throw new Error("Reconciled provisioning operation missing");
        const stage = operation.receipts.at(-1)?.stage;
        return { state: stage === "verified" ? "verified" : stage === "failed" ? "blocked" :
          stage ? "reconcile" : "accepted", operationId };
      } finally { busy = false; }
    },
  };
}
