import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

export type BrokerFrameKind = "request" | "response";

function limit(kind: BrokerFrameKind) {
  if (kind !== "request" && kind !== "response") throw new Error("Invalid broker frame kind");
  return kind === "request" ? 8192 : 32768;
}

export function encodeBrokerFrame(text: string, kind: BrokerFrameKind): Buffer {
  const maximum = limit(kind);
  if (typeof text !== "string") throw new Error("Invalid broker frame text");
  const size = Buffer.byteLength(text, "utf8");
  if (size < 1 || size > maximum) throw new Error("Invalid broker frame size");
  const frame = Buffer.allocUnsafe(4 + size);
  frame.writeUInt32BE(size, 0);
  frame.write(text, 4, size, "utf8");
  return frame;
}

const consumed = new WeakSet<Readable>();

// One frame per byte-mode stream; EOF is mandatory before the payload is returned.
export async function readBrokerFrame(stream: Readable, kind: BrokerFrameKind, signal?: AbortSignal): Promise<string> {
  const maximum = limit(kind);
  if (consumed.has(stream)) throw new Error("Broker frame stream is single-use");
  consumed.add(stream);
  if (stream.readableObjectMode || stream.readableEncoding || stream.destroyed || stream.readableEnded ||
      stream.readableDidRead || stream.readableFlowing === true) {
    stream.destroy();
    throw new Error("Broker frame requires a fresh byte-mode stream");
  }
  return new Promise<string>((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerBytes = 0;
    let payload: Buffer | undefined;
    let payloadBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", failed);
      stream.off("close", closed);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error);
    };
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { fail(new Error("Invalid broker frame chunk")); return; }
      let offset = 0;
      if (headerBytes < 4) {
        const count = Math.min(4 - headerBytes, chunk.length);
        chunk.copy(header, headerBytes, 0, count);
        headerBytes += count;
        offset += count;
        if (headerBytes === 4) {
          const size = header.readUInt32BE(0);
          if (size < 1 || size > maximum) { fail(new Error("Invalid broker frame size")); return; }
          payload = Buffer.allocUnsafe(size);
        }
      }
      if (!payload) return;
      const count = chunk.length - offset;
      if (count > payload.length - payloadBytes) { fail(new Error("Trailing broker frame bytes")); return; }
      chunk.copy(payload, payloadBytes, offset);
      payloadBytes += count;
    };
    const end = () => {
      if (!payload || payloadBytes !== payload.length) { fail(new Error("Truncated broker frame")); return; }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload); }
      catch (error) { fail(error); return; }
      settled = true;
      cleanup();
      resolve(text);
    };
    const failed = (error: Error) => fail(error);
    const closed = () => fail(new Error("Broker frame stream closed before EOF"));
    const aborted = () => fail(signal!.reason);
    const timer = setTimeout(() => fail(new Error("Broker frame read timed out")), 5000);
    stream.on("data", data).once("end", end).once("error", failed).once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
