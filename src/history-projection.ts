import { createHash } from "node:crypto";
import type { openCelHistory, CelEvent } from "./cel-history.ts";
import type { QueueEvent } from "./queue-history.ts";
import { inspectHistoryMarker } from "./history-markers.ts";
import { historyIdentifier as identifier, historySha256 as sha256 } from "./history-evidence.ts";
import { emptyQueueService, observeQueueService, type QueueServiceObservation } from "./history-queue-service.ts";

export const PROJECTION_ALGORITHM = "marked-caller-v4";
export const PROJECTION_DOCUMENT_LIMIT = 8 * 1024 * 1024;
export interface ProjectionScope { customer: string; runtime: string; epoch: string }
export interface EvidenceRef {
  kind: "cel" | "queue"; source: string; generation: string; offset: number; sha256: string;
}
interface CelObservation { ref: EvidenceRef; event: CelEvent }
interface QueueObservation { ref: EvidenceRef; event: QueueEvent }
interface Marker {
  ref: EvidenceRef; channel: string; journeyId: string; routeRevision: string;
  kind: "entry" | "visit"; entryKind?: string; visitId?: string; queue?: string;
}
export interface ProjectionIssue { reason: string; evidence: EvidenceRef[] }
export interface ProjectedVisit {
  id: string; visitId: string; queue: string; markerEvidence: EvidenceRef[];
  state: "unresolved" | "conflicting" | "entry-observed" | "timeout-observed" | "connection-observed" | "completion-observed";
  queueEvidence: EvidenceRef[];
  service: QueueServiceObservation;
}
export interface ProjectedJourney {
  id: string; journeyId: string; entryKind: string;
  state: "marked-caller-observed" | "conflicting";
  entryEvidence: EvidenceRef[];
  channel: { uniqueid: string; evidence: EvidenceRef[]; answer: "observed" | "not-observed" | "conflicting";
    end: "observed" | "not-observed" | "conflicting" } | null;
  visits: ProjectedVisit[];
}
export function projectionScope(scope: ProjectionScope) {
  identifier(scope.customer); identifier(scope.runtime); identifier(scope.epoch);
}
const key = (value: unknown) => JSON.stringify(value);
const stableId = (scope: ProjectionScope, kind: string, id: string) =>
  sha256(Buffer.from(key(["history-entity-v1", scope.customer, scope.runtime, scope.epoch, kind, id])));
