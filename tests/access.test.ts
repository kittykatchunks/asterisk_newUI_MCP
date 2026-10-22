import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccessVerifier } from "../src/access.ts";
import { createDiagnosticApi } from "../src/diagnostic-api.ts";
import type { AccessAudit } from "../src/diagnostic-api.ts";
import type { AccessConfig } from "../src/access.ts";
import { createIncidentCatalog } from "../src/incidents.ts";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDiagnosticStore } from "../src/diagnostic-store.ts";

const keys = await generateKeyPair("RS256");
const foreignKeys = await generateKeyPair("RS256");
const audit: AccessAudit[] = [];
const errors: unknown[] = [];
let issuerServer: Server;
let api: Server;
let issuer: string;
let base: string;
let config: AccessConfig;
let auditFailure = false;
const incidentA = "incident-" + "a".repeat(32);
const incidentB = "incident-" + "b".repeat(32);
const reportHtml = "<!doctype html><title>Approved synthetic report</title><h1>Redacted evidence</h1>";
const catalog = createIncidentCatalog([
  { customer: "customer-a", summary: { id: incidentA, title: "A synthetic incident", createdAt: "2026-10-22T12:00:00Z" },
    report: { html: reportHtml, sha256: createHash("sha256").update(reportHtml).digest("hex") } },
  { customer: "customer-b", summary: { id: incidentB, title: "B synthetic incident", createdAt: "2026-10-22T12:00:00Z" },
    report: { html: reportHtml, sha256: createHash("sha256").update(reportHtml).digest("hex") } },
]);

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
  const jwk = await exportJWK(keys.publicKey);
  issuerServer = createServer((request, response) => {
    if (request.url !== "/jwks") { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }));
  });
  issuer = await listen(issuerServer);
  const now = Math.floor(Date.now() / 1000);
  config = {
    issuer, audience: "diagnostic-api", jwksUrl: `${issuer}/jwks`,
    allowLoopbackHttpForTests: true,
    memberships: [
      { issuer, subject: "alice", customer: "customer-a", permissions: ["diagnostics:read"] },
      { issuer, subject: "bob", customer: "customer-b", permissions: ["diagnostics:read"] },
      { issuer, subject: "report-reader", customer: "customer-a", permissions: ["diagnostics:read", "diagnostics:report"] },
      { issuer, subject: "reviewer", customer: "customer-a", permissions: ["diagnostics:review"] },
    ],
    supportGrants: [
      { issuer, subject: "engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now - 10, expiresAt: now + 120, reason: "Synthetic incident", contractReference: "test-contract" },
      { issuer, subject: "expired-engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now - 100, expiresAt: now - 1, reason: "Expired incident", contractReference: "test-contract" },
      { issuer, subject: "future-engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now + 100, expiresAt: now + 200, reason: "Future incident", contractReference: "test-contract" },
    ],
  };
  api = createDiagnosticApi(config, async (event) => {
    if (auditFailure) throw new Error("Synthetic audit storage failure");
    audit.push(event);
  }, (error) => errors.push(error), catalog);
  base = await listen(api);
});

after(async () => {
  await close(api);
  await close(issuerServer);
});

async function token(subject = "alice", overrides: {
  issuer?: string; audience?: string; exp?: number; iat?: number; foreignKey?: boolean;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: ["platform-admin"], customer: "customer-b" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(subject).setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "diagnostic-api")
    .setIssuedAt(overrides.iat ?? now).setExpirationTime(overrides.exp ?? now + 120)
    .sign(overrides.foreignKey ? foreignKeys.privateKey : keys.privateKey);
}

async function access(customer: string, bearer?: string) {
  return fetch(`${base}/api/customers/${customer}/diagnostics`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

test("persistent audit commit gates report bytes and storage failures return 503", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-api-store-"));
  const path = join(directory, "diagnostics.sqlite");
  const store = openDiagnosticStore(path);
  const observedErrors: unknown[] = [];
  const persistentApi = createDiagnosticApi(config, store.audit,
    (error) => observedErrors.push(error), store.catalog);
  const reader = new DatabaseSync(path);
  try {
    const [candidate] = store.stage([{
      customer: "customer-a", summary: { id: incidentA, title: "Persisted report", createdAt: "2026-10-22T12:00:00Z" },
      report: { html: reportHtml, sha256: createHash("sha256").update(reportHtml).digest("hex") },
    }]);
    const origin = await listen(persistentApi);
    const headers = { Authorization: `Bearer ${await token("report-reader")}` };
    const url = `${origin}/api/customers/customer-a/diagnostics/incidents/${incidentA}/report`;
    const pending = await fetch(url, { headers });
    assert.equal(pending.status, 404);
    assert.ok(!(await pending.text()).includes(reportHtml));
    store.review(candidate.id, {
      sha256: candidate.sha256, decision: "approve", reviewer: "synthetic-reviewer", reason: "Synthetic fixture review",
    });
    const allowed = await fetch(url, { headers });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), reportHtml);
    assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total, 2);
    reader.exec("BEGIN IMMEDIATE");
    try {
      const denied = await fetch(url, { headers });
      assert.equal(denied.status, 503);
      assert.ok(!(await denied.text()).includes(reportHtml));
    } finally { reader.exec("ROLLBACK"); }
    assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total, 2);
    reader.prepare("UPDATE incidents SET entry = ?").run("null");
    const corrupt = await fetch(url, { headers });
    assert.equal(corrupt.status, 503);
    assert.ok(!(await corrupt.text()).includes(reportHtml));
    assert.equal(reader.prepare("SELECT outcome FROM access_audit ORDER BY sequence DESC LIMIT 1").get()?.outcome,
      "incident_catalog_unavailable");
    assert.equal(observedErrors.length, 2);
  } finally {
    await close(persistentApi);
    reader.close();
    store.close();
    await rm(directory, { recursive: true });
  }
});

