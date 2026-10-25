import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { configurationHash, configurationNamespace, CONFIGURATION_COMPILER } from "../src/configuration-model.ts";
import { CONFIGURATION_FILES, EMPTY_PROOF_DIALPLAN, EMPTY_PROOF_QUEUE, type ConfigurationBinding,
  type inspectConfigurationBinding } from "../src/configuration-inspector.ts";
import { configurationReview, compareConfigurationReview, parseConfigurationReview } from "../src/configuration-review.ts";
import { ConfigurationConflict, openConfigurationStore } from "../src/configuration-store.ts";

const scope = { customer: "customer-a", runtime: "runtime-a" };
const actor = { operator: "offline-reviewer", reason: "Explicit immutable bound review" };
const binding: ConfigurationBinding = {
  version: 1, baseline: "empty-owned-proof-v1", compiler: CONFIGURATION_COMPILER, ...scope,
  namespace: configurationNamespace(scope), project: "asterisk-inspection-abc123", service: "customer-a",
  containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, startedAt: "2026-10-25T11:00:00Z",
  startTicks: "12345", mountSource: "/trusted/customer-a",
  files: Object.fromEntries(CONFIGURATION_FILES.map((name) => [name, configurationHash(name.startsWith("cp-") ? "" : name)])),
  createdAt: "2026-10-25T11:00:01.000Z", ...actor,
};
function observation(): Awaited<ReturnType<typeof inspectConfigurationBinding>> {
  return { version: 1, ...scope, namespace: binding.namespace, bindingSha256: configurationHash(JSON.stringify(binding)),
    compiler: CONFIGURATION_COMPILER, baseline: binding.baseline, baseRevision: 0,
    startedAt: "2026-10-25T11:00:01.000Z", observedAt: "2026-10-25T11:00:02.000Z", status: "empty-baseline-observed",
    executorEnabled: false, publicationVerified: false, issues: [],
    queuePolicy: { status: "unsupported", unobservedFields: ["timeout", "joinempty", "leavewhenempty"] },
    disk: { files: { ...binding.files }, expectedFiles: { ...binding.files } },
    loaded: { loadedDialplanSha256: configurationHash(JSON.stringify(EMPTY_PROOF_DIALPLAN)),
      expectedDialplanSha256: configurationHash(JSON.stringify(EMPTY_PROOF_DIALPLAN)),
      loadedQueuesSha256: configurationHash(EMPTY_PROOF_QUEUE), expectedQueuesSha256: configurationHash(EMPTY_PROOF_QUEUE),
      contexts: ["proof", "sip-proof"], queues: ["proof-queue"], reservedContextCount: 0, reservedQueueCount: 0, priorityCount: 18 },
    limitations: "Trusted synthetic test observation; not runtime authorization" };
}
async function fixture(action: (store: ReturnType<typeof openConfigurationStore>, path: string) => Promise<void> | void) {
  const dir = await mkdtemp(join(tmpdir(), "configuration-review-")), path = join(dir, "review.sqlite");
  const store = openConfigurationStore(path);
  try { await action(store, path); } finally { store.close(); await rm(dir, { recursive: true }); }
}
function draft(store: ReturnType<typeof openConfigurationStore>) {
  const d = store.createDraft(scope, '{"schemaVersion":1,"routeId":"inbound","queueId":"waiting","waitSeconds":2}', 0, actor);
  const v = store.validate(scope, d.revision, d.sha256, actor);
  return { d, v };
}

test("CQR-01: review binds full canonical project identity, exact observation and stable baseline separately from sample time", () => {
  const sample = observation(), review = configurationReview(binding, sample);
  assert.equal(review.bindingSha256, configurationHash(JSON.stringify(binding)));
  assert.equal(review.observationSha256, configurationHash(JSON.stringify(sample)));
  const later = { ...sample, observedAt: "2026-10-25T11:01:00.000Z" };
  const next = configurationReview(binding, later);
  assert.notEqual(next.observationSha256, review.observationSha256);
  assert.equal(next.baselineSha256, review.baselineSha256);
  assert.equal(compareConfigurationReview(review, binding, later, scope).status, "reviewed-baseline-matches");
  assert.equal(review.queuePolicyStatus, "unsupported"); assert.equal(review.runtimeApplyAuthorized, false);
});

test("CQR-02: blocked, foreign, mismatched disk and reserved loaded observations cannot be reviewed", () => {
  const sample = observation();
  for (const invalid of [
    { ...sample, status: "blocked" as const },
    { ...sample, customer: "customer-b" },
    { ...sample, namespace: "cp-foreign" },
    { ...sample, loaded: { ...sample.loaded, loadedQueuesSha256: "a".repeat(64), expectedQueuesSha256: "a".repeat(64) } },
    { ...sample, bindingSha256: "c".repeat(64) },
    { ...sample, issues: [{ code: "drift", object: "queues" }] },
    { ...sample, disk: { ...sample.disk, files: { ...sample.disk.files, "cp-queues.conf": configurationHash("drift") } } },
    { ...sample, loaded: { ...sample.loaded, reservedQueueCount: 1 } },
    { ...sample, loaded: { ...sample.loaded, loadedQueuesSha256: "d".repeat(64) } },
  ]) assert.throws(() => configurationReview(binding, invalid));
});

