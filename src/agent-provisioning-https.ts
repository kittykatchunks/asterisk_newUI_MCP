import { X509Certificate } from "node:crypto";
import { createServer, request } from "node:https";
import { checkServerIdentity, TLSSocket } from "node:tls";
import { AgentProvisioningConflict, parseProvisioningAcceptance, parseProvisioningReport } from "./agent-provisioning-store.ts";
import type { AgentProvisioningJournal, ProvisioningReport } from "./agent-provisioning-store.ts";
import type { AgentProvisioningTransport } from "./agent-provisioning-dispatcher.ts";
import { HttpInputError, readJsonBody } from "./http-json.ts";

interface ProvisioningTlsIdentity {
  cert: string;
  key: string;
  ca: string;
  peerFingerprint256: string;
}

function fingerprint(config: ProvisioningTlsIdentity) {
  if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(config.peerFingerprint256)) {
    throw new Error("Invalid provisioning TLS peer fingerprint");
  }
  // Fail configuration before opening a listener or sending a command.
  new X509Certificate(config.cert);
  new X509Certificate(config.ca);
  return config.peerFingerprint256;
}

// Only journal acceptance/readback: no adapter, runtime action or receipt-write route.
export function createAgentProvisioningHttpsWorker(journal: AgentProvisioningJournal,
  config: ProvisioningTlsIdentity, onError: (error: unknown) => void) {
  const peer = fingerprint(config);
  const server = createServer({
    cert: config.cert, key: config.key, ca: config.ca,
    requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2",
    handshakeTimeout: 5000,
  }, (req, res) => {
    const send = (status: number, body: unknown) => {
      req.resume();
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "Connection": "close" }).end(JSON.stringify(body));
    };
    const handle = async () => {
      if (!(req.socket instanceof TLSSocket) || !req.socket.authorized ||
          req.socket.getPeerCertificate().fingerprint256 !== peer) {
        send(403, { code: "provisioning_peer_denied" }); return;
      }
      const match = /^\/v1\/operations\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(req.url ?? "");
      if (match && req.method === "GET") {
        const report = journal.report(match[1]);
        send(report ? 200 : 404, report ?? { code: "provisioning_operation_not_found" });
        return;
      }
      if (req.url !== "/v1/operations" || req.method !== "POST") {
        send(404, { code: "provisioning_route_not_found" }); return;
      }
      const input = await readJsonBody(req, "provisioning", 8192);
      let submission: ReturnType<typeof parseProvisioningAcceptance>;
      try { submission = parseProvisioningAcceptance(input); }
      catch { throw new HttpInputError(400, "invalid_provisioning_acceptance"); }
      journal.accept(submission.command, submission.context);
      const report = journal.report(submission.command.operationId);
      if (!report) throw new Error("Accepted provisioning operation missing");
      send(200, report);
    };
    void handle().catch((error: unknown) => {
      if (error instanceof HttpInputError) send(error.status, { code: error.code });
      else if (error instanceof AgentProvisioningConflict) send(409, { code: "provisioning_conflict" });
      else {
        onError(error);
        send(500, { code: "provisioning_worker_failure" });
      }
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.timeout = 10000;
  return server;
}

export function createAgentProvisioningHttpsTransport(endpoint: string,
  config: ProvisioningTlsIdentity): AgentProvisioningTransport {
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" ||
      base.search || base.hash) throw new Error("Provisioning endpoint must be an HTTPS origin");
  const peer = fingerprint(config);
  // Capture immutable local configuration, never per-request URL/TLS overrides.
  const { cert, key, ca } = config;
  const call = (method: "GET" | "POST", path: string, signal: AbortSignal,
    body?: string): Promise<ProvisioningReport | undefined> => new Promise((resolve, reject) => {
    const req = request(new URL(path, base), {
      method, cert, key, ca, rejectUnauthorized: true, minVersion: "TLSv1.2",
      agent: false, signal,
      checkServerIdentity(host, certificate) {
        return checkServerIdentity(host, certificate) ??
          (certificate.fingerprint256 === peer ? undefined : new Error("Provisioning worker certificate pin mismatch"));
      },
      headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) res.destroy(new Error("Provisioning response too large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.headers["content-type"] !== "application/json" || res.headers["content-encoding"]) {
            throw new Error("Invalid provisioning response encoding");
          }
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (method === "GET" && res.statusCode === 404 && value !== null && typeof value === "object" &&
              Object.keys(value).length === 1 && "code" in value && value.code === "provisioning_operation_not_found") {
            resolve(undefined); return;
          }
          if (res.statusCode !== 200) throw new Error(`Provisioning worker HTTP status ${res.statusCode}`);
          resolve(parseProvisioningReport(value));
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Provisioning transport timed out")));
    req.end(body);
  });
  return {
    report(operationId, signal) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId)) {
        return Promise.reject(new Error("Invalid provisioning operation UUID"));
      }
      return call("GET", `/v1/operations/${operationId}`, signal);
    },
    async accept(intent, signal) {
      const input = parseProvisioningAcceptance({ command: intent.command, context: intent.context });
      const report = await call("POST", "/v1/operations", signal, JSON.stringify(input));
      if (!report) throw new Error("Provisioning acceptance report missing");
      return report;
    },
  };
}
