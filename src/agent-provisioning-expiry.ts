import type { AgentProvisioningJournal } from "./agent-provisioning-store.ts";

export interface ExpiringGeneration {
  generationId: string;
  notAfter: number;
  draining: boolean;
}

export interface AgentProvisioningExpiryAdapter {
  inventory(signal: AbortSignal): Promise<ExpiringGeneration[]>;
  fence(generationId: string, signal: AbortSignal): Promise<void>;
  observe(generationId: string, signal: AbortSignal): Promise<{
    newCallsBlocked: boolean;
    dialogs: number | "unknown";
    removed: boolean;
  }>;
  revoke(generationId: string, signal: AbortSignal): Promise<void>;
}

// Adapter inventory and irreversible drain state must be durable and customer-pinned.
export function createAgentProvisioningExpiry(journal: AgentProvisioningJournal,
  adapter: AgentProvisioningExpiryAdapter, options: { now?: () => number } = {}) {
  const clock = options.now ?? Date.now;
  return {
    async sweep(cancellation?: AbortSignal) {
      return journal.exclusive(async () => {
        const budget = AbortSignal.timeout(5000);
        const signal = cancellation ? AbortSignal.any([budget, cancellation]) : budget;
        signal.throwIfAborted();
        const inventory = await adapter.inventory(signal);
        signal.throwIfAborted();
        if (!Array.isArray(inventory) || inventory.length > 100) throw new Error("Invalid expiry inventory");
        const ids = new Set<string>();
        for (const item of inventory) {
          if (!item || Object.keys(item).length !== 3 ||
              typeof item.generationId !== "string" ||
              !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.generationId) ||
              !Number.isSafeInteger(item.notAfter) || item.notAfter < 1 ||
              typeof item.draining !== "boolean" || ids.has(item.generationId)) {
            throw new Error("Invalid expiry generation");
          }
          ids.add(item.generationId);
        }
        const results: { generationId: string; state: "draining" | "uncertain" | "revoked" }[] = [];
        for (const item of inventory) {
          const time = clock();
          if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid expiry clock");
          if (!item.draining && item.notAfter > time) continue;
          signal.throwIfAborted();
          // Fence is idempotent and must durably latch drain before returning.
          await adapter.fence(item.generationId, signal);
          signal.throwIfAborted();
          const observe = async () => {
            const state = await adapter.observe(item.generationId, signal);
            signal.throwIfAborted();
            if (!state || Object.keys(state).length !== 3 ||
                typeof state.newCallsBlocked !== "boolean" || typeof state.removed !== "boolean" ||
                (state.dialogs !== "unknown" && (!Number.isSafeInteger(state.dialogs) || state.dialogs < 0))) {
              throw new Error("Invalid expiry observation");
            }
            return state;
          };
          let state = await observe();
          if (!state.newCallsBlocked) throw new Error("Generation new-call fence not verified");
          if (state.removed && state.dialogs !== 0) throw new Error("Removed generation dialog state inconsistent");
          if (state.dialogs === "unknown") {
            results.push({ generationId: item.generationId, state: "uncertain" }); continue;
          }
          if (state.dialogs > 0) {
            results.push({ generationId: item.generationId, state: "draining" }); continue;
          }
          if (!state.removed) {
            await adapter.revoke(item.generationId, signal);
            signal.throwIfAborted();
            state = await observe();
            if (!state.newCallsBlocked || !state.removed || state.dialogs !== 0) {
              throw new Error("Generation removal not verified");
            }
          }
          results.push({ generationId: item.generationId, state: "revoked" });
        }
        return results;
      });
    },
  };
}