test("valid OIDC signature and provisioned membership allow only assigned customer", async () => {
  const jwt = await token();
  const allowed = await access("customer-a", jwt);
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.captureEnabled, false);
  assert.equal(body.evidenceServingEnabled, true);
  assert.equal(body.rawEvidenceServingEnabled, false);
  assert.equal((await access("customer-b", jwt)).status, 403);
  assert.equal((await access("customer-a", await token("bob"))).status, 403);
  assert.equal((await access("customer-b", await token("bob"))).status, 200);
});

test("missing, malformed, expired, future, wrong-issuer/audience/signature tokens fail", async () => {
  assert.equal((await access("customer-a")).status, 401);
  assert.equal((await access("customer-a", "bad.token")).status, 401);
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { exp: now - 1 }, { iat: now + 100 }, { iat: now - 1000 },
    { issuer: "https://foreign.invalid" }, { audience: "other-api" }, { foreignKey: true },
  ]) {
    assert.equal((await access("customer-a", await token("alice", overrides))).status, 401);
  }
});

test("unknown identity cannot gain privileges from token roles", async () => {
  assert.equal((await access("customer-a", await token("stranger"))).status, 403);
});

test("support elevation is customer-scoped and time-bounded", async () => {
  assert.equal((await access("customer-a", await token("engineer"))).status, 200);
  assert.equal((await access("customer-b", await token("engineer"))).status, 403);
  for (const subject of ["expired-engineer", "future-engineer"]) {
    assert.equal((await access("customer-a", await token(subject))).status, 403);
  }
  assert.ok(audit.some((event) => event.subject === "engineer" && event.basis === "support-grant"));
});

test("audit failure prevents access and logs an explicit operational error", async () => {
  auditFailure = true;
  try {
    const response = await access("customer-a", await token());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "diagnostic_access_unavailable");
    assert.equal(errors.length, 1);
  } finally { auditFailure = false; }
});

test("no capture mutation route and no token leakage in audit", async () => {
  const response = await fetch(`${base}/api/customers/customer-a/diagnostics`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal((await fetch(`${base}/api/customers/customer-a/capture`)).status, 404);
  assert.ok(audit.length > 0);
  assert.ok(!JSON.stringify(audit).includes("Bearer"));
  assert.ok(!JSON.stringify(audit).includes("eyJ"));
});

test("unsafe identity URLs and unbounded support grants fail at startup", () => {
  assert.throws(() => createAccessVerifier({ ...config, allowLoopbackHttpForTests: false }), /HTTPS/);
  assert.throws(() => createAccessVerifier({
    ...config, jwksUrl: "http://remote.invalid/jwks",
  }), /HTTPS/);
  assert.throws(() => createAccessVerifier({
    ...config, supportGrants: [{ ...config.supportGrants[0], reason: "" }],
  }), /reason/);
});

test("required expiry claim cannot be omitted", async () => {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer).setAudience("diagnostic-api").setSubject("alice")
    .setIssuedAt().sign(keys.privateKey);
  assert.equal((await access("customer-a", jwt)).status, 401);
});

