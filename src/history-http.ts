import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAccessVerifier } from "./access.ts";
import type { ApplicationSessionIdentity } from "./application-session.ts";
import type { AccessAudit } from "./diagnostic-api.ts";
import type { HistoryReader } from "./history-reader.ts";
import { HistoryProjectionNotFound } from "./history-projection-store.ts";

export async function handleHistoryRequest(
  request: IncomingMessage, response: ServerResponse, requestId: string, customer: string, path: string,
  currentSession: () => ApplicationSessionIdentity | undefined,
  verify: ReturnType<typeof createAccessVerifier>, audit: (event: AccessAudit) => Promise<void>,
  logError: (error: unknown, requestId: string) => void, reader?: HistoryReader,
) {
  const session = currentSession();
  const stillLive = () => {
    const live = currentSession();
    return session && live && live.sessionId === session.sessionId && live.customer === customer && live.subject === session.subject;
  };
  let membershipVerified = false;
  const record = (status: number, outcome: string) => audit({ requestId, timestamp: new Date().toISOString(),
    customer, subject: session?.subject, ...(membershipVerified ? { basis: "membership" as const } : {}),
    operation: "history-read", status, outcome });
  const deny = async (status: number, code: string) => {
    await record(status, code); request.resume();
    if (status === 401) response.setHeader("WWW-Authenticate", 'Session realm="history"');
    response.writeHead(status).end(JSON.stringify({ code, requestId }));
  };
  if (!session) { await deny(401, "application_session_required"); return; }
  if (session.customer !== customer) { await deny(403, "customer_access_denied"); return; }
  const access = await verify(request.headers.authorization, customer, "history:read");
  if (!stillLive()) { await deny(401, "application_session_required"); return; }
  if (!access.allowed) { await deny(access.status, access.code); return; }
  if (access.subject !== session.subject || access.basis !== "membership") { await deny(403, "customer_access_denied"); return; }
  membershipVerified = true;
  if (request.method !== "GET") { response.setHeader("Allow", "GET"); await deny(405, "method_not_allowed"); return; }
  if (!reader) { await deny(503, "history_workspace_disabled"); return; }
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const number = (key: string, fallback: string) => {
    const text = query.get(key) ?? fallback;
    return /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : -1;
  };
  const keys = [...query.keys()];
  const allowed = path === "scopes" ? ["after", "limit"] :
    path === "revisions" ? ["runtime", "epoch", "after", "limit"] : ["runtime", "epoch", "revision"];
  if (!["scopes", "revisions", "stored", "check"].includes(path)) { await deny(404, "history_route_not_found"); return; }
  const runtime = query.get("runtime") ?? "", epoch = query.get("epoch") ?? "";
  const after = number("after", "0"), limit = number("limit", "50");
  const rev = query.get("revision") ?? "latest";
  if (new Set(keys).size !== keys.length || keys.some((key) => !allowed.includes(key)) ||
      (path !== "scopes" && (![runtime, epoch].every((v) => /^[a-z0-9][a-z0-9._-]{0,95}$/.test(v)))) ||
      after < 0 || limit < 1 || limit > 200 || (rev !== "latest" && number("revision", "") < 1)) {
    await deny(400, "invalid_history_query"); return;
  }
  let result;
  try {
    const scope = { customer, runtime, epoch };
    result = path === "scopes" ? reader.scopes(customer, after, limit) :
      path === "revisions" ? reader.revisions(scope, after, limit) :
        reader.read(scope, rev === "latest" ? undefined : Number(rev), path === "check");
  } catch (error) {
    if (error instanceof HistoryProjectionNotFound) { await deny(404, "history_revision_not_found"); return; }
    logError(error, requestId); await deny(503, "history_read_unavailable"); return;
  }
  await record(200, `history_${path}_view_prepared`);
  if (!stillLive()) {
    response.writeHead(401).end(JSON.stringify({ code: "application_session_required", requestId })); return;
  }
  response.writeHead(200).end(JSON.stringify({ requestId, customer, result }));
}
