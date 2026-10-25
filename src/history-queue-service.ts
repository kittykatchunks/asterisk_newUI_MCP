import type { CelEvent } from "./cel-history.ts";
import type { QueueEvent } from "./queue-history.ts";
import type { EvidenceRef } from "./history-projection.ts";

export interface QueueServiceObservation {
  connection: "not-observed" | "observed" | "unresolved" | "conflicting";
  memberCorrelation: "not-observed" | "unresolved" | "answered-channel-observed" | "conflicting";
  memberUniqueid: string | null;
  memberChannelEnd: "not-observed" | "observed" | "conflicting";
  completion: "not-observed" | "member-ended-queue-service-observed" | "caller-ended-queue-service-observed" | "unresolved" | "conflicting";
  queueEvidence: EvidenceRef[];
  memberEvidence: EvidenceRef[];
}
interface QueueObservation { ref: EvidenceRef; event: QueueEvent }
interface CelObservation { ref: EvidenceRef; event: CelEvent }
const sameStream = (a: EvidenceRef, b: EvidenceRef) => a.source === b.source && a.generation === b.generation;
const unsigned = (value: string) => /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
const identity = (value: string) => value.trim().length > 0 && value.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(value) && value !== "NONE" && value !== "REALTIME";
export function emptyQueueService(): QueueServiceObservation {
  return { connection: "not-observed", memberCorrelation: "not-observed", memberUniqueid: null,
    memberChannelEnd: "not-observed", completion: "not-observed", queueEvidence: [], memberEvidence: [] };
}
export function observeQueueService(
  enter: QueueObservation, rest: QueueObservation[], cel: CelObservation[], allQueue: QueueObservation[],
  markedRootChannels: Set<string>, caller: EvidenceRef,
): { service: QueueServiceObservation; issues: { reason: string; evidence: EvidenceRef[] }[]; consumed: EvidenceRef[] } {
  const service = emptyQueueService();
  const issues: { reason: string; evidence: EvidenceRef[] }[] = [];
  const consumed: EvidenceRef[] = [];
  const connects = rest.filter((q) => q.event.event === "CONNECT");
  const report = (reason: string, evidence: EvidenceRef[]) => issues.push({ reason, evidence });
  service.queueEvidence = rest.map((q) => q.ref);
  if (connects.length !== 1) {
    service.connection = connects.length > 1 ? "conflicting" : "unresolved";
    report("missing-or-conflicting-queue-connect", rest.map((q) => q.ref));
    return { service, issues, consumed };
  }
  const connect = connects[0];
  const p = connect.event.parameters;
  if (!sameStream(enter.ref, connect.ref) || connect.ref.offset <= enter.ref.offset ||
      !identity(connect.event.member) ||
      p.length !== 3 || !unsigned(p[0]) || !identity(p[1]) || !unsigned(p[2])) {
    service.connection = "unresolved"; report("invalid-or-unordered-queue-connect", [connect.ref]);
    return { service, issues, consumed };
  }
  service.connection = "observed";
  service.memberCorrelation = "unresolved";
  service.memberUniqueid = p[1];
  consumed.push(connect.ref);
  const terminals = rest.filter((q) => q !== connect);
  if (terminals.length > 1) {
    service.completion = "conflicting"; report("conflicting-service-terminals", terminals.map((q) => q.ref));
  } else if (terminals.length === 1) {
    const end = terminals[0];
    if ((end.event.event === "COMPLETEAGENT" || end.event.event === "COMPLETECALLER") && sameStream(connect.ref, end.ref) &&
        end.ref.offset > connect.ref.offset && end.event.member === connect.event.member &&
        end.event.parameters.length === 3 && end.event.parameters.every(unsigned) &&
        Number(end.event.parameters[2]) > 0) {
      service.completion = end.event.event === "COMPLETEAGENT" ?
        "member-ended-queue-service-observed" : "caller-ended-queue-service-observed";
      consumed.push(end.ref);
    } else {
      service.completion = "unresolved"; report("unsupported-or-contradictory-service-terminal", [end.ref]);
    }
  }
  const member = cel.filter((c) => c.event.uniqueid === p[1]);
  service.memberEvidence = member.map((c) => c.ref);
  const competing = allQueue.filter((q) => q.event.event === "CONNECT" && q.event.parameters[1] === p[1]);
  const streams = new Set(member.map((c) => JSON.stringify([c.ref.source, c.ref.generation])));
  const starts = member.filter((c) => c.event.event === "CHAN_START");
  const answers = member.filter((c) => c.event.event === "ANSWER");
  const ends = member.filter((c) => c.event.event === "CHAN_END");
  if (markedRootChannels.has(p[1]) || p[1] === enter.event.callId || competing.length !== 1 ||
      streams.size > 1 || starts.length > 1 || answers.length > 1 || ends.length > 1 ||
      new Set(member.map((c) => c.event.channel)).size > 1) {
    service.memberCorrelation = "conflicting";
    report("conflicting-member-channel-identity", [...service.memberEvidence, ...competing.map((q) => q.ref)]);
  } else if (member.some((c) => !sameStream(c.ref, caller))) {
    report("member-channel-not-in-caller-stream", service.memberEvidence);
  } else if (starts.length === 1 && answers.length === 1 && starts[0].ref.offset < answers[0].ref.offset &&
      (ends.length === 0 || ends[0].ref.offset > answers[0].ref.offset)) {
    service.memberCorrelation = "answered-channel-observed";
    service.memberChannelEnd = ends.length === 1 ? "observed" : "not-observed";
  } else {
    if (ends.some((end) => answers.some((answer) => end.ref.offset < answer.ref.offset)) ||
        answers.some((answer) => starts.some((start) => answer.ref.offset < start.ref.offset))) {
      service.memberCorrelation = "conflicting";
    }
    report("missing-or-contradictory-member-answer", service.memberEvidence);
  }
  if (ends.length > 1) service.memberChannelEnd = "conflicting";
  return { service, issues, consumed };
}
