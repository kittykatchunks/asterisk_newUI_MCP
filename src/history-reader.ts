import { openCelHistory } from "./cel-history.ts";
import { distinctProjectionPaths, openHistoryProjections } from "./history-projection-store.ts";
import { buildHistoryProjection, type ProjectionScope } from "./history-projection.ts";
import { historyDigest, historyIdentifier, historyInteger } from "./history-evidence.ts";

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid history view object");
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error("Invalid history view array");
  return value;
}
function fields(value: unknown, keys: string[]) {
  const source = object(value);
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) {
    const v = source[key];
    if (!(v === null || typeof v === "boolean" || (typeof v === "string" && v.length <= 2048) ||
        (typeof v === "number" && Number.isSafeInteger(v)))) throw new Error("Invalid history view field");
    result[key] = v;
  }
  return result;
}
function refs(value: unknown) {
  return array(value).map((item) => {
    const ref = object(item);
    if (ref.kind !== "cel" && ref.kind !== "queue") throw new Error("Invalid evidence reference kind");
    historyIdentifier(ref.source); historyIdentifier(ref.generation);
    if (!historyInteger(ref.offset) || !historyDigest(ref.sha256)) throw new Error("Invalid evidence reference");
    return { kind: ref.kind, source: ref.source, generation: ref.generation, offset: ref.offset, sha256: ref.sha256 };
  });
}
function coverage(value: unknown) {
  return array(value).map((item) => {
    const c = object(item);
    const metadata = fields(c, ["kind", "source", "generation", "revision", "outcome", "staleAfterMs", "updatedAt",
      "attemptedAt", "succeededAt", "failure", "pendingBytes", "association"]);
    return { metadata,
      gaps: array(c.gaps).map((gap) => fields(gap, ["id", "kind", "source", "previousGeneration", "generation",
        "lastSuccessAt", "observedAt", "createdAt", "coverage"])) };
  });
}
export function historyObservationView(value: unknown) {
  const doc = object(value);
  return { quality: fields(doc.quality, ["completeness", "queueCoverage", "service", "attribution", "noMarkedRoots"]),
    input: fields(doc.input, ["queueCollectionCapability"]),
    coverage: coverage(object(doc.input).coverage),
    journeys: array(doc.journeys).map((item) => {
      const j = object(item);
      return { ...fields(j, ["id", "journeyId", "entryKind", "state"]), entryEvidence: refs(j.entryEvidence),
        channel: j.channel === null ? null : { ...fields(j.channel, ["uniqueid", "answer", "end"]),
          evidence: refs(object(j.channel).evidence) },
        visits: array(j.visits).map((item) => {
          const v = object(item);
          const result: Record<string, unknown> = { ...fields(v, ["id", "visitId", "queue", "state", "abandonment"]),
            markerEvidence: refs(v.markerEvidence), queueEvidence: refs(v.queueEvidence) };
          if (Object.hasOwn(v, "service")) {
            const service = object(v.service);
            result.service = { ...fields(service, ["connection", "memberCorrelation", "memberUniqueid", "memberChannelEnd", "completion"]),
              queueEvidence: refs(service.queueEvidence), memberEvidence: refs(service.memberEvidence) };
          }
          return result;
        }) };
    }),
    issues: array(doc.issues).map((item) => ({ ...fields(item, ["reason"]), evidence: refs(object(item).evidence) })) };
}
export function createHistoryReader(historyPath: string, projectionPath: string) {
  distinctProjectionPaths(historyPath, projectionPath);
  const probe = openHistoryProjections(projectionPath, { readOnly: true });
  probe.close();
  const use = <T>(action: (store: ReturnType<typeof openHistoryProjections>) => T) => {
    const store = openHistoryProjections(projectionPath, { readOnly: true });
    try { return action(store); } finally { store.close(); }
  };
  return {
    scopes(customer: string, after: number, limit: number) { return use((s) => s.scopes(customer, after, limit)); },
    revisions(scope: ProjectionScope, after: number, limit: number) {
      return use((s) => s.revisions(scope, after, limit));
    },
    read(scope: ProjectionScope, id: number | undefined, check: boolean) {
      return use((s) => {
        const revision = s.read(scope, id);
        const { document, ...metadata } = revision;
        const result = { ...metadata, observation: historyObservationView(document) };
        if (!check) return { ...result, freshness: { state: "not-checked" as const,
          meaning: "Stored revision only; raw history was not opened" } };
        const history = openCelHistory(historyPath, { readOnly: true });
        try {
          const current = buildHistoryProjection(history, scope);
          const checkedAt = Date.now();
          const collectorHealth = history.readSnapshot(() => current.document.input.coverage.map((c) => {
            const status = c.kind === "cel" ? history.collectorStatus(scope.customer, c.source, checkedAt) :
              history.queue.collectors.status(scope.customer, c.source, checkedAt);
            return { kind: c.kind, source: c.source, status: status.status, revision: status.revision, ageMs: status.ageMs,
              coverage: status.coverage };
          }));
          return { ...result, freshness: { state: revision.inputSha256 === current.inputSha256 ? "inputs-match" : "inputs-changed",
            checkedAt: new Date(checkedAt).toISOString(), currentInputSha256: current.inputSha256,
            meaning: "Local committed inputs only; not remote PBX freshness or completeness" },
            currentCoverage: coverage(current.document.input.coverage), currentQuality: current.document.quality,
            currentQueueCollectionCapability: current.document.input.queueCollectionCapability, collectorHealth };
        } finally { history.close(); }
      });
    },
  };
}
export type HistoryReader = ReturnType<typeof createHistoryReader>;
