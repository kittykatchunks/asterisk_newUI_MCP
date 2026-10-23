import { once } from "node:events";
import { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { readBrokerFrame, writeBrokerFrame } from "./agent-broker-frame.ts";
import { parseBrokerReadbackPeer } from "./agent-broker-readback.ts";
import type { BrokerReadbackPeer, BrokerReadbackSource } from "./agent-broker-readback.ts";
import { parseExpiryInventory, parseExpiryObservation } from "./agent-provisioning-expiry.ts";

// The caller must protect socket publication; echoed scope is not server authentication.
export function createAgentBrokerClient(path: string, input: BrokerReadbackPeer): BrokerReadbackSource {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("Broker client requires an absolute local socket path");
  }
  const { customer, epoch } = parseBrokerReadbackPeer(input);
  let busy = false;
  const read = async (action: "inventory" | "generation", cancellation: AbortSignal, generationId?: string) => {
    if (busy) throw new Error("Broker client already in flight");
    if (action === "generation" && (typeof generationId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generationId))) {
      throw new Error("Invalid broker generation ID");
    }
    const signal = AbortSignal.any([AbortSignal.timeout(5000), cancellation]);
    signal.throwIfAborted();
    const socket = new Socket({ allowHalfOpen: true });
    busy = true;
    try {
      socket.connect(path);
      await once(socket, "connect", { signal });
      const request = { version: 1, customer, epoch, action,
        ...(action === "generation" ? { generationId } : {}) };
      const [text] = await Promise.all([
        readBrokerFrame(socket, "response", signal),
        writeBrokerFrame(socket, JSON.stringify(request), "request", signal),
      ]);
      signal.throwIfAborted();
      const response: unknown = JSON.parse(text);
      if (!response || typeof response !== "object" || Array.isArray(response) ||
          !("version" in response) || response.version !== 1 ||
          !("customer" in response) || response.customer !== customer ||
          !("epoch" in response) || response.epoch !== epoch ||
          !("action" in response) || response.action !== action) {
        throw new Error("Invalid broker response scope or action");
      }
      if (action === "inventory") {
        if (Object.keys(response).length !== 5 || !("generations" in response)) {
          throw new Error("Invalid broker inventory response");
        }
        return { action, generations: parseExpiryInventory(response.generations) };
      }
      if (!("generationId" in response) || response.generationId !== generationId || !("state" in response)) {
        throw new Error("Invalid broker generation response");
      }
      if (response.state === "missing" && Object.keys(response).length === 6) {
        return { action, observation: undefined };
      }
      if (response.state === "observed" && Object.keys(response).length === 7 && "observation" in response) {
        return { action, observation: parseExpiryObservation(response.observation) };
      }
      throw new Error("Invalid broker generation response");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      socket.destroy();
      busy = false;
    }
  };
  return {
    async inventory(signal) {
      const result = await read("inventory", signal);
      if (result.action !== "inventory") throw new Error("Invalid broker inventory response");
      return result.generations;
    },
    async generation(generationId, signal) {
      const result = await read("generation", signal, generationId);
      if (result.action !== "generation") throw new Error("Invalid broker generation response");
      return result.observation;
    },
  };
}
