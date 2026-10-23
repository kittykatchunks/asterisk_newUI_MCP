import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";
import { encodeBrokerFrame, readBrokerFrame } from "../src/agent-broker-frame.ts";
import { parseExpiryInventory, parseExpiryObservation } from "../src/agent-provisioning-expiry.ts";

test("shared language-neutral broker vectors conform through TypeScript framing and readback", async () => {
  const vectors = JSON.parse(await readFile(new URL("./identity/broker-conformance.json", import.meta.url), "utf8")) as {
    binding: { customer: string; epoch: string; principal: string };
    generation: { generationId: string; notAfter: number; draining: boolean };
    cases: { name: string; text?: string; hex?: string; padBytes?: number; expected: unknown }[];
  };
  let reads = 0;
  const broker = createAgentBrokerReadback(vectors.binding, {
    async inventory() { reads++; return [vectors.generation]; },
    async generation(id) {
      reads++;
      return id === vectors.generation.generationId ? { newCallsBlocked: true, dialogs: "unknown", removed: false } : undefined;
    },
  });

  for (const vector of vectors.cases) {
    const before = reads;
    const text = vector.padBytes ? vector.text!.padEnd(vector.padBytes, " ") : vector.text!;
    const bytes = vector.hex !== undefined ? Buffer.from(vector.hex, "hex") : encodeBrokerFrame(text, "request");
    const run = async () => broker.read(await readBrokerFrame(Readable.from(
      [bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)], { objectMode: false }), "request"), vectors.binding);
    if (vector.expected === null) {
      await assert.rejects(run(), vector.name);
      assert.equal(reads, before, vector.name);
    } else {
      assert.deepEqual(await run(), vector.expected, vector.name);
      assert.equal(reads, before + 1, vector.name);
    }
  }
  assert.equal(reads, vectors.cases.filter((vector) => vector.expected !== null).length);
});

test("shared source-output vectors enforce exact expiry shapes in TypeScript broker responses", async () => {
  const vectors = JSON.parse(await readFile(new URL("./identity/broker-conformance.json", import.meta.url), "utf8")) as {
    binding: { customer: string; epoch: string; principal: string };
    generation: { generationId: string };
    sourceCases: { name: string; kind: "inventory" | "observation"; value: unknown; valid: boolean }[];
  };
  for (const vector of vectors.sourceCases) {
    const validate = () => vector.kind === "inventory" ? parseExpiryInventory(vector.value) : parseExpiryObservation(vector.value);
    if (vector.valid) assert.deepEqual(validate(), vector.value, vector.name);
    else assert.throws(validate, vector.name);
    let entries = 0;
    const broker = createAgentBrokerReadback(vectors.binding, {
      async inventory() { entries++; return JSON.parse(JSON.stringify(vector.value)); },
      async generation() { entries++; return JSON.parse(JSON.stringify(vector.value)); },
    });
    const request = { version: 1, customer: vectors.binding.customer, epoch: vectors.binding.epoch,
      ...(vector.kind === "inventory" ? { action: "inventory" } :
        { action: "generation", generationId: vectors.generation.generationId }) };
    if (!vector.valid) await assert.rejects(broker.read(JSON.stringify(request), vectors.binding), vector.name);
    else {
      const result = await broker.read(JSON.stringify(request), vectors.binding);
      assert.deepEqual(result.action === "inventory" ? result.generations :
        result.state === "observed" ? result.observation : undefined, vector.value, vector.name);
    }
    assert.equal(entries, 1, vector.name);
  }
});