test("unavailable JWKS service denies access with an operational response", async () => {
  const temporary = createServer();
  const unavailable = await listen(temporary);
  await close(temporary);
  const verify = createAccessVerifier({ ...config, jwksUrl: `${unavailable}/jwks` });
  const result = await verify(`Bearer ${await token()}`, "customer-a");
  assert.deepEqual(result, {
    allowed: false, status: 503, code: "identity_verification_unavailable",
  });
});

test("later configuration mutation cannot expand existing verifier access", async () => {
  const mutable = structuredClone(config);
  const verify = createAccessVerifier(mutable);
  mutable.memberships = [...mutable.memberships, {
    issuer, subject: "alice", customer: "customer-b", permissions: ["diagnostics:read"],
  }];
  const result = await verify(`Bearer ${await token()}`, "customer-b");
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.status, 403);
});

async function incidentRequest(path: string, subject = "alice") {
  return fetch(`${base}/api/customers/${path}`, {
    headers: { Authorization: `Bearer ${await token(subject)}` },
  });
}

test("incident lists are customer-scoped and return only allowlisted metadata", async () => {
  const response = await incidentRequest("customer-a/diagnostics/incidents");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.incidents, [
    { id: incidentA, title: "A synthetic incident", createdAt: "2026-10-22T12:00:00Z" },
  ]);
  assert.equal((await incidentRequest("customer-b/diagnostics/incidents")).status, 403);
  assert.equal(JSON.stringify(body).includes("sha256"), false);
  assert.equal(JSON.stringify(body).includes(reportHtml), false);
});

test("metadata permission and diagnostics-only support do not grant report access", async () => {
  for (const subject of ["alice", "engineer"]) {
    assert.equal((await incidentRequest(
      `customer-a/diagnostics/incidents/${incidentA}/report`, subject)).status, 403);
  }
});

test("approved reports require permission, remain tenant-bound, and are sandboxed", async () => {
  const response = await incidentRequest(
    `customer-a/diagnostics/incidents/${incidentA}/report`, "report-reader");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), reportHtml);
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox allow-scripts;/);
  assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /allow-same-origin/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await incidentRequest(
    `customer-a/diagnostics/incidents/${incidentB}/report`, "report-reader")).status, 404);
  assert.equal((await incidentRequest(
    `customer-b/diagnostics/incidents/${incidentB}/report`, "report-reader")).status, 403);
  assert.ok(audit.some((event) => event.operation === "report-view" && event.incident === incidentA && event.status === 200));
});

test("raw evidence routes and path tricks cannot access packet or CEL files", async () => {
  for (const suffix of ["signalling.pcap", "cel.csv", "manifest.json", "report.html", "%2e%2e%2fsecret"]) {
    assert.equal((await incidentRequest(
      `customer-a/diagnostics/incidents/${incidentA}/${suffix}`, "report-reader")).status, 404);
  }
});

test("audit failure denies report bytes", async () => {
  auditFailure = true;
  try {
    const response = await incidentRequest(
      `customer-a/diagnostics/incidents/${incidentA}/report`, "report-reader");
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("Redacted evidence"), false);
  } finally { auditFailure = false; }
});

test("incident catalog rejects tampered reports and cannot be mutated through returned summaries", async () => {
  assert.throws(() => createIncidentCatalog([{
    customer: "customer-a", summary: { id: incidentA, title: "Test", createdAt: "2026-10-22T12:00:00Z" },
    report: { html: reportHtml, sha256: "0".repeat(64) },
  }]), /integrity/);
  const list = await catalog.list("customer-a");
  list[0].title = "Changed";
  assert.equal((await catalog.list("customer-a"))[0].title, "A synthetic incident");
  assert.equal(await catalog.report("customer-a", incidentB), undefined);
});

