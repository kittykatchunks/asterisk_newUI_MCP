import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";
import { encodeBrokerFrame, readBrokerFrame } from "../src/agent-broker-frame.ts";

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
  assert.equal(reads, 3);
});
