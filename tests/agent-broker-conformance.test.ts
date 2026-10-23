import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";
import { encodeBrokerFrame, readBrokerFrame } from "../src/agent-broker-frame.ts";
import { parseExpiryInventory, parseExpiryObservation } from "../src/agent-provisioning-expiry.ts";

test("shared language-neutral broker vectors conform through TypeScript framing and readback", async () => {
  const vectors = JSON.parse(await readFile(new URL("./identity/broker-conformance.json", import.meta.url), "utf8")) as {
    binding: { customer: string; epoch: string; principal: string };
    generation: { generationId: string; notAfter: number; draining: boolean };
    cases: { name: string; text?: string; hex?: string; padBytes?: number;
      delayEofMs?: number; trailingHex?: string; failure?: "truncated" | "trailing" | "utf8" | "json"; expected: unknown }[];
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
    let waited = false;
    async function* chunks() {
      yield bytes.subarray(0, 1);
      yield bytes.subarray(1, 3);
      yield bytes.subarray(3);
      if (vector.delayEofMs) {
        await delay(vector.delayEofMs);
        assert.equal(reads, before, `${vector.name}: source entered before EOF`);
        waited = true;
      }
      if (vector.trailingHex) yield Buffer.from(vector.trailingHex, "hex");
    }
    const run = async () => broker.read(await readBrokerFrame(Readable.from(
      chunks(), { objectMode: false }), "request"), vectors.binding);
    if (vector.expected === null) {
      await assert.rejects(run(), (error: unknown) => {
        if (vector.failure === "utf8") assert.ok(error instanceof TypeError, vector.name);
        else if (vector.failure === "json") assert.ok(error instanceof SyntaxError, vector.name);
        else if (vector.failure) assert.match(String(error), new RegExp(vector.failure, "i"), vector.name);
        return true;
      }, vector.name);
      assert.equal(reads, before, vector.name);
    } else {
      assert.deepEqual(await run(), vector.expected, vector.name);
      assert.equal(reads, before + 1, vector.name);
    }
    assert.equal(waited, Boolean(vector.delayEofMs), vector.name);
  }
  assert.equal(reads, vectors.cases.filter((vector) => vector.expected !== null).length);
});

test("shared source-output vectors enforce exact expiry shapes in TypeScript broker responses", async () => {
  const vectors = JSON.parse(await readFile(new URL("./identity/broker-conformance.json", import.meta.url), "utf8")) as {
    binding: { customer: string; epoch: string; principal: string };
    generation: { generationId: string };
    sourceCases: { name: string; kind: "inventory" | "observation"; value: unknown; inventoryCount?: number; valid: boolean }[];
  };
  for (const vector of vectors.sourceCases) {
    if (vector.inventoryCount !== undefined) {
      const inventory = Array.from({ length: vector.inventoryCount }, (_, index) => ({
        generationId: `22222222-2222-2222-2222-${index.toString(16).padStart(12, "0")}`,
        notAfter: index + 1, draining: index % 2 === 0,
      }));
      vector.value = inventory;
      assert.equal(new Set(inventory.map((item) => item.generationId)).size,
        vector.inventoryCount, vector.name);
    }
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

test("generation source failure propagates unchanged and never becomes missing before fresh recovery", async () => {
  const vectors = JSON.parse(await readFile(new URL("./identity/broker-conformance.json", import.meta.url), "utf8")) as {
    binding: { customer: string; epoch: string; principal: string };
    generation: { generationId: string };
    cases: { name: string; text: string; expected: unknown }[];
  };
  const vector = vectors.cases.find((item) => item.name === "unknown-dialogs");
  assert.ok(vector);
  const failure = new Error("fixture generation source unavailable");
  let failing = true;
  let entries = 0;
  const broker = createAgentBrokerReadback(vectors.binding, {
    async inventory() { throw new Error("Unexpected inventory source"); },
    async generation(id) {
      assert.equal(id, vectors.generation.generationId);
      entries++;
      if (failing) throw failure;
      return { newCallsBlocked: true, dialogs: "unknown", removed: false };
    },
  });
  await assert.rejects(broker.read(vector.text, vectors.binding), (error: unknown) => error === failure);
  assert.equal(entries, 1);
  failing = false;
  assert.deepEqual(await broker.read(vector.text, vectors.binding), vector.expected);
  assert.equal(entries, 2);
});
