import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createAccessVerifier } from "./access.ts";
import type { AccessConfig } from "./access.ts";
import type { IncidentCatalog } from "./incidents.ts";
import type { DiagnosticStore } from "./diagnostic-store.ts";
import { handleReviewRequest } from "./review-http.ts";
import { createApplicationSessions } from "./application-session.ts";
import type { ApplicationSessionConfig } from "./application-session.ts";
import type { PbxStatusSource } from "./pbx-status.ts";

export interface AccessAudit {
  requestId: string;
  timestamp: string;
  customer?: string;
  subject?: string;
  outcome: string;
  status: number;
  basis?: "membership" | "support-grant";
  operation?: "access" | "incident-list" | "report-view" | "review-list" | "review-candidate" | "review-decision" | "review-history" | "pbx-status" | "session-login" | "session-logout";
  incident?: string;
}

export function createDiagnosticApi(
  config: AccessConfig,
  audit: (event: AccessAudit) => Promise<void>,
  logError: (error: unknown, requestId: string) => void,
  catalog?: IncidentCatalog,
  reviews?: Pick<DiagnosticStore, "pending" | "candidate" | "review" | "history">,
  sessionConfig?: ApplicationSessionConfig,
  pbx?: PbxStatusSource,
) {
  if (sessionConfig && (sessionConfig.issuer !== config.issuer || sessionConfig.audience !== config.audience ||
      sessionConfig.jwksUrl !== config.jwksUrl)) throw new Error("Application and API identity configuration mismatch");
  const sessions = sessionConfig ? createApplicationSessions(sessionConfig) : undefined;
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
      if (sessions && await sessions.handle(request, response, requestId, audit)) return;
      if (path.startsWith("/api/") && sessions) {
        const session = sessions.authorization(request);
        if (session.csrfDenied) {
          await audit({ requestId, timestamp: new Date().toISOString(), subject: session.subject,
            customer: path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\//)?.[1],
            operation: "access", status: 403, outcome: "invalid_session_csrf" });
          send(403, "invalid_session_csrf"); request.resume(); return;
        }
        if (session.authorization) request.headers.authorization = session.authorization;
      }
      const workspace = /^\/engineering\/reviews\/[a-z0-9][a-z0-9-]{0,63}$/.test(path);
      const boot = path === "/engineering/session.js" && sessions !== undefined;
      const preview = path === "/engineering/review-preview.js";
      const asset = ["/engineering/review.js", "/engineering/review-workspace.js"].includes(path) ? "js" :
        path === "/engineering/review.css" ? "css" : undefined;
      if (workspace || asset || boot || preview) {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); send(405, "method_not_allowed"); return; }
        const extension = boot || preview ? "js" : asset ?? "html";
        let content = await readFile(new URL(preview ? "./review-preview.js" : boot ? "./review-session.js" : `./review-workspace.${extension}`, import.meta.url), "utf8");
        if (workspace && sessions) content = content.replace("</main>", '</main><script type="module" src="/engineering/session.js"></script>');
        response.setHeader("Content-Type", extension === "html" ? "text/html; charset=utf-8" :
          extension === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
        response.setHeader("Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        response.setHeader("X-Frame-Options", "DENY");
        response.writeHead(200).end(content);
        return;
      }
      const reviewMatch = path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\/diagnostics\/reviews(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/);
      const pbxMatch = path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\/pbx\/status$/);
      if (pbxMatch) {
        customer = pbxMatch[1];
        const access = await verify(request.headers.authorization, customer, "diagnostics:read");
        if (!access.allowed) request.resume();
        let status = access.allowed ? 200 : access.status;
        let outcome = access.allowed ? "pbx_status_checked" : access.code;
        let snapshot;
        if (access.allowed) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            status = 405; outcome = "method_not_allowed";
            request.resume();
          } else {
            try {
              if (!pbx) throw new Error("PBX status source is not configured");
              snapshot = await pbx.status(customer);
              if (snapshot.customer !== customer || !Number.isFinite(Date.parse(snapshot.checkedAt)) ||
                  !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snapshot.coreStartedAtLocal) ||
                  !Number.isSafeInteger(snapshot.activeCalls) || snapshot.activeCalls < 0) {
                throw new Error("Invalid PBX status snapshot");
              }
            } catch (error) {
              logError(error, requestId);
              status = 503; outcome = "pbx_status_unavailable";
            }
          }
        }
        await audit({ requestId, timestamp: new Date().toISOString(), customer, status, outcome,
          operation: "pbx-status", ...(access.allowed ? { subject: access.subject, basis: access.basis } : {}) });
        if (status !== 200 || !snapshot) { send(status, outcome); return; }
        response.writeHead(200).end(JSON.stringify({ requestId, customer, checkedAt: snapshot.checkedAt,
          coreStartedAtLocal: snapshot.coreStartedAtLocal, activeCalls: snapshot.activeCalls }));
        return;
      }
      const historyMatch = path.match(/^\/api\/customers\/([a-z0-9][a-z0-9-]{0,63})\/diagnostics\/reviews\/history(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/);
      const reviewRoute = historyMatch ?? reviewMatch;
      if (reviewRoute) {
        await handleReviewRequest(request, response, requestId, reviewRoute[1], reviewRoute[2],
          verify, audit, reviews, historyMatch !== null);
        return;
      }
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
        } else {
          try {
            if (incident) {
              report = await catalog.report(customer, incident);
              if (report === undefined) { status = 404; outcome = "not_found"; }
              else { outcome = "incident_report_viewed"; }
            } else {
              body = { requestId, incidents: await catalog.list(customer) };
              outcome = "incidents_listed";
            }
          } catch (error) {
            logError(error, requestId);
            status = 503;
            outcome = "incident_catalog_unavailable";
          }
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