const refKey = (ref: EvidenceRef) => key([ref.kind, ref.source, ref.generation, ref.offset]);
const stream = (ref: EvidenceRef) => key([ref.source, ref.generation]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function group<T>(items: T[], identity: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = identity(item);
    const list = result.get(id) ?? [];
    list.push(item); result.set(id, list);
  }
  return result;
}
export function buildHistoryProjection(store: ReturnType<typeof openCelHistory>, scope: ProjectionScope) {
  projectionScope(scope);
  scope = { customer: scope.customer, runtime: scope.runtime, epoch: scope.epoch };
  return store.readSnapshot(() => {
    const manifests = store.manifests.list(scope.customer, 0, 200);
    if (manifests.nextAfterId !== null) throw new Error("Projection manifest limit exceeded (200)");
    const selected = manifests.manifests.filter((m) => m.runtime === scope.runtime && m.epoch === scope.epoch);
    if (selected.length === 0) throw new Error("Projection runtime/epoch manifest scope not found");
    if (selected.reduce((total, m) => total + m.ranges.length, 0) > 100) throw new Error("Projection selected range limit exceeded (100)");
    const ranges = manifests.manifests.flatMap((m) => m.ranges.map((range) => ({ manifest: m, range })));
    for (const m of selected) for (const range of m.ranges) {
      const resolved = store.manifests.resolve(scope.customer, range.kind, range.source, range.generation, range.start);
      if (resolved.assignment?.manifestId !== m.id) throw new Error("Projection manifest assignment is inconsistent");
    }
    const issues: ProjectionIssue[] = [];
    let outputReferences = 0;
    function references(refs: EvidenceRef[]) {
      outputReferences += refs.length;
      if (outputReferences > 20000) throw new Error("Projection output reference limit exceeded (20000)");
      return refs;
    }
    const issue = (reason: string, refs: EvidenceRef[]) => issues.push({ reason, evidence: references(refs) });
    const cel: CelObservation[] = [];
    const queue: QueueObservation[] = [];
    const checkpoints: { kind: "cel" | "queue"; source: string; generation: string;
      timeBasis: string; consumedBytes: number; prefixSha256: string; records: number }[] = [];
    const markers: Marker[] = [];
    let recordCount = 0;
    let bytes = 0;
    function selectedRecord(ref: EvidenceRef) {
      const matches = ranges.filter(({ range }) => range.kind === ref.kind && range.source === ref.source &&
        range.generation === ref.generation && range.start <= ref.offset && range.end > ref.offset);
      if (matches.length > 1) throw new Error("Projection contains overlapping manifest ranges");
      if (matches.length === 0) { issue("unassigned-evidence", [ref]); return false; }
      return matches[0].manifest.runtime === scope.runtime && matches[0].manifest.epoch === scope.epoch;
    }
    for (const kind of ["cel", "queue"] as const) {
      const sources = kind === "cel" ? store.sources(scope.customer, undefined, 20) :
        store.queue.sources(scope.customer, undefined, 20);
      if (sources.next !== null) throw new Error("Projection source limit exceeded (20 per kind)");
      for (const source of sources.sources) {
        checkpoints.push({ kind, source: source.source, generation: source.generation,
          timeBasis: source.timeBasis, consumedBytes: source.consumedBytes,
          prefixSha256: source.prefixSha256, records: source.records });
        const hash = createHash("sha256");
        let afterOffset = -1;
        let count = 0;
        let consumed = 0;
        do {
          const query = { customer: scope.customer, source: source.source, generation: source.generation, afterOffset, limit: 200 };
          const page = kind === "cel" ? store.read(query) : store.queue.read(query);
          for (const event of page.events) {
            recordCount++; count++; bytes += Buffer.byteLength(event.rawRecord);
            if (recordCount > 2000 || bytes > PROJECTION_DOCUMENT_LIMIT) throw new Error("Projection input limit exceeded (2000 records / 8 MiB)");
            if (event.offset !== consumed) throw new Error("Projection source has noncontiguous evidence");
            consumed = event.endOffset; hash.update(event.rawRecord);
            const ref: EvidenceRef = { kind, source: source.source, generation: source.generation,
              offset: event.offset, sha256: event.sha256 };
            if (!selectedRecord(ref)) continue;
            if ("uniqueid" in event) {
              cel.push({ ref, event });
              if (["HISTORY_ENTRY", "HISTORY_QUEUE_VISIT"].includes(event.event)) {
                const observed = inspectHistoryMarker(store, scope.customer, source.source, source.generation, event.offset);
                if (observed.markerStatus !== "validated-marker" || !("payload" in observed) || !observed.payload) {
                  issue(`marker-${observed.markerStatus}`, [ref]); continue;
                }
                const p = observed.payload;
                if (typeof p.journeyId !== "string" || typeof p.routeRevision !== "string") throw new Error("Invalid inspected marker");
                if (event.event === "HISTORY_ENTRY" && typeof p.entryKind === "string") {
                  markers.push({ kind: "entry", ref, channel: event.uniqueid, journeyId: p.journeyId,
                    routeRevision: p.routeRevision, entryKind: p.entryKind });
                } else if (typeof p.visitId === "string" && typeof p.queue === "string") {
                  markers.push({ kind: "visit", ref, channel: event.uniqueid, journeyId: p.journeyId,
                    routeRevision: p.routeRevision, visitId: p.visitId, queue: p.queue });
                } else throw new Error("Invalid inspected marker payload");
              }
            } else queue.push({ ref, event });
          }
          if (page.nextAfterOffset === null) break;
          afterOffset = page.nextAfterOffset;
        } while (true);
        if (count !== source.records || consumed !== source.consumedBytes || hash.digest("hex") !== source.prefixSha256) {
          throw new Error("Projection source checkpoint does not match raw evidence");
        }
      }
    }
    const collectorSources = [
      ...store.collectorSources(scope.customer).map((source) => ({ kind: "cel" as const, source })),
      ...(store.queue.collectors.supported ? store.queue.collectors.sources(scope.customer)
        .map((source) => ({ kind: "queue" as const, source })) : []),
    ];
    const coverage = collectorSources.map(({ kind, source }) => {
      const status = kind === "cel" ? store.collectorStatus(scope.customer, source) : store.queue.collectors.status(scope.customer, source);
      const gaps = kind === "cel" ? store.collectionGaps(scope.customer, source, 0, 200) :
        store.queue.collectors.gaps(scope.customer, source, 0, 200);
      if (gaps.nextAfterId !== null) throw new Error("Projection gap limit exceeded (200 per source)");
      const associated = selected.some((m) => m.ranges.some((r) => r.kind === kind && r.source === source));
      return { kind, source, generation: status.generation, revision: status.revision, outcome: status.outcome,
        staleAfterMs: status.staleAfterMs, updatedAt: status.updatedAt, attemptedAt: status.attemptedAt,
        succeededAt: status.succeededAt, failure: status.failure, pendingBytes: status.pendingBytes,
        association: associated ? "possibly-applicable" : "association-unknown",
        gaps: gaps.gaps };
    });
    const input = { algorithm: PROJECTION_ALGORITHM, scope, checkpoints,
      manifests: manifests.manifests.map((m) => ({ id: m.id, sha256: m.sha256 })), coverage,
      queueCollectionCapability: store.queue.collectors.supported ? "available" : "unavailable-legacy-schema" };
    const usedCel = new Set<string>();
    const usedQueue = new Set<string>();
    const entries = markers.filter((m) => m.kind === "entry");
    const roots = group(entries, (m) => m.journeyId);
    const rootChannels = group(entries, (m) => m.channel);
    const journeys: ProjectedJourney[] = [];
    for (const [journeyId, candidates] of roots) {
      const first = candidates[0];
      const unique = new Set(candidates.map((m) => key([stream(m.ref), m.channel, m.entryKind, m.routeRevision])));
      const channels = cel.filter((c) => c.event.uniqueid === first.channel);
      const channelStreams = new Set(channels.map((c) => stream(c.ref)));
      const conflicting = unique.size !== 1 || channelStreams.size !== 1 ||
        new Set(rootChannels.get(first.channel)!.map((m) => m.journeyId)).size !== 1;
      const journey: ProjectedJourney = { id: stableId(scope, "journey", journeyId), journeyId,
        entryKind: unique.size === 1 ? first.entryKind! : "conflicting",
        state: conflicting ? "conflicting" : "marked-caller-observed",
        entryEvidence: references(candidates.map((m) => m.ref)), channel: null, visits: [] };
      journeys.push(journey);
      for (const m of candidates) usedCel.add(refKey(m.ref));
      if (conflicting) { issue("conflicting-root-or-channel-identity", journey.entryEvidence); continue; }
      const channel = channels.filter((c) => stream(c.ref) === stream(first.ref));
      const facts = (name: string) => {
        const count = channel.filter((c) => c.event.event === name).length;
        return count === 0 ? "not-observed" as const : count === 1 ? "observed" as const : "conflicting" as const;
      };
      journey.channel = { uniqueid: first.channel, evidence: references(channel.map((c) => c.ref)),
        answer: facts("ANSWER"), end: facts("CHAN_END") };
      for (const c of channel) usedCel.add(refKey(c.ref));
      for (const c of channel) if (!["CHAN_START", "HISTORY_ENTRY", "ANSWER", "HISTORY_QUEUE_VISIT",
        "APP_START", "APP_END", "HANGUP", "CHAN_END", "LINKEDID_END"].includes(c.event.event)) {
        issue("unsupported-caller-cel-evidence", [c.ref]);
      }
      const starts = channel.filter((c) => c.event.event === "CHAN_START");
      const ends = channel.filter((c) => c.event.event === "CHAN_END");
      if (starts.length !== 1 || ends.length !== 1) issue("partial-or-conflicting-caller-lifecycle", journey.channel.evidence);
      if (starts.length > 1 || (starts.length === 1 && starts[0].ref.offset > first.ref.offset) ||
          ends.some((c) => candidates.some((m) => c.ref.offset < m.ref.offset)) || journey.channel.answer === "conflicting" ||
          journey.channel.end === "conflicting" || channel.some((c) => c.event.event === "ANSWER" &&
            (c.ref.offset < first.ref.offset || ends.some((end) => end.ref.offset < c.ref.offset)))) {
        journey.state = "conflicting"; issue("contradictory-caller-lifecycle", journey.channel.evidence);
      }
    }
    const allVisits = markers.filter((m) => m.kind === "visit");
    for (const [visitId, candidates] of group(allVisits, (m) => m.visitId!)) {
      const first = candidates[0];
      const journey = journeys.find((j) => j.journeyId === first.journeyId);
      const signature = new Set(candidates.map((m) => key([m.journeyId, m.channel, stream(m.ref), m.queue, m.routeRevision])));
      const root = roots.get(first.journeyId)?.[0];
      if (!journey || !root || journey.state === "conflicting" || first.channel !== root.channel ||
          stream(first.ref) !== stream(root.ref) || first.ref.offset <= root.ref.offset ||
          first.routeRevision !== root.routeRevision ||
          candidates.some((m) => m.ref.offset <= root.ref.offset || cel.some((c) =>
            c.event.uniqueid === root.channel && stream(c.ref) === stream(root.ref) &&
            c.event.event === "CHAN_END" && c.ref.offset < m.ref.offset))) {
        issue("unresolved-visit-root", candidates.map((m) => m.ref)); continue;
      }
      const visit: ProjectedVisit = { id: stableId(scope, "visit", visitId), visitId, queue: first.queue!,
        markerEvidence: references(candidates.map((m) => m.ref)), state: signature.size === 1 ? "unresolved" : "conflicting",
        queueEvidence: [], service: emptyQueueService() };
      journey.visits.push(visit);
      if (signature.size !== 1) { issue("conflicting-visit-marker", visit.markerEvidence); continue; }
      const rivals = new Set(allVisits.filter((m) => m.channel === first.channel && m.queue === first.queue).map((m) => m.visitId));
      const matches = queue.filter((q) => q.event.callId === first.channel && q.event.queue === first.queue);
      const enters = matches.filter((q) => q.event.event === "ENTERQUEUE");
      visit.queueEvidence = references(matches.map((q) => q.ref));
      if (rivals.size !== 1 || enters.length !== 1) { issue("ambiguous-or-missing-queue-entry", visit.queueEvidence); continue; }
      const enter = enters[0];
      if (enter.event.member !== "NONE" || enter.event.parameters.length !== 3 ||
          !/^[1-9][0-9]*$/.test(enter.event.parameters[2])) {
        issue("unsupported-queue-entry-shape", [enter.ref]); continue;
      }
      visit.state = "entry-observed";
      usedQueue.add(refKey(enter.ref));
      const rest = matches.filter((q) => q !== enter);
      if (rest.some((q) => q.event.event === "CONNECT" || q.event.event.startsWith("COMPLETE"))) {
        const observed = observeQueueService(enter, rest, cel, queue, new Set(entries.map((m) => m.channel)), root.ref);
        visit.service = observed.service;
        references(visit.service.queueEvidence); references(visit.service.memberEvidence);
        for (const problem of observed.issues) issue(problem.reason, problem.evidence);
        for (const ref of observed.consumed) usedQueue.add(refKey(ref));
        if (visit.service.memberCorrelation === "answered-channel-observed") {
          for (const ref of visit.service.memberEvidence) usedCel.add(refKey(ref));
        }
        visit.state = visit.service.connection === "observed" ? "connection-observed" : "unresolved";
        if (visit.service.completion === "member-ended-queue-service-observed" ||
            visit.service.completion === "caller-ended-queue-service-observed") visit.state = "completion-observed";
        if (visit.service.connection === "conflicting" || visit.service.memberCorrelation === "conflicting" ||
            visit.service.completion === "conflicting") visit.state = "conflicting";
        continue;
      }
      if (rest.length > 1 && rest.every((q) => q.event.event === "EXITWITHTIMEOUT")) {
        visit.state = "conflicting"; issue("conflicting-queue-terminals", rest.map((q) => q.ref)); continue;
      }
      const terminal = rest[0];
      if (rest.length === 1 && terminal.event.event === "EXITWITHTIMEOUT" &&
          stream(terminal.ref) === stream(enter.ref) && terminal.ref.offset > enter.ref.offset &&
          terminal.event.member === "NONE" && terminal.event.parameters.length === 3 &&
          terminal.event.parameters.every((p) => /^(?:0|[1-9][0-9]*)$/.test(p))) {
        visit.state = "timeout-observed"; usedQueue.add(refKey(terminal.ref));
      } else if (rest.length > 0) {
        visit.state = "unresolved"; issue("unsupported-or-ambiguous-queue-evidence", rest.map((q) => q.ref));
      }
    }
    for (const c of cel) if (!usedCel.has(refKey(c.ref))) issue("unattributed-cel-evidence", [c.ref]);
    for (const q of queue) if (!usedQueue.has(refKey(q.ref))) {
      issue(q.event.event === "QUEUESTART" && q.event.callId === "NONE" ?
        "administrative-queue-evidence" : "unattributed-queue-evidence", [q.ref]);
    }
    journeys.sort((a, b) => compare(a.id, b.id));
    for (const journey of journeys) journey.visits.sort((a, b) => compare(a.id, b.id));
    issues.sort((a, b) => compare(key(a), key(b)));
    const document = { algorithm: PROJECTION_ALGORITHM, scope, input,
      quality: { completeness: "unverified", queueCoverage: !store.queue.collectors.supported ? "unavailable-legacy-schema" :
        coverage.some((c) => c.kind === "queue") ? "unverified" : "not-collected", service: "not-classified",
        attribution: "explicit-marked-caller-only", noMarkedRoots: journeys.length === 0 },
      journeys, issues };
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > PROJECTION_DOCUMENT_LIMIT) throw new Error("Projection document exceeds 8 MiB");
    return { document, inputSha256: sha256(Buffer.from(JSON.stringify(input))),
      sha256: sha256(Buffer.from(serialized)) };
  });
}
export type HistoryProjection = ReturnType<typeof buildHistoryProjection>;
