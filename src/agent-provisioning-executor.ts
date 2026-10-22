import { randomUUID } from "node:crypto";
import { AgentProvisioningConflict } from "./agent-provisioning-store.ts";
import type { AgentProvisioningCommand, AgentProvisioningJournal, ProvisioningReceipt } from "./agent-provisioning-store.ts";

export interface AgentProvisioningAdapter {
  apply(command: AgentProvisioningCommand, signal: AbortSignal): Promise<void>;
  observe(command: AgentProvisioningCommand, signal: AbortSignal): Promise<"verified" | "failed" | "unknown">;
}

export type ProvisioningExecutionResult = { state: "idle" } | {
  state: "expired" | "blocked" | "verified" | "uncertain";
  operationId: string;
};

const active = new WeakSet<AgentProvisioningJournal>();

// All executors for this journal must participate in its local ownership lock.
export function createAgentProvisioningExecutor(journal: AgentProvisioningJournal,
  adapter: AgentProvisioningAdapter) {
  return {
    async step(cancellation?: AbortSignal): Promise<ProvisioningExecutionResult> {
      if (active.has(journal)) throw new AgentProvisioningConflict("Provisioning executor already in flight");
      active.add(journal);
      try {
        return await journal.exclusive(async () => {
          const budget = AbortSignal.timeout(5000);
          const signal = cancellation ? AbortSignal.any([budget, cancellation]) : budget;
          signal.throwIfAborted();
          const work = journal.next();
          if (work.state === "idle") return { state: "idle" };
          const operationId = work.intent.command.operationId;
          if (work.state === "blocked" || work.state === "expired") return { state: work.state, operationId };
          let previous = work.receipts.at(-1);
          const record = (stage: ProvisioningReceipt["stage"], code: string) => {
            const receipt = { receiptId: randomUUID(), sequence: (previous?.sequence ?? 0) + 1, stage, code };
            journal.record(operationId, receipt);
            previous = receipt;
          };
          if (work.state === "ready") {
            // Commit before yielding to an adapter; a crash here requires observation, not replay.
            record("applying", "adapter_apply_requested");
            signal.throwIfAborted();
            await adapter.apply(structuredClone(work.intent.command), signal);
            signal.throwIfAborted();
          }
          const observed = await adapter.observe(structuredClone(work.intent.command), signal);
          signal.throwIfAborted();
          if (observed !== "verified" && observed !== "failed" && observed !== "unknown") {
            throw new Error("Invalid provisioning adapter observation");
          }
          if (observed === "unknown") {
            if (previous?.stage === "applying") record("uncertain", "adapter_state_unknown");
            return { state: "uncertain", operationId };
          }
          record(observed, observed === "verified" ? "adapter_state_verified" : "adapter_state_failed");
          return { state: observed === "verified" ? "verified" : "blocked", operationId };
        });
      } finally { active.delete(journal); }
    },
  };
}
