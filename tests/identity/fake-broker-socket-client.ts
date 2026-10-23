import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { readBrokerFrame, writeBrokerFrame } from "../../src/agent-broker-frame.ts";

const [path, request, outcome] = process.argv.slice(2);
assert.equal(process.getuid?.(), outcome === "denied" ? 1103 : 1102);
assert.equal(process.getgid?.(), 2100);
assert.match(await readFile("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m);
const socket = createConnection({ path, allowHalfOpen: true });
socket.setTimeout(5000, () => socket.destroy(new Error("Synthetic source client timed out")));
try {
  await once(socket, "connect");
  if (outcome === "denied") {
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    const ended = once(socket, "end");
    socket.resume();
    await ended;
    assert.equal(bytes, 0);
    console.log("null");
  } else {
    await writeBrokerFrame(socket, request, "request");
    if (outcome === "rejected") {
      await assert.rejects(readBrokerFrame(socket, "response"), { message: "Truncated broker frame" });
      assert.equal(socket.bytesRead, 0);
      console.log("null");
    } else {
      assert.equal(outcome, "accepted");
      console.log(await readBrokerFrame(socket, "response"));
    }
  }
} finally {
  socket.destroy();
}
