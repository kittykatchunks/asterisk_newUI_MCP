import type { openCelHistory } from "./cel-history.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function inspectHistoryMarker(
  store: ReturnType<typeof openCelHistory>, customer: string, source: string, generation: string, offset: number,
) {
  const resolved = store.manifests.resolve(customer, "cel", source, generation, offset);
  const event = store.read({ customer, source, generation, afterOffset: offset - 1, limit: 1 }).events[0];
  if (!event || event.offset !== offset) throw new Error("Marker evidence not found");
  const base = { ...resolved, event: event.event, uniqueid: event.uniqueid, rawSha256: event.sha256 };
  if (!["HISTORY_ENTRY", "HISTORY_QUEUE_VISIT"].includes(event.event)) return { ...base, markerStatus: "not-marker" };
  if (!resolved.assignment) return { ...base, markerStatus: "unassigned" };
  const route = resolved.assignment.routes.find((route) => route.context === event.context && route.extension === event.extension);
  if (!route) return { ...base, markerStatus: "untrusted-route" };
  let outer: unknown;
  let payload: unknown;
  try {
    outer = JSON.parse(event.extra);
    if (!object(outer) || typeof outer.extra !== "string") return { ...base, markerStatus: "invalid-marker" };
    payload = JSON.parse(outer.extra);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ...base, markerStatus: "invalid-marker" };
  }
  if (!object(payload)) return { ...base, markerStatus: "invalid-marker" };
  const expected = event.event === "HISTORY_ENTRY" ?
    ["v", "journeyId", "entryKind", "routeRevision"] : ["v", "journeyId", "visitId", "queue", "routeRevision"];
  if (Object.keys(payload).sort().join(",") !== expected.sort().join(",") ||
      payload.v !== 1 || typeof payload.journeyId !== "string" || !uuid.test(payload.journeyId) ||
      payload.routeRevision !== route.routeRevision ||
      (event.event === "HISTORY_ENTRY" ? payload.entryKind !== route.entryKind :
        typeof payload.visitId !== "string" || !uuid.test(payload.visitId) || payload.visitId === payload.journeyId ||
        typeof payload.queue !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(payload.queue))) {
    return { ...base, markerStatus: "invalid-marker" };
  }
  return { ...base, markerStatus: "validated-marker", payload };
}
