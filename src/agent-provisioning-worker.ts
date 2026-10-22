import { createAgentProvisioningExecutor } from "./agent-provisioning-executor.ts";
import type { AgentProvisioningAdapter, ProvisioningExecutionResult } from "./agent-provisioning-executor.ts";
import { createAgentProvisioningExpiry, runAgentProvisioningExpiry } from "./agent-provisioning-expiry.ts";
import type { AgentProvisioningExpiryAdapter } from "./agent-provisioning-expiry.ts";
import type { AgentProvisioningJournal } from "./agent-provisioning-store.ts";

export interface ProvisioningWorkerCycle {
  expiry: Awaited<ReturnType<ReturnType<typeof createAgentProvisioningExpiry>["sweep"]>>;
  execution: ProvisioningExecutionResult;
}

// Explicit lifetime only: callers own supervision, adapters, journal and shutdown.
export async function runAgentProvisioningWorker(
  journal: AgentProvisioningJournal,
  adapters: { execution: AgentProvisioningAdapter; expiry: AgentProvisioningExpiryAdapter },
  signal: AbortSignal,
  onCycle: (cycle: ProvisioningWorkerCycle) => Promise<void>,
  options: { now?: () => number } = {},
) {
  const expiry = createAgentProvisioningExpiry(journal, adapters.expiry, options);
  const executor = createAgentProvisioningExecutor(journal, adapters.execution, options);
  await runAgentProvisioningExpiry(expiry, signal, async (results) => {
    const execution = await executor.step(signal);
    signal.throwIfAborted();
    await onCycle({ expiry: results, execution });
  });
}
