import { parseExpiryInventory, parseExpiryObservation } from "./agent-provisioning-expiry.ts";
import type { ExpiringGeneration } from "./agent-provisioning-expiry.ts";
import type { ProvisioningJournalBinding } from "./agent-provisioning-store.ts";

export interface BrokerReadbackPeer extends ProvisioningJournalBinding {
  principal: string;
}

export interface BrokerReadbackSource {
  inventory(signal: AbortSignal): Promise<ExpiringGeneration[]>;
  generation(generationId: string, signal: AbortSignal): Promise<ReturnType<typeof parseExpiryObservation> | undefined>;
}

type ReadbackRequest = { version: 1; customer: string; epoch: string } & (
  { action: "inventory" } | { action: "generation"; generationId: string }
);

export type BrokerReadbackResponse = { version: 1; customer: string; epoch: string } & (
  { action: "inventory"; generations: ExpiringGeneration[] } |
  { action: "generation"; generationId: string; state: "missing" } |
  { action: "generation"; generationId: string; state: "observed"; observation: ReturnType<typeof parseExpiryObservation> }
);

function parseRequest(text: string): ReadbackRequest {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 8192) throw new Error("Invalid broker request size");
  const input: unknown = JSON.parse(text);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid broker request");
  if (!("version" in input) || input.version !== 1 || !("customer" in input) || typeof input.customer !== "string" ||
      !("epoch" in input) || typeof input.epoch !== "string" || !("action" in input)) throw new Error("Invalid broker request");
  const base = { version: 1 as const, customer: input.customer, epoch: input.epoch };
  if (input.action === "inventory" && Object.keys(input).length === 4) return { ...base, action: "inventory" };
  if (input.action === "generation" && Object.keys(input).length === 5 &&
      "generationId" in input && typeof input.generationId === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.generationId)) {
    return { ...base, action: "generation", generationId: input.generationId };
  }
  throw new Error("Invalid broker request fields or action");
}

// The connection owner must derive peer identity from authenticated transport, never JSON.
export function createAgentBrokerReadback(input: BrokerReadbackPeer, source: BrokerReadbackSource) {
  const binding = { customer: input.customer, epoch: input.epoch };
  const principal = input.principal;
  if (Object.keys(input).length !== 3 || typeof binding.customer !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binding.customer) || typeof binding.epoch !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.epoch) ||
      typeof principal !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(principal)) {
    throw new Error("Invalid broker readback binding");
  }
  let busy = false;
  return {
    async read(text: string, peer: BrokerReadbackPeer | undefined, cancellation?: AbortSignal): Promise<BrokerReadbackResponse> {
      if (busy) throw new Error("Broker readback already in flight");
      busy = true;
      try {
        const budget = AbortSignal.timeout(5000);
        const signal = cancellation ? AbortSignal.any([budget, cancellation]) : budget;
        signal.throwIfAborted();
        if (!peer || peer.principal !== principal || peer.customer !== binding.customer || peer.epoch !== binding.epoch) {
          throw new Error("Broker readback peer denied");
        }
        const request = parseRequest(text);
        if (request.customer !== binding.customer || request.epoch !== binding.epoch) throw new Error("Broker readback scope mismatch");
        let response: BrokerReadbackResponse;
        if (request.action === "inventory") {
          const inventory = await source.inventory(signal);
          signal.throwIfAborted();
          response = { version: 1, ...binding, action: "inventory", generations: parseExpiryInventory(inventory) };
        } else {
          const observation = await source.generation(request.generationId, signal);
          signal.throwIfAborted();
          response = observation === undefined
            ? { version: 1, ...binding, action: "generation", generationId: request.generationId, state: "missing" }
            : { version: 1, ...binding, action: "generation", generationId: request.generationId,
              state: "observed", observation: parseExpiryObservation(observation) };
        }
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > 32768) throw new Error("Broker readback response too large");
        return response;
      } finally { busy = false; }
    },
  };
}