test("CQR-03: recheck rejects changed binding/boot/mount/compiler provenance, changed baseline and older or foreign samples", () => {
  const sample = observation(), review = configurationReview(binding, sample);
  for (const changed of [{ ...binding, startTicks: "99999" }, { ...binding, project: "asterisk-inspection-xyz123" },
    { ...binding, mountSource: "/different" }, { ...binding, containerId: "c".repeat(64) }]) {
    const current = { ...sample, bindingSha256: configurationHash(JSON.stringify(changed)) };
    assert.throws(() => compareConfigurationReview(review, changed, current, scope), /changed/);
  }
  assert.throws(() => compareConfigurationReview(review, binding,
    { ...sample, observedAt: "2026-10-25T10:00:00.000Z" }, scope), /predates/);
  assert.throws(() => compareConfigurationReview(review, binding, sample, { ...scope, runtime: "foreign" }), /scope/);
});

test("CQR-04: malformed review tuple cannot add authority, unknown fields, invalid digest or unsupported policy claims", () => {
  const review = configurationReview(binding, observation());
  for (const invalid of [{}, { ...review, runtimeApplyAuthorized: true }, { ...review, queuePolicyStatus: "verified" },
    { ...review, bindingSha256: "" }, { ...review, version: 2 }, { ...review, paths: ["/foreign"] },
    { ...review, observedAt: "not-a-date" }]) assert.throws(() => parseConfigurationReview(invalid));
});

test("CQR-05: immutable approval durably binds review and exact draft/validation; edits cannot inherit it", async () => {
  await fixture((store, path) => {
    const { d, v } = draft(store), review = configurationReview(binding, observation());
    const a = store.approve(scope, d.revision, d.sha256, v.sha256, actor, review);
    const reader = openConfigurationStore(path, { readOnly: true });
    try { assert.deepEqual(reader.read(scope, 1).approval?.document.inspectionReview, review); }
    finally { reader.close(); }
    assert.equal(a.document.runtimeApplyAuthorized, false);
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor, review), ConfigurationConflict);
    const changed = store.createDraft(scope, '{"schemaVersion":1,"routeId":"inbound","queueId":"waiting","waitSeconds":3}', 0, actor);
    assert.equal(store.read(scope, changed.revision).approval, undefined);
    assert.throws(() => store.approve(scope, changed.revision, changed.sha256, v.sha256, actor, review), ConfigurationConflict);
    assert.equal(store.read(scope, 1).approval?.sha256, a.sha256);
  });
});

test("CQR-06: foreign review and receipt failure cannot insert an approval or move existing validation", async () => {
  await fixture((store, path) => {
    const { d, v } = draft(store), review = configurationReview(binding, observation());
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor, { ...review, customer: "customer-b" }), ConfigurationConflict);
    assert.equal(store.read(scope, 1).approval, undefined);
    const db = new DatabaseSync(path);
    try { db.exec("CREATE TRIGGER fail_review BEFORE INSERT ON configuration_receipts WHEN NEW.kind='approved' BEGIN SELECT RAISE(ABORT,'injected review receipt failure'); END;"); }
    finally { db.close(); }
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor, review), /injected review/);
    assert.equal(store.read(scope, 1).approval, undefined);
    assert.equal(store.read(scope, 1).validation?.sha256, v.sha256);
  });
});

test("CQR-07: unreviewed approvals stay unreviewed and read-only comparison cannot mutate receipt history", async () => {
  await fixture(async (store, path) => {
    const { d, v } = draft(store);
    const a = store.approve(scope, 1, d.sha256, v.sha256, actor);
    assert.equal(a.document.inspectionReview, undefined);
    assert.throws(() => parseConfigurationReview(a.document.inspectionReview));
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor, configurationReview(binding, observation())), ConfigurationConflict);
    const before = await readFile(path);
    compareConfigurationReview(configurationReview(binding, observation()), binding, observation(), scope);
    assert.deepEqual(await readFile(path), before);
  });
});

test("CQR-08: receipt decoding checks review scope and types even after a checksum is recomputed", async () => {
  await fixture((store, path) => {
    const { d, v } = draft(store);
    store.approve(scope, 1, d.sha256, v.sha256, actor, configurationReview(binding, observation()));
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT document FROM configuration_receipts WHERE kind='approved'").get()!;
      const original = JSON.parse(String(row.document));
      for (const change of [{ runtimeApplyAuthorized: true }, { customer: "customer-b" }]) {
        const text = JSON.stringify({ ...original, inspectionReview: { ...original.inspectionReview, ...change } });
        db.prepare("UPDATE configuration_receipts SET document=?,sha256=? WHERE kind='approved'").run(text, configurationHash(text));
        assert.throws(() => store.read(scope, 1));
      }
    } finally { db.close(); }
  });
});
