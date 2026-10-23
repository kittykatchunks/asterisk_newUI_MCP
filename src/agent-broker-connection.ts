import type { Socket } from "node:net";
import { readBrokerFrame, writeBrokerFrame } from "./agent-broker-frame.ts";
import type { BrokerReadbackPeer, createAgentBrokerReadback } from "./agent-broker-readback.ts";

// No listener: the caller owns admission at accept, OS identity and error reporting.
export function createAgentBrokerConnectionHandler(
  broker: ReturnType<typeof createAgentBrokerReadback>,
  identify: (socket: Socket) => BrokerReadbackPeer | undefined,
) {
  let busy = false;
  const used = new WeakSet<Socket>();
  return {
    async handle(socket: Socket, cancellation?: AbortSignal): Promise<void> {
      if (used.has(socket)) throw new Error("Broker connection is single-use");
      used.add(socket);
      if (busy) {
        socket.destroy();
        throw new Error("Broker connection capacity reached");
      }
      busy = true;
      const disconnected = new AbortController();
      const signal = AbortSignal.any([
        AbortSignal.timeout(5000), disconnected.signal, ...(cancellation ? [cancellation] : []),
      ]);
      const failed = (error: Error) => disconnected.abort(error);
      const closed = () => disconnected.abort(new Error("Broker connection closed"));
      const abort = () => socket.destroy();
      socket.once("error", failed).once("close", closed);
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        if (!socket.allowHalfOpen || socket.destroyed || socket.readableDidRead ||
            socket.readableFlowing === true || socket.readableEncoding || socket.writableLength !== 0 ||
            socket.writableEnded) throw new Error("Broker connection requires an unused half-open byte socket");
        const identity = identify(socket);
        broker.authorize(identity);
        const peer = identity ? { ...identity } : undefined;
        signal.throwIfAborted();
        const request = await readBrokerFrame(socket, "request", signal);
        const response = await broker.read(request, peer, signal);
        signal.throwIfAborted();
        await writeBrokerFrame(socket, JSON.stringify(response), "response", signal);
      } catch (error) {
        socket.destroy();
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        socket.off("error", failed);
        socket.off("close", closed);
        busy = false;
      }
    },
  };
}
