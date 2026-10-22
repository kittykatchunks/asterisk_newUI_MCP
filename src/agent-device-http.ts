import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAccessVerifier } from "./access.ts";
import type { ApplicationSessionIdentity } from "./application-session.ts";
import { assertAgentProfile } from "./agent-directory.ts";
import type { AgentDirectory } from "./agent-directory.ts";
import { AgentDeviceLeaseError } from "./agent-device-lease.ts";
import type { AgentDeviceLeaseStore } from "./agent-device-lease.ts";
import type { AccessAudit } from "./diagnostic-api.ts";
import { HttpInputError, readJsonBody } from "./http-json.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handleAgentDeviceRequest(
  request: IncomingMessage, response: ServerResponse, requestId: string,
  customer: string, action: "acquire" | "renew" | "release", issuer: string,
  currentSession: () => ApplicationSessionIdentity | undefined,
  verify: ReturnType<typeof createAccessVerifier>,
  audit: (event: AccessAudit) => Promise<void>,
  agents?: AgentDirectory, leases?: AgentDeviceLeaseStore,
) {
  const operation = `agent-device-${action}` as const;
  let subject: string | undefined;
  let intentRecorded = false;
  const record = (status: number, outcome: string) => audit({
    requestId, timestamp: new Date().toISOString(), customer, subject, operation, status, outcome,
  });
  const send = async (status: number, code: string) => {
    // The audit store permits one record per request; a recorded intent is not a result receipt.
    if (!intentRecorded) await record(status, code);
    if (status === 401) response.setHeader("WWW-Authenticate", 'Session realm="agent"');
    request.resume();
    response.writeHead(status).end(JSON.stringify({ requestId, code }));
  };
  const session = currentSession();
  if (!session) { await send(401, "application_session_required"); return; }
  subject = session.subject;
  if (session.customer !== customer) { await send(403, "customer_access_denied"); return; }
  const access = await verify(request.headers.authorization, customer, "agent:access");
  if (!access.allowed) { await send(access.status, access.code); return; }
  if (access.subject !== session.subject) throw new Error("Device lease session identity mismatch");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    await send(405, "method_not_allowed"); return;
  }
  if (!agents) { await send(503, "agent_directory_unavailable"); return; }
  if (!leases) { await send(503, "agent_device_leases_unavailable"); return; }
  const profile = agents.profile(issuer, session.subject, customer);
  if (!profile) { await send(404, "agent_not_assigned"); return; }
  assertAgentProfile(profile);
  let deviceId: string;
  let leaseId: string | undefined;
  try {
    const value = await readJsonBody(request, "device_lease", 1024);
    const keys = action === "acquire" ? ["deviceId"] : ["deviceId", "leaseId"];
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        !("deviceId" in value) || typeof value.deviceId !== "string" || !uuid.test(value.deviceId) ||
        (action !== "acquire" && (!("leaseId" in value) || typeof value.leaseId !== "string" || !uuid.test(value.leaseId)))) {
      throw new HttpInputError(400, "invalid_device_lease_input");
    }
    deviceId = value.deviceId;
    if ("leaseId" in value && typeof value.leaseId === "string") leaseId = value.leaseId;
  } catch (error) {
    if (!(error instanceof HttpInputError)) throw error;
    if (error.status === 408 || error.status === 413) response.setHeader("Connection", "close");
    await send(error.status, error.code); return;
  }
  await record(200, `agent_device_${action}_requested`);
  intentRecorded = true;
  // Body upload and audit can yield to logout/rotation; never mutate from a stale session.
  const live = currentSession();
  if (!live || live.sessionId !== session.sessionId || live.subject !== session.subject || live.customer !== customer) {
    await send(401, "application_session_required"); return;
  }
  const owner = { issuer, subject: live.subject, customer, deviceId,
    sessionId: live.sessionId, sessionExpiresAt: live.expiresAt };
  let lease;
  try {
    if (action === "acquire") lease = leases.acquire(owner);
    else {
      if (!leaseId) throw new Error("Validated device lease ID missing");
      if (action === "renew") lease = leases.renew(owner, leaseId);
      else leases.release(owner, leaseId);
    }
  } catch (error) {
    if (!(error instanceof AgentDeviceLeaseError)) throw error;
    await send(error.code === "device_session_expired" ? 401 : 409, error.code); return;
  }
  response.writeHead(200).end(JSON.stringify({ requestId, customer,
    ...(lease ? { lease: { id: lease.id, expiresAt: lease.expiresAt } } : { code: "agent_device_released" }) }));
}
