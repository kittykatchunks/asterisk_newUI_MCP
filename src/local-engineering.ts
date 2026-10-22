import { readFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDiagnosticApi } from "./diagnostic-api.ts";
import { openDiagnosticStore } from "./diagnostic-store.ts";
import type { ApprovedIncident } from "./incidents.ts";
import { assertApprovedIncident } from "./incidents.ts";
import { createAmiStatusSource } from "./pbx-status.ts";
import type { AmiConnection } from "./pbx-status.ts";
import { openAgentStore } from "./agent-store.ts";
import { openAgentDeviceLeaseStore } from "./agent-device-lease.ts";
import type { CustomerPermission } from "./access.ts";

export async function loadLocalPbxStatus(root: string, endpoints = false) {
  let text: string;
  try { text = await readFile(join(root, ".local-proof", "pbx-status",
    endpoints ? "endpoint-connections.json" : "connections.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((item: unknown): item is AmiConnection =>
    typeof item === "object" && item !== null &&
    "customer" in item && typeof item.customer === "string" &&
    "host" in item && typeof item.host === "string" &&
    "port" in item && typeof item.port === "number" &&
    "username" in item && typeof item.username === "string" &&
    "secret" in item && typeof item.secret === "string" &&
    "tls" in item && typeof item.tls === "boolean")) throw new Error("Invalid local PBX status configuration");
  return createAmiStatusSource(value);
}

interface LocalAccount {
  subject: string;
  username: "alice" | "bob";
  customer: "customer-a" | "customer-b";
}

async function configuration(root: string) {
  const accounts: unknown = JSON.parse(await readFile(join(root, ".local-proof", "identity", "accounts.json"), "utf8"));
  const client: unknown = JSON.parse(await readFile(join(root, ".local-proof", "identity", "application-client.json"), "utf8"));
  if (!Array.isArray(accounts) || accounts.length !== 2 ||
      !accounts.every((account: unknown): account is LocalAccount =>
        typeof account === "object" && account !== null &&
        "subject" in account && typeof account.subject === "string" && account.subject.trim().length > 0 &&
        "username" in account && "customer" in account &&
        ((account.username === "alice" && account.customer === "customer-a") ||
          (account.username === "bob" && account.customer === "customer-b"))) ||
      new Set(accounts.map((account) => account.username)).size !== 2 ||
      new Set(accounts.map((account) => account.subject)).size !== 2) {
    throw new Error("Invalid local engineering accounts; regenerate the identity fixture");
  }
  if (typeof client !== "object" || client === null || !("clientId" in client) ||
      client.clientId !== "engineering-app-proof" || !("secret" in client) ||
      typeof client.secret !== "string" || !client.secret.trim()) {
    throw new Error("Invalid local engineering confidential client");
  }
  return { accounts, client: { clientId: client.clientId, secret: client.secret } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadCapturedIncidents(root: string): Promise<ApprovedIncident[]> {
  const evidenceRoot = join(root, ".local-proof", "evidence");
  const customers = ["customer-a", "customer-b"];
  const candidates: { id: string; createdAt: string; manifests: Record<string, unknown>[] }[] = [];
  for (const directory of await readdir(evidenceRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^incident-[0-9a-f]{32}$/.test(directory.name)) continue;
    let raw: string[];
    try {
      raw = await Promise.all(customers.map((customer) =>
        readFile(join(evidenceRoot, directory.name, customer, "export-manifest.json"), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const manifests: Record<string, unknown>[] = raw.map((text) => {
      const value: unknown = JSON.parse(text);
      if (!record(value)) throw new Error("Invalid captured export manifest");
      return value;
    });
    for (const [index, manifest] of manifests.entries()) {
      if (manifest.customer !== customers[index] || manifest.incident !== directory.name ||
          typeof manifest.started_utc !== "string" || !Number.isFinite(Date.parse(manifest.started_utc)) ||
          typeof manifest.report_sha256 !== "string") throw new Error("Captured manifest provenance is invalid");
    }
    candidates.push({ id: directory.name, createdAt: String(manifests[0].started_utc), manifests });
  }
  candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  const latest = candidates[0];
  if (!latest) throw new Error("No complete captured incident; run Test-CaptureProof.ps1 first");
  return Promise.all(customers.map(async (customer, index) => {
    const entry = {
      customer, summary: { id: latest.id, title: "Synthetic SIP evidence", createdAt: String(latest.manifests[index].started_utc) },
      report: {
        html: await readFile(join(evidenceRoot, latest.id, customer, "report.html"), "utf8"),
        sha256: String(latest.manifests[index].report_sha256),
      },
    };
    assertApprovedIncident(entry);
    return entry;
  }));
}

export async function startLocalEngineering(root: string, stageCapturedReports = false, withAgents = false) {
  const { accounts, client } = await configuration(root);
  const pbx = await loadLocalPbxStatus(root);
  const endpoints = await loadLocalPbxStatus(root, true);
  const issuer = "http://127.0.0.1:18080/realms/local-proof";
  const origin = "http://127.0.0.1:18766";
  const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!discoveryResponse.ok) throw new Error(`Local identity discovery failed (${discoveryResponse.status})`);
  const discovery: unknown = await discoveryResponse.json();
  if (typeof discovery !== "object" || discovery === null ||
      !("issuer" in discovery) || discovery.issuer !== issuer ||
      !("authorization_endpoint" in discovery) || typeof discovery.authorization_endpoint !== "string" ||
      !("token_endpoint" in discovery) || typeof discovery.token_endpoint !== "string" ||
      !("jwks_uri" in discovery) || typeof discovery.jwks_uri !== "string") {
    throw new Error("Invalid local identity discovery");
  }
  const entries = stageCapturedReports ? await loadCapturedIncidents(root) : [];
  const directory = join(root, ".local-proof", "engineering");
  await mkdir(directory, { recursive: true });
  const databasePath = join(directory, "diagnostics.sqlite");
  const store = openDiagnosticStore(databasePath);
  let agents: ReturnType<typeof openAgentStore> | undefined;
  let deviceLeases: ReturnType<typeof openAgentDeviceLeaseStore> | undefined;
  let server: ReturnType<typeof createDiagnosticApi> | undefined;
  try {
    if (withAgents) {
      agents = openAgentStore(join(directory, "agents.sqlite"), { readOnly: true });
      const alice = accounts.find((account) => account.username === "alice")!;
      if (!agents.profile(issuer, alice.subject, alice.customer)) {
        throw new Error("Agent mode requires an existing operator-provisioned assignment for the current synthetic Alice identity");
      }
      deviceLeases = openAgentDeviceLeaseStore(join(directory, "device-leases.sqlite"));
    }
    let staged = 0;
    if (entries.length) {
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const missing = entries.filter((entry) => {
          const row = reader.prepare("SELECT entry FROM report_candidates WHERE customer = ? AND incident = ?")
            .get(entry.customer, entry.summary.id);
          if (!row) return true;
          if (typeof row.entry !== "string" || JSON.stringify(JSON.parse(row.entry)) !== JSON.stringify(entry)) {
            throw new Error("Existing incident differs from captured snapshot; refusing replacement");
          }
          return false;
        });
        staged = store.stage(missing).length;
      } finally { reader.close(); }
    }
    server = createDiagnosticApi({
      issuer, audience: "diagnostic-api", jwksUrl: discovery.jwks_uri, allowLoopbackHttpForTests: true,
      memberships: accounts.map((account) => {
        const permissions: CustomerPermission[] = account.username === "alice" ?
          ["diagnostics:read", "diagnostics:report", "diagnostics:review"] : ["diagnostics:read"];
        if (withAgents && account.username === "alice") permissions.push("agent:access");
        return { issuer, subject: account.subject, customer: account.customer, permissions };
      }), supportGrants: [],
    }, store.audit, (error, requestId) => {
      // Never dump request/token-exchange objects or credential-bearing payloads.
      console.error(`Local engineering operation failed; request ${requestId}; ${error instanceof Error ? error.name : "UnknownError"}`);
    }, store.catalog, store, {
      origin, issuer, authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint, jwksUrl: discovery.jwks_uri,
      clientId: client.clientId, clientSecret: client.secret, audience: "diagnostic-api",
      allowLoopbackHttpForTests: true,
    }, pbx, endpoints, agents, deviceLeases);
    const active = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      active.once("error", failed);
      active.listen(18766, "127.0.0.1", () => {
        active.off("error", failed);
        resolve();
      });
    });
    let stopped: Promise<void> | undefined;
    return {
      origin, databasePath, staged, withAgents,
      stop() {
        stopped ??= new Promise<void>((resolve, reject) => {
          active.close((error) => {
            store.close();
            agents?.close();
            deviceLeases?.close();
            if (error) reject(error); else resolve();
          });
          active.closeAllConnections();
        });
        return stopped;
      },
    };
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    store.close();
    agents?.close();
    deviceLeases?.close();
    throw error;
  }
}

export const localEngineeringRoot = fileURLToPath(new URL("../", import.meta.url));
