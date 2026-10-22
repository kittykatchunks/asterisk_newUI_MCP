import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createAccessVerifier } from "./access.ts";
import type { AccessConfig } from "./access.ts";
import type { IncidentCatalog } from "./incidents.ts";

export interface AccessAudit {
  requestId: string;
  timestamp: string;
  customer?: string;
  subject?: string;
  outcome: string;
  status: number;
  basis?: "membership" | "support-grant";
  operation?: "access" | "incident-list" | "report-view";
  incident?: string;
}

export function createDiagnosticApi(
  config: AccessConfig,
  audit: (event: AccessAudit) => Promise<void>,
  logError: (error: unknown, requestId: string) => void,
  catalog?: IncidentCatalog,
) {
  const verify = createAccessVerifier(config);
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Referrer-Policy", "no-referrer");
    const send = (status: number, code: string) => {
      if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="diagnostics"');
      response.writeHead(status).end(JSON.stringify({ code, requestId }));
    };
    let customer: string | undefined;
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const match = path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\/diagnostics(?:\/incidents(?:\/(incident-[0-9a-f]{32})\/report)?)?$/);
      if (!match) { send(404, "not_found"); return; }
      customer = match[1];
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        send(405, "method_not_allowed");
        return;
      }
      const incident = match[2];
      const operation = incident ? "report-view" : path.endsWith("/incidents") ? "incident-list" : "access";
      const result = await verify(request.headers.authorization, customer,
        incident ? "diagnostics:report" : "diagnostics:read");
      let status = result.allowed ? 200 : result.status;
      let outcome = result.allowed ? "diagnostic_access_allowed" : result.code;
      let body: unknown;
      let report: string | undefined;
      if (result.allowed && operation !== "access") {
        if (!catalog) {
          status = 503;
          outcome = "incident_catalog_unavailable";
        } else if (incident) {
          report = await catalog.report(customer, incident);
          if (report === undefined) { status = 404; outcome = "not_found"; }
          else { outcome = "incident_report_viewed"; }
        } else {
          body = { requestId, incidents: await catalog.list(customer) };
          outcome = "incidents_listed";
        }
      }
      await audit({
        requestId, timestamp: new Date().toISOString(), customer, status,
        outcome, operation, ...(incident ? { incident } : {}),
        ...(result.allowed ? { subject: result.subject, basis: result.basis } : {}),
      });
      if (status !== 200) { send(status, outcome); return; }
      if (report !== undefined) {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy",
          "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Disposition", 'inline; filename="incident-report.html"');
        response.writeHead(200).end(report);
        return;
      }
      if (body !== undefined) {
        response.writeHead(200).end(JSON.stringify(body));
        return;
      }
      // Capture control and raw evidence serving remain intentionally unavailable.
      response.writeHead(200).end(JSON.stringify({
        requestId, customer, permission: "diagnostics:read",
        captureEnabled: false, evidenceServingEnabled: catalog !== undefined,
        rawEvidenceServingEnabled: false,
      }));
    } catch (error) {
      logError(error, requestId);
      send(503, "diagnostic_access_unavailable");
    }
  });
}
