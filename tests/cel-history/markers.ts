import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCelHistory } from "../../src/cel-history.ts";
import type { HistoryManifest } from "../../src/history-manifest.ts";
import { inspectHistoryMarker } from "../../src/history-markers.ts";

export async function proveHistoryMarkers(
  database: string, directory: string, generation: string,
  docker: (args: string[], timeout?: number) => Promise<string>,
  snapshot: (customer: string, kind?: "cel" | "queue") => Promise<Buffer>,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
) {
  const customers = ["customer-a", "customer-b"];
  for (const customer of customers) {
    assert.match(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show function UUID"]), /UUID/);
    await docker(["exec", "-T", customer, "asterisk", "-rx",
      "channel originate Local/entry@history-marker/n application Wait 4"]);
  }
  for (const customer of customers) {
    const deadline = performance.now() + 20000;
    while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
      if (performance.now() > deadline) throw new Error("Marker fixture did not finish");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  for (const customer of customers) {
    const source = `pbx-${customer}`;
    const cel = await snapshot(customer);
    const queue = await snapshot(customer, "queue");
    const writer = openCelHistory(database);
    let expectedOffset: number;
    let visitOffset: number;
    let expectedUniqueid: string;
    try {
      writer.ingest({ customer, source, generation, timeBasis: "UTC" }, cel);
      writer.queue.ingest({ customer, source, generation }, queue);
      assert.equal(writer.ingest({ customer, source, generation, timeBasis: "UTC" }, cel).inserted, 0);
      assert.equal(writer.queue.ingest({ customer, source, generation }, queue).inserted, 0);
      const events = writer.read({ customer, source, generation, limit: 200 }).events;
      assert.deepEqual(Buffer.from(events.map((event) => event.rawRecord).join("")), cel);
      const entries = events.filter((event) => event.event === "HISTORY_ENTRY");
      const visits = events.filter((event) => event.event === "HISTORY_QUEUE_VISIT");
      assert.equal(entries.length, 1); assert.equal(visits.length, 1);
      expectedOffset = entries[0].offset; visitOffset = visits[0].offset; expectedUniqueid = entries[0].uniqueid;
      assert.equal(inspectHistoryMarker(writer, customer, source, generation, expectedOffset).markerStatus, "unassigned");
      const manifest: HistoryManifest = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1`,
        operator: "synthetic-marker-proof", reason: "Fresh isolated PBX process; all copied records from its observed single run",
        routes: [{ context: "history-marker", extension: "entry", routeRevision: "marker-v1", entryKind: "synthetic" }],
        ranges: [{ kind: "cel", source, generation, start: 0, end: cel.length },
          { kind: "queue", source, generation, start: 0, end: queue.length }] };
      const path = join(directory, customer, "manifest.json");
      await writeFile(path, JSON.stringify(manifest));
      const args = ["register", database, customer, path];
      const registered = JSON.parse(await cli(args, "Manage-HistoryManifest.ts"));
      assert.equal(JSON.parse(await cli(args, "Manage-HistoryManifest.ts")).id, registered.id);
    } finally { writer.close(); }
    const reader = openCelHistory(database, { readOnly: true });
    try {
      const entry = inspectHistoryMarker(reader, customer, source, generation, expectedOffset);
      const visit = inspectHistoryMarker(reader, customer, source, generation, visitOffset);
      assert.equal(entry.markerStatus, "validated-marker");
      assert.equal(visit.markerStatus, "validated-marker");
      assert.ok("payload" in entry && "payload" in visit && entry.payload && visit.payload);
      assert.equal(entry.payload.journeyId, visit.payload.journeyId);
      assert.notEqual(entry.payload.journeyId, visit.payload.visitId);
      assert.equal(entry.uniqueid, visit.uniqueid);
      const channel = reader.read({ customer, source, generation, uniqueid: expectedUniqueid }).events;
      assert.deepEqual(channel.map((event) => event.event),
        ["CHAN_START", "HISTORY_ENTRY", "ANSWER", "HISTORY_QUEUE_VISIT", "APP_START", "APP_END", "HANGUP", "CHAN_END"]);
      const queued = reader.queue.read({ customer, source, generation });
      assert.equal(queued.nextAfterOffset, null);
      assert.deepEqual(Buffer.from(queued.events.map((event) => event.rawRecord).join("")), queue);
      const entered = queued.events.filter((event) => event.event === "ENTERQUEUE");
      assert.equal(entered.length, 1);
      assert.equal(entered[0].callId, entry.uniqueid);
      assert.equal(entered[0].queue, visit.payload.queue);
      const queueAssignment = reader.manifests.resolve(customer, "queue", source, generation, entered[0].offset);
      assert.equal(queueAssignment.assignment?.runtime, entry.assignment?.runtime);
      assert.equal(queueAssignment.assignment?.epoch, entry.assignment?.epoch);
      assert.throws(() => reader.manifests.resolve(customer === "customer-a" ? "customer-b" : "customer-a",
        "cel", source, generation, expectedOffset), /not found/);
      const observed = JSON.parse(await cli(["marker", database, customer, source, generation, String(expectedOffset)],
        "Manage-HistoryManifest.ts"));
      assert.equal(observed.markerStatus, "validated-marker");
      evidence.push({ customer, source, generation, runtime: entry.assignment?.runtime, epoch: entry.assignment?.epoch,
        manifestId: entry.assignment?.manifestId, manifestSha256: entry.assignment?.manifestSha256,
        journeyId: entry.payload.journeyId, visitId: visit.payload.visitId,
        uniqueid: entry.uniqueid, entryOffset: expectedOffset, visitOffset,
        entryBeforeAnswer: true, visitBeforeQueueInvocation: "caller-channel CEL HISTORY_QUEUE_VISIT precedes APP_START; fixed Queue-only tracking",
        callerChannelEvents: channel.map((event) => event.event),
        entryStatus: entry.markerStatus, visitStatus: visit.markerStatus,
        queueCallId: entered[0].callId, queueEvents: queued.events.map((event) => event.event),
        celBytes: cel.length, queueBytes: queue.length,
        celRecords: reader.read({ customer, source, generation, limit: 200 }).events.length,
        queueRecords: queued.events.length, exactRawRoundTrip: true,
        replayInserted: 0, foreignResolveDenied: true });
      console.log(`PASS ${customer}: explicit runtime/epoch assignment; validated synthetic entry/visit markers; exact CEL/queue replay`);
    } finally { reader.close(); }
  }
}
