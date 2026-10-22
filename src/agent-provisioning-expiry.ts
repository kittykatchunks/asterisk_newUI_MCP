import { setTimeout as delay } from "node:timers/promises";
import type { AgentProvisioningJournal } from "./agent-provisioning-store.ts";

export interface ExpiringGeneration {
  generationId: string;
  notAfter: number;
  draining: boolean;
}

export function parseExpiryInventory(input: unknown): ExpiringGeneration[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Invalid expiry inventory");
  const ids = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 ||
        !("generationId" in item) || typeof item.generationId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.generationId) ||
        !("notAfter" in item) || typeof item.notAfter !== "number" || !Number.isSafeInteger(item.notAfter) || item.notAfter < 1 ||
        !("draining" in item) || typeof item.draining !== "boolean" || ids.has(item.generationId)) {
      throw new Error("Invalid expiry generation");
    }
    ids.add(item.generationId);
    return { generationId: item.generationId, notAfter: item.notAfter, draining: item.draining };
  });
}

export function parseExpiryObservation(input: unknown): {
  newCallsBlocked: boolean; dialogs: number | "unknown"; removed: boolean;
} {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3 ||
      !("newCallsBlocked" in input) || typeof input.newCallsBlocked !== "boolean" ||
      !("removed" in input) || typeof input.removed !== "boolean" ||
      !("dialogs" in input) || (input.dialogs !== "unknown" &&
        (typeof input.dialogs !== "number" || !Number.isSafeInteger(input.dialogs) || input.dialogs < 0))) {
    throw new Error("Invalid expiry observation");
  }
  return { newCallsBlocked: input.newCallsBlocked, dialogs: input.dialogs, removed: input.removed };
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
        const input = await adapter.inventory(signal);
        signal.throwIfAborted();
        const inventory = parseExpiryInventory(input);
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
            return parseExpiryObservation(state);
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

// The caller must await this lifetime and explicitly handle cancellation/failure.
export async function runAgentProvisioningExpiry(
  expiry: ReturnType<typeof createAgentProvisioningExpiry>,
  signal: AbortSignal,
  onSweep: (results: Awaited<ReturnType<typeof expiry.sweep>>) => Promise<void>,
) {
  while (true) {
    signal.throwIfAborted();
    const results = await expiry.sweep(signal);
    signal.throwIfAborted();
    await onSweep(results);
    signal.throwIfAborted();
    await delay(250, undefined, { signal });
  }
}
