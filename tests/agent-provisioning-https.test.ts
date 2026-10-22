import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentProvisioningHttpsWorker, createAgentProvisioningHttpsTransport } from "../src/agent-provisioning-https.ts";
import { createAgentProvisioningDispatcher } from "../src/agent-provisioning-dispatcher.ts";
import { createAgentProvisioningExecutor } from "../src/agent-provisioning-executor.ts";
import { openAgentProvisioningJournal, openAgentProvisioningStore } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";

interface Identity { cert: string; key: string }
interface Certificates {
  ca: string; worker: Identity; controller: Identity; foreign: Identity;
  mismatch: Identity; expired: Identity; untrusted: Identity;
}
const run = promisify(execFile);
const fixture = run("pwsh", ["-NoProfile", "-File",
  join(dirname(fileURLToPath(import.meta.url)), "identity", "New-ProvisioningTlsFixture.ps1")],
{ timeout: 30000 }).then(({ stdout }) => JSON.parse(stdout) as Certificates);
const pin = (identity: Identity) => new X509Certificate(identity.cert).fingerprint256;

test("mutual TLS pins both peers before durable customer-scoped acceptance; no execution is exposed", async () => {
  const certificates = await fixture;
  const directory = await mkdtemp(join(tmpdir(), "asterisk-mtls-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const now = () => 100000;
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding, { now });
  const store = openAgentProvisioningStore(join(directory, "backend.sqlite"), { now });
  const errors: unknown[] = [];
  let journalClosed = false;
  const server = createAgentProvisioningHttpsWorker(journal,
    { ...certificates.worker, ca: certificates.ca, peerFingerprint256: pin(certificates.controller) },
    (error) => errors.push(error));
  server.on("tlsClientError", () => { /* Expected unauthenticated TLS handshakes below. */ });
  server.listen(0, "localhost");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `https://localhost:${address.port}`;
  const config = { ...certificates.controller, ca: certificates.ca, peerFingerprint256: pin(certificates.worker) };
  const transport = createAgentProvisioningHttpsTransport(endpoint, config);
  const context = { requestId: randomUUID(), actor: "fixture-controller", reason: "Synthetic mTLS acceptance" };
  const command: AgentProvisioningCommand = { version: 1, ...binding, operationId: randomUUID(),
    revision: 1, leaseId: randomUUID(), notAfter: 160000, action: "prepare",
    payload: { generationId: randomUUID(), extension: "1001" } };
  const raw = (method: string, path: string, body?: string, identity: Identity | undefined = certificates.controller) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(`${endpoint}${path}`, { method, ...identity, ca: certificates.ca, agent: false,
        headers: { "Content-Type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
        res.on("error", reject);
      });
      req.on("error", reject); req.end(body);
    });
  try {
    for (const identity of [certificates.foreign, certificates.untrusted, certificates.expired]) {
      const rejected = createAgentProvisioningHttpsTransport(endpoint, { ...config, ...identity });
      await assert.rejects(rejected.report(command.operationId, AbortSignal.timeout(5000)));
    }
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const req = request(endpoint, { ca: certificates.ca, agent: false }, () => resolve());
      req.on("error", reject); req.end();
    }));
    assert.equal(journal.operation(command.operationId), undefined);
    assert.equal(await transport.report(command.operationId, AbortSignal.timeout(5000)), undefined);
    store.enrol(binding.customer, binding.epoch); store.enqueue(command, context);
    const dispatcher = createAgentProvisioningDispatcher(store, binding, transport, { now });
    assert.equal((await dispatcher.dispatch()).state, "accepted");
    assert.equal((await dispatcher.dispatch()).state, "accepted");
    assert.deepEqual(journal.next().state, "ready");
    assert.equal(journal.operation(command.operationId)?.receipts.length, 0);
    assert.equal((await raw("POST", "/v1/operations", JSON.stringify({
      command: { ...command, customer: "customer-b" }, context,
    }))).status, 409);
    for (const value of [
      { command: { ...command, payload: { ...command.payload, shell: "never" } }, context },
      { command, context, extra: "never" }, { command: { ...command, action: "execute" }, context },
    ]) assert.equal((await raw("POST", "/v1/operations", JSON.stringify(value))).status, 400);
    assert.equal((await raw("POST", "/v1/operations", "x".repeat(8193))).status, 413);
    assert.equal((await raw("POST", "/v1/operations", "{")).status, 400);
    assert.equal((await raw("POST", `/v1/operations/${command.operationId}/receipts`, "{}")).status, 404);
    assert.equal((await raw("GET", `/v1/operations/${command.operationId}?customer=customer-b`)).status, 404);
    let fakeEffects = 0;
    const executor = createAgentProvisioningExecutor(journal, {
      async apply() { fakeEffects++; },
      async observe() { return "verified"; },
    });
    assert.equal((await executor.step()).state, "verified");
    assert.equal((await dispatcher.dispatch()).state, "verified");
    assert.equal((await dispatcher.dispatch()).state, "idle");
    assert.equal(fakeEffects, 1);
    assert.deepEqual(store.operation(binding.customer, command.operationId)?.receipts.map((entry) => entry.stage),
      ["applying", "verified"]);
    assert.deepEqual(errors, []);
    journal.close();
    journalClosed = true;
    assert.equal((await raw("GET", `/v1/operations/${command.operationId}`)).status, 500);
    assert.equal(errors.length, 1, "Storage errors must be surfaced to the owning process");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!journalClosed) journal.close();
    store.close(); await rm(directory, { recursive: true });
  }
});