test("unconfigured or failed catalog produces explicit unavailability, not an empty success", async () => {
  for (const catalogOption of [
    undefined,
    {
      async list(): Promise<never> { throw new Error("Synthetic repository failure"); },
      async report(): Promise<never> { throw new Error("Synthetic repository failure"); },
    },
  ]) {
    const events: AccessAudit[] = [];
    const logged: unknown[] = [];
    const server = createDiagnosticApi(config, async (event) => { events.push(event); },
      (error) => logged.push(error), catalogOption);
    const origin = await listen(server);
    try {
      const response = await fetch(`${origin}/api/customers/customer-a/diagnostics/incidents`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });

      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes('"incidents":[]'), false);
      if (catalogOption) assert.equal(logged.length, 1);
      assert.equal(events[0].outcome, "incident_catalog_unavailable");
    } finally { await close(server); }
  }
});

test("authenticated review endpoints isolate customers, bind reviewer identity and publish atomically with audit",async () => {
  const directory=await mkdtemp(join(tmpdir(),"asterisk-review-api-"));
  const path=join(directory,"diagnostics.sqlite");
  const store=openDiagnosticStore(path);
  const logged: unknown[]=[];
  const server=createDiagnosticApi(config,store.audit,(error) => logged.push(error),store.catalog,store);
  const reader=new DatabaseSync(path);
  try {
    const staged=(customer: string,id: string) => ({
      customer,summary: { id,title: "Unapproved synthetic report",createdAt: "2026-10-22T12:00:00Z" },
      report: { html: reportHtml,sha256: createHash("sha256").update(reportHtml).digest("hex") },
    });
    const [own,other,rejected,auditFail,publishFail]=store.stage([
      staged("customer-a",incidentA),staged("customer-b",incidentB),
      staged("customer-a","incident-"+"c".repeat(32)),
      staged("customer-a","incident-"+"d".repeat(32)),
      staged("customer-a","incident-"+"e".repeat(32)),
    ]);
    const origin=await listen(server);
    const root=`${origin}/api/customers/customer-a/diagnostics/reviews`;
    const reviewerHeaders={ Authorization: `Bearer ${await token("reviewer")}` };
    const post=(id: string,body: unknown,headers=reviewerHeaders) => fetch(`${root}/${id}`,{
      method: "POST",headers: { ...headers,"Content-Type": "application/json" },body: JSON.stringify(body),
    });
    const decision={ decision: "approve",reason: "Reviewed synthetic scope and redaction",sha256: own.sha256 };
    assert.equal((await fetch(root)).status,401);
    for(const subject of ["alice","report-reader","engineer","stranger"]) {
      const headers={ Authorization: `Bearer ${await token(subject)}` };
      assert.equal((await fetch(root,{ headers })).status,403);
      assert.equal((await post(own.id,decision,headers)).status,403);
    }
    assert.equal((await fetch(root.replace("customer-a","customer-b"),{ headers: reviewerHeaders })).status,403);
    const list=await fetch(root,{ headers: reviewerHeaders });
    assert.equal(list.status,200);
    const listing=await list.json();
    assert.equal(listing.candidates.length,4);
    assert.deepEqual(listing.candidates.find((candidate: { id: string }) => candidate.id === own.id), {
      ...own, summary: staged("customer-a", incidentA).summary,
    });
    assert.ok(listing.candidates.every((candidate: { summary: { id: string } }) => candidate.summary.id !== incidentB));
    assert.ok(!JSON.stringify(listing).includes(reportHtml));
    const candidate=await fetch(`${root}/${own.id}`,{ headers: reviewerHeaders });
    assert.equal(candidate.status,200);
    assert.match(candidate.headers.get("content-type")??"",/^application\/json/);
    assert.match(candidate.headers.get("content-security-policy")??"",/default-src 'none'/);
    assert.equal((await candidate.json()).candidate.entry.report.html,reportHtml);
    assert.equal((await fetch(`${root}/${other.id}`,{ headers: reviewerHeaders })).status,404);
    assert.equal((await post(other.id,{ ...decision,sha256: other.sha256 })).status,404);
    assert.equal((await post(own.id,{ ...decision,sha256: "0".repeat(64) })).status,409);
    assert.deepEqual(await store.catalog.list("customer-a"),[]);
    for(const body of [{ ...decision,reviewer: "spoofed-admin" },{ ...decision,reason: " " },
    { ...decision,decision: "publish" },null,[]]) {
      assert.equal((await post(own.id,body)).status,400);
    }
    assert.equal((await fetch(`${root}/${own.id}`,{ method: "POST",headers: reviewerHeaders,body: "{}" })).status,415);
    assert.equal((await fetch(`${root}/${own.id}`,{
      method: "POST",headers: { ...reviewerHeaders,"Content-Type": "application/json" },body: "{",
    })).status,400);
    assert.equal((await post(own.id,{ ...decision,reason: "x".repeat(9000) })).status,413);
    assert.equal((await fetch(root,{ method: "POST",headers: reviewerHeaders })).status,405);
    assert.equal((await post(own.id,decision)).status,200);
    const receipt=reader.prepare("SELECT reviewer, reason FROM incident_reviews WHERE candidate = ?").get(own.id);
    assert.equal(receipt?.reviewer,"reviewer");
    assert.equal(receipt?.reason,decision.reason);
    assert.equal(await store.catalog.report("customer-a",incidentA),reportHtml);
    assert.equal(reader.prepare("SELECT subject FROM access_audit WHERE outcome = 'incident_review_approve'").get()?.subject,"reviewer");
    assert.equal((await post(own.id,decision)).status,409);
    const encoded=JSON.stringify(decision);
    for(const [size,expected] of [[8192,409],[8193,413]]) {
      const boundary=await fetch(`${root}/${own.id}`,{
        method: "POST",headers: { ...reviewerHeaders,"Content-Type": "application/json" },
        body: encoded.padEnd(size," "),
      });
      assert.equal(boundary.status,expected);
    }
    assert.equal((await fetch(`${root}/${own.id}`,{
      method: "POST",headers: { ...reviewerHeaders,"Content-Type": "application/json","Content-Encoding": "gzip" },
      body: encoded,
    })).status,415);
    const started=Date.now();
    const timedOut=await new Promise<number>((resolve,reject) => {
      const request=httpRequest(`${root}/${own.id}`,{
        method: "POST",headers: { ...reviewerHeaders,"Content-Type": "application/json" },
      },(response) => {
        response.resume();
        response.once("end",() => { request.end(); resolve(response.statusCode??0); });
      });
      request.on("error",reject);
      request.setTimeout(8000,() => request.destroy(new Error("Review timeout test stalled")));
      request.write("{");
    });
    assert.equal(timedOut,408);
    assert.ok(Date.now()-started>=4500&&Date.now()-started<8000);
    assert.equal((await post(rejected.id,{ ...decision,decision: "reject",sha256: rejected.sha256 })).status,200);
    assert.equal(await store.catalog.report("customer-a","incident-"+"c".repeat(32)),undefined);
    reader.exec(`CREATE TRIGGER fail_review_audit BEFORE INSERT ON access_audit
            WHEN NEW.operation = 'review-decision' AND NEW.status = 200
            BEGIN SELECT RAISE(ABORT, 'Synthetic review audit failure'); END`);
    const failed=await post(auditFail.id,{ ...decision,sha256: auditFail.sha256 });
    assert.equal(failed.status,503);
    assert.equal(reader.prepare("SELECT 1 FROM incident_reviews WHERE candidate = ?").get(auditFail.id),undefined);
    assert.equal(await store.catalog.report("customer-a","incident-"+"d".repeat(32)),undefined);
    reader.exec(`DROP TRIGGER fail_review_audit;
            CREATE TRIGGER fail_review_publish BEFORE INSERT ON incidents
            BEGIN SELECT RAISE(ABORT, 'Synthetic review publication failure'); END`);
    assert.equal((await post(publishFail.id,{ ...decision,sha256: publishFail.sha256 })).status,503);
    assert.equal(reader.prepare("SELECT 1 FROM incident_reviews WHERE candidate = ?").get(publishFail.id),undefined);
    assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit WHERE outcome = 'incident_review_approve'").get()?.total,1);
    reader.exec(`CREATE TRIGGER fail_candidate_audit BEFORE INSERT ON access_audit
            WHEN NEW.operation = 'review-candidate'
            BEGIN SELECT RAISE(ABORT, 'Synthetic candidate audit failure'); END`);
    const unreadable=await fetch(`${root}/${own.id}`,{ headers: reviewerHeaders });
    assert.equal(unreadable.status,503);
    assert.ok(!(await unreadable.text()).includes(reportHtml));
    assert.equal(logged.length,3);
    // Review authority does not implicitly confer report disclosure permission.
    assert.equal((await fetch(`${origin}/api/customers/customer-a/diagnostics/incidents/${incidentA}/report`,
      { headers: reviewerHeaders })).status,403);
  } finally {
    await close(server);
    reader.close();
    store.close();
    await rm(directory,{ recursive: true });
  }
});

