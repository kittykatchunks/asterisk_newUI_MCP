import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createAccessVerifier } from "./access.ts";
import type { AccessConfig } from "./access.ts";

export interface AccessAudit {
  requestId: string;
  timestamp: string;
  customer?: string;
  subject?: string;
  outcome: string;
  status: number;
  basis?: "membership" | "support-grant";
}

export function createDiagnosticApi(
  config: AccessConfig,
  audit: (event: AccessAudit) => Promise<void>,
  logError: (error: unknown, requestId: string) => void,
) {
  const verify = createAccessVerifier(config);
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Request-Id", requestId);
    const send = (status: number, code: string) => {
      if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="diagnostics"');
      response.writeHead(status).end(JSON.stringify({ code, requestId }));
    };
    let customer: string | undefined;
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const match = path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\/diagnostics$/);
      if (!match) { send(404, "not_found"); return; }
      customer = match[1];
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        send(405, "method_not_allowed");
        return;
      }
      const result = await verify(request.headers.authorization, customer);
      const status = result.allowed ? 200 : result.status;
      await audit({
        requestId, timestamp: new Date().toISOString(), customer, status,
        outcome: result.allowed ? "diagnostic_access_allowed" : result.code,
        ...(result.allowed ? { subject: result.subject, basis: result.basis } : {}),
      });
      if (!result.allowed) { send(status, result.code); return; }
      // This is a permission proof, not a production incident or capture endpoint.
      response.writeHead(200).end(JSON.stringify({
        requestId, customer, permission: "diagnostics:read",
        captureEnabled: false, evidenceServingEnabled: false,
      }));
    } catch (error) {
      logError(error, requestId);
      send(503, "diagnostic_access_unavailable");
    }
  });
}
