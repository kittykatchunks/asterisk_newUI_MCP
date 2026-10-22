import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { createAccessVerifier } from "../../src/access.ts";
import type { AccessConfig } from "../../src/access.ts";
import { createApplicationSessions } from "../../src/application-session.ts";
import type { ApplicationSessionConfig } from "../../src/application-session.ts";
import { openAgentDeviceLeaseStore } from "../../src/agent-device-lease.ts";
import { createAuthorisedProvisioningTransport, createSessionProvisioningAuthorisation } from "../../src/agent-provisioning-authorisation.ts";
import { createAgentProvisioningDispatcher } from "../../src/agent-provisioning-dispatcher.ts";
import { openAgentProvisioningStore, openAgentProvisioningJournal } from "../../src/agent-provisioning-store.ts";
import type { AccessAudit } from "../../src/diagnostic-api.ts";

export async function proveBackendSessions(browser: Browser, config: ApplicationSessionConfig,
  access: AccessConfig, accounts: readonly { subject: string; username: string; password: string; customer: string }[]) {
  const sessions = createApplicationSessions(config);
  const verify = createAccessVerifier(access);
  const errors: unknown[] = [];
  const audit: AccessAudit[] = [];
  const server = createServer((request, response) => {
    void sessions.handle(request, response, randomUUID(), async (event) => { audit.push(event); })
      .then((handled) => {
        if (!handled) response.writeHead(request.url?.startsWith("/engineering/reviews/") ? 200 : 404).end("Synthetic backend session proof");
      }).catch((error) => { errors.push(error); response.writeHead(500).end(); });
  });
  const endpoint = new URL(config.origin);
  try {
    server.listen(Number(endpoint.port), endpoint.hostname);
    await once(server, "listening");
    for (const account of accounts) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const login = async (credentials: boolean) => {
          await page.goto(`${config.origin}/auth/login?customer=${account.customer}`);
          if (credentials) {
            await page.locator("#username").fill(account.username);
            await page.locator("#password").fill(account.password);
            await page.locator("#kc-login").click();
          }
          await page.waitForURL(`${config.origin}/engineering/reviews/${account.customer}`);
          const cookies = (await context.cookies(config.origin)).filter((cookie) => cookie.name === "asterisk-test-session");
          assert.equal(cookies.length, 1);
          assert.equal(cookies[0].httpOnly, true);
          return { issuer: config.issuer, subject: account.subject, customer: account.customer, sessionId: cookies[0].value };
        };
        const logout = async () => {
          assert.equal(await page.evaluate(async () => {
            const session = await fetch("/auth/session");
            if (session.status !== 200) throw new Error("Session bootstrap failed");
            const body = await session.json();
            return (await fetch("/auth/logout", {
              method: "POST", headers: { "X-CSRF-Token": body.csrf },
            })).status;
          }), 200);
        };
        const signal = AbortSignal.timeout(30000);
        let owner = await login(true);
        assert.ok(sessions.lookupIdentity(owner));
        assert.deepEqual(await sessions.verifyAgentAccess(owner, verify, signal), account.username === "alice"
          ? { allowed: true, subject: account.subject, basis: "membership" }
          : { allowed: false, status: 403, code: "customer_access_denied" });
        for (const foreign of [
          { ...owner, customer: owner.customer === "customer-a" ? "customer-b" : "customer-a" },
          { ...owner, issuer: "https://foreign.invalid" },
        ]) assert.equal(sessions.lookupIdentity(foreign), undefined);
        const deferred = () => {
          let started!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((resolve) => { started = resolve; });
          const resumed = new Promise<void>((resolve) => { release = resolve; });
          const gated: ReturnType<typeof createAccessVerifier> = async (...args) => {
            try { return await verify(...args); }
            finally { started(); await resumed; }
          };
          return { started: entered, release, verify: gated };
        };
        if (account.username === "alice") {
          const gate = deferred();
          const pending = sessions.verifyAgentAccess(owner, gate.verify, signal);
          try {
            await gate.started;
            const previous = owner;
            owner = await login(false);
            assert.notEqual(owner.sessionId, previous.sessionId);
            assert.equal(sessions.lookupIdentity(previous), undefined);
          } finally { gate.release(); }
          assert.deepEqual(await pending, { allowed: false, status: 401, code: "application_session_required" });
          const directory = await mkdtemp(join(tmpdir(), "asterisk-keycloak-dispatch-"));
          try {
            const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"));
            try {
              const backend = openAgentProvisioningStore(join(directory, "backend.sqlite"));
              try {
                const binding = { customer: owner.customer, epoch: randomUUID() };
                const worker = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding);
                try {
                  const identity = sessions.lookupIdentity(owner);
                  assert.ok(identity);
                  const deviceOwner = { ...owner, deviceId: randomUUID(), sessionExpiresAt: identity.expiresAt };
                  const lease = leases.acquire(deviceOwner);
                  const generationId = randomUUID();
                  backend.enrol(binding.customer, binding.epoch);
                  const authorisationId = sessions.authorisationReference(owner);
                  assert.ok(authorisationId);
                  const intent = backend.enqueueOwned({
                    version: 1, ...binding, operationId: randomUUID(), revision: 1,
                    leaseId: lease.id, notAfter: lease.expiresAt, action: "prepare",
                    payload: { generationId, extension: "1001" },
                  }, { requestId: randomUUID(), actor: "identity-proof", reason: "Real Keycloak session dispatch" },
                  { issuer: owner.issuer, subject: owner.subject, customer: owner.customer, authorisationId,
                    sessionExpiresAt: identity.expiresAt, deviceId: deviceOwner.deviceId, generationId, extension: "1001" });
                  let accepts = 0;
                  const gate = deferred();
                  let pause = false;
                  const authorisation = createSessionProvisioningAuthorisation({
                    store: backend, sessions,
                    verify: (...args) => (pause ? gate.verify : verify)(...args),
                    agents: { profile() { return { extension: "1001", displayName: "Synthetic Alice" }; } }, leases,
                  });
                  const guarded = createAuthorisedProvisioningTransport({
                    async report(id) { return worker.report(id); },
                    async accept(submission) {
                      accepts++;
                      worker.accept(submission.command, submission.context);
                      return worker.report(submission.command.operationId)!;
                    },
                  }, binding, authorisation);
                  assert.equal((await createAgentProvisioningDispatcher(backend, binding, guarded).dispatch()).state, "accepted");
                  assert.equal(accepts, 1);
                  assert.deepEqual(leases.current(deviceOwner, lease.id), lease);
                  pause = true;
                  const pending = guarded.accept(intent, signal);
                  const rejected = assert.rejects(pending, /Direct provisioning agent membership required/);
                  try {
                    await gate.started;
                    await logout();
                  } finally { gate.release(); }
                  await rejected;
                  assert.equal(accepts, 1, "Logout during real JWT verification must prevent worker delivery");
                  assert.equal(authorisation.resolve(intent), undefined, "Persisted original ownership cannot authorise after logout");
                  await assert.rejects(guarded.accept(intent, signal), /owner context missing/);
                  assert.equal((await guarded.report(intent.command.operationId, signal))?.operationId, intent.command.operationId);
                } finally { worker.close(); }
              } finally { backend.close(); }
            } finally { leases.close(); }
          } finally { await rm(directory, { recursive: true }); }
        } else { await logout(); }
        assert.equal(sessions.lookupIdentity(owner), undefined);
        assert.deepEqual(await sessions.verifyAgentAccess(owner, verify, signal),
          { allowed: false, status: 401, code: "application_session_required" });
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    assert.equal(audit.filter((event) => event.operation === "session-login").length, accounts.length + 1);
    assert.equal(audit.filter((event) => event.operation === "session-logout").length, accounts.length);
    assert.ok(!JSON.stringify(audit).includes(config.clientSecret));
    console.log("PASS real Keycloak backend session lookup, direct membership, rotation, durable opaque ownership and concurrent logout fencing");
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}
