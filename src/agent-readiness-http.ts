import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAccessVerifier } from "./access.ts";
import type { ApplicationSessionIdentity } from "./application-session.ts";
import type { AccessAudit } from "./diagnostic-api.ts";
import { assertAgentProfile } from "./agent-directory.ts";
import type { AgentDirectory } from "./agent-directory.ts";
import type { PbxEndpointSource } from "./pbx-status.ts";

export async function handleAgentReadinessRequest(
  request: IncomingMessage, response: ServerResponse, requestId: string, customer: string,
  issuer: string, currentSession: () => ApplicationSessionIdentity | undefined,
  verify: ReturnType<typeof createAccessVerifier>,
  audit: (event: AccessAudit) => Promise<void>,
  logError: (error: unknown, requestId: string) => void,
  agents?: AgentDirectory, endpoints?: PbxEndpointSource,
) {
  const session = currentSession();
  const subject = session?.subject;
  const record = (status: number, outcome: string) => audit({
    requestId, timestamp: new Date().toISOString(), customer, subject, operation: "agent-readiness",
    status, outcome,
  });
  const deny = async (status: number, code: string) => {
    await record(status, code);
    request.resume();
    if (status === 401) response.setHeader("WWW-Authenticate", 'Session realm="agent"');
    response.writeHead(status).end(JSON.stringify({ requestId, code }));
  };
  if (!session) { await deny(401, "application_session_required"); return; }
  if (session.customer !== customer) { await deny(403, "customer_access_denied"); return; }
  const access = await verify(request.headers.authorization, customer, "agent:access");
  if (!access.allowed) { await deny(access.status, access.code); return; }
  if (access.subject !== session.subject || access.basis !== "membership") {
    await deny(403, "customer_access_denied"); return;
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    await deny(405, "method_not_allowed"); return;
  }
  if (!agents) { await deny(503, "agent_directory_unavailable"); return; }
  if (!endpoints) { await deny(503, "agent_readiness_unavailable"); return; }

  let profile;
  try {
    profile = agents.profile(issuer, session.subject, customer);
    if (profile) assertAgentProfile(profile);
  } catch (error) {
    logError(error, requestId);
    await deny(503, "agent_directory_unavailable"); return;
  }
  if (!profile) { await deny(404, "agent_not_assigned"); return; }
  const extension = profile.extension;

  let snapshot;
  try {
    snapshot = await endpoints.endpoints(customer);
    if (snapshot.customer !== customer || !Number.isFinite(Date.parse(snapshot.checkedAt)) ||
        new Date(snapshot.checkedAt).toISOString() !== snapshot.checkedAt ||
        !Array.isArray(snapshot.endpoints) || snapshot.endpoints.length > 200 ||
        !snapshot.endpoints.every((endpoint) => typeof endpoint.id === "string" &&
          !!endpoint.id.trim() && endpoint.id.length <= 128 && !/[\x00-\x1f\x7f]/.test(endpoint.id) &&
          typeof endpoint.deviceState === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(endpoint.deviceState) &&
          typeof endpoint.hasContacts === "boolean" &&
          Number.isSafeInteger(endpoint.activeChannels) && endpoint.activeChannels >= 0) ||
        new Set(snapshot.endpoints.map((endpoint) => endpoint.id)).size !== snapshot.endpoints.length) {
      throw new Error("Invalid PBX endpoint snapshot");
    }
  } catch (error) {
    logError(error, requestId);
    await deny(503, "agent_readiness_unavailable"); return;
  }

  const live = currentSession();
  if (!live || live.sessionId !== session.sessionId || live.subject !== session.subject ||
      live.customer !== customer) {
    await deny(401, "application_session_required"); return;
  }
  const endpoint = snapshot.endpoints.find((item) => item.id === extension);
  try {
    await record(200, endpoint ? "agent_readiness_checked" : "agent_endpoint_not_observed");
  } catch (error) {
    logError(error, requestId);
    request.resume();
    response.writeHead(503).end(JSON.stringify({ requestId, code: "agent_readiness_audit_unavailable" }));
    return;
  }
  const confirmed = currentSession();
  if (!confirmed || confirmed.sessionId !== session.sessionId || confirmed.subject !== session.subject ||
      confirmed.customer !== customer) {
    request.resume();
    response.writeHead(401).end(JSON.stringify({ requestId, code: "application_session_required" }));
    return;
  }
  response.writeHead(200).end(JSON.stringify({
    requestId, customer, extension, checkedAt: snapshot.checkedAt,
    ...(endpoint ? {
      deviceState: endpoint.deviceState,
      contactObserved: endpoint.hasContacts,
      activeChannels: endpoint.activeChannels,
    } : { deviceState: "Not observed", contactObserved: false, activeChannels: 0 }),
  }));
}