test("worker certificate chain, expiry, hostname and pin are verified before HTTP command bytes", async () => {
  const certificates = await fixture;
  const directory = await mkdtemp(join(tmpdir(), "asterisk-mtls-server-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding);
  try {
    for (const identity of [certificates.untrusted, certificates.expired, certificates.mismatch, certificates.foreign]) {
      const server = createAgentProvisioningHttpsWorker(journal,
        { ...identity, ca: certificates.ca, peerFingerprint256: pin(certificates.controller) },
        (error) => assert.fail(String(error)));
      let requests = 0;
      server.on("request", () => { requests++; });
      server.on("tlsClientError", () => { /* Expected rejected server identity. */ });
      server.listen(0, "localhost"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      try {
        const transport = createAgentProvisioningHttpsTransport(`https://localhost:${address.port}`,
          { ...certificates.controller, ca: certificates.ca, peerFingerprint256: pin(certificates.worker) });
        await assert.rejects(transport.report(randomUUID(), AbortSignal.timeout(5000)));
        assert.equal(requests, 0);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});

test("HTTPS transport rejects malformed, oversized, redirected and truncated responses and honours cancellation", async () => {
  const certificates = await fixture;
  let mode = "missing";
  const server = createServer({ ...certificates.worker, ca: certificates.ca, requestCert: true,
    rejectUnauthorized: true }, (req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (mode === "slow") return;
    if (mode === "missing") {
      res.writeHead(404).end(JSON.stringify({ code: "provisioning_operation_not_found" })); return;
    }
    if (mode === "wrong_missing") {
      res.writeHead(404).end(JSON.stringify({ code: "not_found" })); return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { Location: "https://elsewhere.invalid/" }).end("{}"); return;
    }
    if (mode === "oversized") { res.end("x".repeat(32769)); return; }
    if (mode === "truncated") {
      res.setHeader("Content-Length", "100"); res.flushHeaders();
      res.write("{"); res.socket?.destroy(); return;
    }
    if (mode === "compressed") res.setHeader("Content-Encoding", "gzip");
    res.end("{}");
  });
  server.listen(0, "localhost"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const config = { ...certificates.controller, ca: certificates.ca, peerFingerprint256: pin(certificates.worker) };
  const transport = createAgentProvisioningHttpsTransport(`https://localhost:${address.port}`, config);
  try {
    assert.equal(await transport.report(randomUUID(), AbortSignal.timeout(5000)), undefined);
    for (mode of ["wrong_missing", "redirect", "oversized", "truncated", "compressed", "invalid_report"]) {
      await assert.rejects(transport.report(randomUUID(), AbortSignal.timeout(5000)),
        (error: unknown) => error instanceof Error, mode);
    }
    mode = "slow";
    await assert.rejects(transport.report(randomUUID(), AbortSignal.timeout(50)), { name: "AbortError" });
    await assert.rejects(transport.report("../arbitrary-path", AbortSignal.timeout(5000)), /UUID/);
    for (const endpoint of ["http://localhost", "https://localhost/path", "https://user:secret@localhost",
      "https://localhost?query=never"]) {
      assert.throws(() => createAgentProvisioningHttpsTransport(endpoint, config), /HTTPS origin/);
    }
    assert.throws(() => createAgentProvisioningHttpsTransport("https://localhost",
      { ...config, peerFingerprint256: "bad" }), /fingerprint/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
