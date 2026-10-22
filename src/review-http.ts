import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAccessVerifier } from "./access.ts";
import type { AccessAudit } from "./diagnostic-api.ts";
import { ReviewConflict } from "./diagnostic-store.ts";
import type { DiagnosticStore, IncidentReview } from "./diagnostic-store.ts";

class ReviewInputError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readDecision(request: IncomingMessage): Promise<Pick<IncidentReview, "decision" | "reason" | "sha256">> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ReviewInputError(415, "review_json_required");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new ReviewInputError(415, "review_encoding_unsupported");
  }
  const text = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
      if (error) { request.resume(); reject(error); }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) finish(new ReviewInputError(413, "review_body_too_large"));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = (error: Error) => finish(error);
    const aborted = () => finish(new ReviewInputError(400, "review_request_aborted"));
    const timer = setTimeout(() => finish(new ReviewInputError(408, "review_body_timeout")), 5000);
    request.on("data", data).once("end", end).once("error", fail).once("aborted", aborted);
  });
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new ReviewInputError(400, "invalid_review_json"); }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !["decision", "reason", "sha256"].includes(key)) ||
      !("decision" in value) || (value.decision !== "approve" && value.decision !== "reject") ||
      !("reason" in value) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000 ||
      !("sha256" in value) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new ReviewInputError(400, "invalid_review_decision");
  }
  return { decision: value.decision, reason: value.reason, sha256: value.sha256 };
}

export async function handleReviewRequest(
  request: IncomingMessage, response: ServerResponse, requestId: string,
  customer: string, candidate: string | undefined,
  verify: ReturnType<typeof createAccessVerifier>,
  audit: (event: AccessAudit) => Promise<void>,
  reviews?: Pick<DiagnosticStore, "pending" | "candidate" | "review">,
) {
  const send = (status: number, code: string, body?: unknown) => {
    if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="diagnostics"');
    response.writeHead(status).end(JSON.stringify(body ?? { code, requestId }));
  };
  const decision = request.method === "POST" && candidate !== undefined;
  const operation = decision ? "review-decision" : candidate ? "review-candidate" : "review-list";
  const result = await verify(request.headers.authorization, customer, "diagnostics:review");
  const event: AccessAudit = {
    requestId, timestamp: new Date().toISOString(), customer, operation,
    outcome: result.allowed ? "review_access_allowed" : result.code, status: result.allowed ? 200 : result.status,
    ...(result.allowed ? { subject: result.subject, basis: result.basis } : {}),
  };
  const deny = async (status: number, code: string) => {
    await audit({ ...event, status, outcome: code });
    send(status, code);
  };
  if (!result.allowed) { await deny(result.status, result.code); request.resume(); return; }
  if (request.method !== "GET" && !decision) {
    response.setHeader("Allow", candidate ? "GET, POST" : "GET");
    await deny(405, "method_not_allowed"); request.resume(); return;
  }
  if (!reviews) { await deny(503, "incident_review_unavailable"); request.resume(); return; }
  if (!candidate) {
    const pending = reviews.pending(customer);
    await audit({ ...event, outcome: "review_candidates_listed" });
    send(200, "review_candidates_listed", { requestId, candidates: pending });
    return;
  }
  const staged = reviews.candidate(candidate);
  if (!staged || staged.entry.customer !== customer) {
    await deny(404, "review_candidate_not_found"); request.resume(); return;
  }
  event.incident = staged.entry.summary.id;
  if (!decision) {
    await audit({ ...event, outcome: "review_candidate_viewed" });
    response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
    send(200, "review_candidate_viewed", { requestId, candidate: { id: candidate, ...staged } });
    return;
  }
  try {
    const input = await readDecision(request);
    // The verified subject, never a request field, is the recorded reviewer.
    reviews.review(candidate, { ...input, reviewer: result.subject }, {
      ...event, outcome: `incident_review_${input.decision}`,
    });
    send(200, "incident_review_recorded");
  } catch (error) {
    if (error instanceof ReviewInputError || error instanceof ReviewConflict) {
      request.resume();
      if (error.status === 408 || error.status === 413) response.setHeader("Connection", "close");
      await deny(error.status, error.code);
      return;
    }
    throw error;
  }
}
