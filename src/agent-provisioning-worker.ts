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
  await runWorker(journal, adapters, signal, onCycle, options, () => {});
}

type WorkerPhase = "expiry" | "execution" | "reporting" | "waiting";

async function runWorker(
  journal: AgentProvisioningJournal,
  adapters: { execution: AgentProvisioningAdapter; expiry: AgentProvisioningExpiryAdapter },
  signal: AbortSignal,
  onCycle: (cycle: ProvisioningWorkerCycle) => Promise<void>,
  options: { now?: () => number },
  phase: (phase: WorkerPhase) => void,
) {
  const expiry = createAgentProvisioningExpiry(journal, adapters.expiry, options);
  const executor = createAgentProvisioningExecutor(journal, adapters.execution, options);
  await runAgentProvisioningExpiry({
    async sweep(signal) {
      phase("expiry");
      return expiry.sweep(signal);
    },
  }, signal, async (results) => {
    phase("execution");
    const execution = await executor.step(signal);
    signal.throwIfAborted();
    phase("reporting");
    await onCycle({ expiry: results, execution });
    phase("waiting");
  });
}

export interface ProvisioningWorkerHealth {
  state: "idle" | "running" | "stalled" | "stopping" | "stopped" | "failed";
  phase: WorkerPhase | null;
  phaseAgeMs: number;
  completedCycles: number;
  stopRequested: boolean;
}

// Process-local observation only; a stalled effect retains its journal ownership.
export function createAgentProvisioningWorkerSupervisor(
  journal: AgentProvisioningJournal,
  adapters: { execution: AgentProvisioningAdapter; expiry: AgentProvisioningExpiryAdapter },
  options: { stallAfterMs: number; now?: () => number; monotonicNow?: () => number },
) {
  if (!Number.isFinite(options.stallAfterMs) || options.stallAfterMs <= 0) {
    throw new Error("Worker health requires a positive stall threshold");
  }
  const { stallAfterMs, now } = options;
  const clock = options.monotonicNow ?? (() => performance.now());
  let previous = -Infinity;
  function time() {
    const value = clock();
    if (!Number.isFinite(value) || value < 0 || value < previous) throw new Error("Invalid worker health clock");
    previous = value;
    return value;
  }
  let state: "idle" | "running" | "stopped" | "failed" = "idle";
  let phase: WorkerPhase | null = null;
  let phaseAt = 0;
  let completedCycles = 0;
  let cancellation: AbortSignal | undefined;
  return {
    health(): ProvisioningWorkerHealth {
      const phaseAgeMs = state === "running" ? time() - phaseAt : 0;
      const stopRequested = cancellation?.aborted ?? false;
      return {
        state: state === "running" ? phaseAgeMs >= stallAfterMs ? "stalled" :
          stopRequested ? "stopping" : "running" : state,
        phase, phaseAgeMs, completedCycles, stopRequested,
      };
    },
    async run(signal: AbortSignal, onCycle: (cycle: ProvisioningWorkerCycle) => Promise<void>) {
      if (state !== "idle") throw new Error("Worker supervisor is single-use");
      cancellation = signal;
      state = "running";
      try {
        phaseAt = time();
        await runWorker(journal, adapters, signal, async (cycle) => {
          await onCycle(cycle);
          completedCycles++;
        }, { now }, (next) => {
          phaseAt = time();
          phase = next;
        });
        throw new Error("Worker lifetime ended unexpectedly");
      } catch (error) {
        const cancelled = signal.aborted && (error === signal.reason ||
          (error instanceof Error && error.name === "AbortError" && error.cause === signal.reason));
        state = cancelled ? "stopped" : "failed";
        throw error;
      }
    },
  };
}