test("review history is read-only, audited, customer-scoped and fails closed on audit/storage errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-review-history-"));
  const path = join(directory, "diagnostics.sqlite");
  const store = openDiagnosticStore(path);
  const logged: unknown[] = [];
  const server = createDiagnosticApi(config, store.audit, (error) => logged.push(error), store.catalog, store);
  const writer = new DatabaseSync(path);
  try {
    const [own, other, pending] = store.stage([
      ...["customer-a", "customer-b"].map((customer) => ({
        customer, summary: { id: incidentA, title: "History report", createdAt: "2026-10-22T12:00:00Z" },
        report: { html: reportHtml, sha256: createHash("sha256").update(reportHtml).digest("hex") },
      })),
      { customer: "customer-a", summary: { id: incidentB, title: "Pending", createdAt: "2026-10-22T12:00:00Z" } },
    ]);
    for (const candidate of [own, other]) store.review(candidate.id, {
      decision: "reject", reviewer: "verified-reviewer", reason: "Not suitable", sha256: candidate.sha256,
    });
    const origin = await listen(server);
    const root = `${origin}/api/customers/customer-a/diagnostics/reviews/history`;
    const headers = { Authorization: `Bearer ${await token("reviewer")}` };
    for (const url of [root, `${root}/${own.id}`]) {
      assert.equal((await fetch(url)).status, 401);
      for (const subject of ["alice", "report-reader", "engineer", "stranger"]) {
        assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${await token(subject)}` } })).status, 403);
      }
      assert.equal((await fetch(url.replace("customer-a", "customer-b"), { headers })).status, 403);
      for (const method of ["POST", "PUT", "DELETE"]) {
        const denied = await fetch(url, { method, headers });
        assert.equal(denied.status, 405);
        assert.equal(denied.headers.get("allow"), "GET");
      }
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(body.reviews, store.history("customer-a", url === root ? undefined : own.id).reviews);
      assert.equal(body.truncated, false);
      assert.ok(!JSON.stringify(body).includes(reportHtml));
      const audit = writer.prepare("SELECT operation, outcome, subject FROM access_audit WHERE request_id = ?").get(response.headers.get("x-request-id"));
      assert.deepEqual({ ...audit }, { operation: "review-history", outcome: "review_history_viewed", subject: "reviewer" });
    }
    for (const id of [other.id, pending.id, "00000000-0000-0000-0000-000000000000"]) {
      const response = await fetch(`${root}/${id}`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).reviews, []);
    }
    writer.exec(`CREATE TRIGGER fail_history_audit BEFORE INSERT ON access_audit
      WHEN NEW.operation = 'review-history' BEGIN SELECT RAISE(ABORT, 'Synthetic history audit failure'); END`);
    const auditFailure = await fetch(root, { headers });
    assert.equal(auditFailure.status, 503);
    assert.ok(!(await auditFailure.text()).includes("Not suitable"));
    writer.exec("DROP TRIGGER fail_history_audit");
    writer.prepare("UPDATE incident_reviews SET sha256 = ? WHERE candidate = ?").run("0".repeat(64), own.id);
    const corrupt = await fetch(root, { headers });
    assert.equal(corrupt.status, 503);
    assert.ok(!(await corrupt.text()).includes("Not suitable"));
    assert.equal(logged.length, 2);
  } finally {
    await close(server); writer.close(); store.close();
    await rm(directory, { recursive: true });
  }
});

test("review routes fail explicitly without a configured reviewer store",async () => {
  const response=await fetch(`${base}/api/customers/customer-a/diagnostics/reviews`,{
    headers: { Authorization: `Bearer ${await token("reviewer")}` },
  });
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,"incident_review_unavailable");
  const history = await fetch(`${base}/api/customers/customer-a/diagnostics/reviews/history`, {
    headers: { Authorization: `Bearer ${await token("reviewer")}` },
  });
  assert.equal(history.status, 503);
  assert.equal((await history.json()).code, "incident_review_unavailable");
});
