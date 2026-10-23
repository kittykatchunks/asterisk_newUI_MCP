import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createAgentBrokerClient } from "../../src/agent-broker-client.ts";

const [path, request, outcome] = process.argv.slice(2);
assert.equal(process.getuid?.(), outcome === "denied" ? 1103 : 1102);
assert.equal(process.getgid?.(), 2100);
assert.match(await readFile("/proc/self/status", "utf8"), /^CapEff:\s+0+$/m);
if (outcome === "denied") {
  const socket = createConnection({ path, allowHalfOpen: true });
  socket.setTimeout(5000, () => socket.destroy(new Error("Synthetic source client timed out")));
  try {
    await once(socket, "connect");
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    const ended = once(socket, "end");
    socket.resume();
    await ended;
    assert.equal(bytes, 0);
    console.log("null");
  } finally {
    socket.destroy();
  }
} else {
  const input: unknown = JSON.parse(request);
  assert.ok(input && typeof input === "object" && "customer" in input && typeof input.customer === "string" &&
    "epoch" in input && typeof input.epoch === "string" && "action" in input);
  const base = { version: 1, customer: input.customer, epoch: input.epoch };
  const client = createAgentBrokerClient(path, { customer: input.customer, epoch: input.epoch,
    principal: "journal-worker" });
  const signal = AbortSignal.timeout(6000);
  const read = async () => {
    if (input.action === "inventory") {
      return { ...base, action: "inventory", generations: await client.inventory(signal) };
    } else {
      assert.equal(input.action, "generation");
      assert.ok("generationId" in input && typeof input.generationId === "string");
      const observation = await client.generation(input.generationId, signal);
      return { ...base, action: "generation", generationId: input.generationId,
        ...(observation === undefined ? { state: "missing" } : { state: "observed", observation }) };
    }
  };
  if (outcome === "rejected") {
    await assert.rejects(read(), { message: "Truncated broker frame" });
    console.log("null");
  } else {
    assert.equal(outcome, "accepted");
    console.log(JSON.stringify(await read()));
  }
}
