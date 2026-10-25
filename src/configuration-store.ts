import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compileConfiguration, configurationHash, configurationObject, configurationScope,
  parseConfigurationModel, type ConfigurationScope } from "./configuration-model.ts";

export class ConfigurationConflict extends Error {}
export interface ConfigurationOperator { operator: string; reason: string }
export interface ConfigurationDraft {
  scope: ConfigurationScope; revision: number; baseRevision: number; createdAt: string; attribution: ConfigurationOperator;
  compiled: ReturnType<typeof compileConfiguration>; sha256: string;
}
const applicationId = 0x43504644;
function context(value: ConfigurationOperator): ConfigurationOperator {
  for (const [text, max] of [[value.operator, 200], [value.reason, 2000]] as const) {
    if (typeof text !== "string" || !text.trim() || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw new Error("Invalid bounded configuration operator/reason");
  }
  return { operator: value.operator, reason: value.reason };
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return integer(value) && value > 0; }
function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function operationId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid configuration operation UUID");
}
export function openConfigurationStore(path: string, options: { readOnly?: boolean } = {}) {
  if (!isAbsolute(path)) throw new Error("Configuration store requires an absolute dedicated database path");
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
    if (!options.readOnly) db.exec("PRAGMA synchronous=FULL;");
    db.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const identity = db.prepare("PRAGMA application_id").get()?.application_id;
      if (version === 0 && identity === 0 && !options.readOnly &&
          !db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        db.exec(`CREATE TABLE configuration_drafts (
          customer TEXT NOT NULL, runtime TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, sha256 TEXT NOT NULL,
          PRIMARY KEY(customer,runtime,revision)
        ) STRICT;
        CREATE TABLE configuration_receipts (
          sequence INTEGER PRIMARY KEY, customer TEXT NOT NULL, runtime TEXT NOT NULL, revision INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('validated','approved')), document TEXT NOT NULL, sha256 TEXT NOT NULL,
          UNIQUE(customer,runtime,revision,kind),
          FOREIGN KEY(customer,runtime,revision) REFERENCES configuration_drafts(customer,runtime,revision)
        ) STRICT;
        CREATE TABLE configuration_operations (
          customer TEXT NOT NULL, runtime TEXT NOT NULL, operation_id TEXT NOT NULL, revision INTEGER NOT NULL,
          document TEXT NOT NULL, sha256 TEXT NOT NULL,
          PRIMARY KEY(customer,runtime,operation_id),
          FOREIGN KEY(customer,runtime,revision) REFERENCES configuration_drafts(customer,runtime,revision)
        ) STRICT;
        CREATE TABLE configuration_operation_events (
          sequence INTEGER PRIMARY KEY, customer TEXT NOT NULL, runtime TEXT NOT NULL, operation_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('claimed','uncertain','cancelled-before-effects')),
          document TEXT NOT NULL, sha256 TEXT NOT NULL,
          FOREIGN KEY(customer,runtime,operation_id) REFERENCES configuration_operations(customer,runtime,operation_id)
        ) STRICT;
        CREATE TABLE configuration_claims (
          customer TEXT NOT NULL, runtime TEXT NOT NULL, operation_id TEXT NOT NULL,
          PRIMARY KEY(customer,runtime),
          FOREIGN KEY(customer,runtime,operation_id) REFERENCES configuration_operations(customer,runtime,operation_id)
        ) STRICT;
        PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);
      } else if (version !== 1 || identity !== applicationId) throw new Error("Not a supported offline configuration database");
      for (const sql of [
        "SELECT customer,runtime,revision,document,sha256 FROM configuration_drafts LIMIT 0",
        "SELECT sequence,customer,runtime,revision,kind,document,sha256 FROM configuration_receipts LIMIT 0",
        "SELECT customer,runtime,operation_id,revision,document,sha256 FROM configuration_operations LIMIT 0",
        "SELECT sequence,customer,runtime,operation_id,state,document,sha256 FROM configuration_operation_events LIMIT 0",
        "SELECT customer,runtime,operation_id FROM configuration_claims LIMIT 0",
      ]) db.prepare(sql);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (!options.readOnly) db.exec("PRAGMA journal_mode=DELETE;");
  } catch (error) { db.close(); throw error; }
  function transaction<T>(action: () => T): T {
    if (options.readOnly) throw new Error("Configuration mutation requires a writable store");
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function snapshot<T>(action: () => T): T {
    if (db.isTransaction) return action();
    db.exec("BEGIN");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function unpack(row: Record<string, unknown>) {
    if (typeof row.document !== "string" || Buffer.byteLength(row.document) > 32768 || !digest(row.sha256) ||
        configurationHash(row.document) !== row.sha256) throw new Error("Corrupt configuration document checksum");
    const value: unknown = JSON.parse(row.document); configurationObject(value); return value;
  }
  function draft(scope: ConfigurationScope, revision: number): ConfigurationDraft {
    configurationScope(scope); if (!positive(revision)) throw new Error("Invalid draft revision");
    const row = db.prepare("SELECT * FROM configuration_drafts WHERE customer=? AND runtime=? AND revision=?")
      .get(scope.customer, scope.runtime, revision);
    if (!row) throw new ConfigurationConflict("Configuration draft not found for scope/revision");
    const value = unpack(row);
    configurationObject(value.scope); configurationObject(value.attribution); configurationObject(value.compiled);
    if (value.scope.customer !== scope.customer || value.scope.runtime !== scope.runtime || value.revision !== revision ||
        !integer(value.baseRevision) || value.baseRevision !== 0 || !timestamp(value.createdAt) ||
        typeof value.attribution.operator !== "string" || typeof value.attribution.reason !== "string") {
      throw new Error("Corrupt offline configuration draft");
    }
    const attribution = context({ operator: value.attribution.operator, reason: value.attribution.reason });
    const compiled = compileConfiguration(scope, value.compiled.model, revision);
    if (JSON.stringify(compiled) !== JSON.stringify(value.compiled)) throw new Error("Corrupt configuration compiler output");
    if (JSON.stringify({ scope: { customer: scope.customer, runtime: scope.runtime }, revision, baseRevision: value.baseRevision,
      createdAt: value.createdAt, attribution, compiled }) !== row.document) throw new Error("Corrupt configuration draft shape");
    return { scope: { ...scope }, revision, baseRevision: value.baseRevision, createdAt: value.createdAt,
      attribution, compiled, sha256: String(row.sha256) };
  }
  function receipt(scope: ConfigurationScope, revision: number, kind: "validated" | "approved") {
    const row = db.prepare("SELECT * FROM configuration_receipts WHERE customer=? AND runtime=? AND revision=? AND kind=?")
      .get(scope.customer, scope.runtime, revision, kind);
    if (!row) return undefined;
    const value = unpack(row), d = draft(scope, revision);
    configurationObject(value.attribution);
    if (value.draftSha256 !== d.sha256 || value.kind !== kind || value.revision !== revision ||
        value.customer !== scope.customer || value.runtime !== scope.runtime || !timestamp(value.createdAt) ||
        typeof value.attribution.operator !== "string" || typeof value.attribution.reason !== "string") throw new Error("Corrupt configuration receipt binding");
    context({ operator: value.attribution.operator, reason: value.attribution.reason });
    if (!positive(row.sequence)) throw new Error("Corrupt receipt sequence");
    if (kind === "validated" && (value.compiler !== d.compiled.compiler || value.modelSha256 !== d.compiled.modelSha256 ||
        value.dialplanSha256 !== d.compiled.dialplanSha256 || value.queuesSha256 !== d.compiled.queuesSha256 ||
        value.runtimeValidated !== false || JSON.stringify(value.diff) !== JSON.stringify({
          baseline: "empty-uninspected", addedDialplan: d.compiled.dialplan, addedQueues: d.compiled.queues,
        }))) throw new Error("Corrupt configuration validation");
    if (kind === "approved") {
      const validation = receipt(scope, revision, "validated");
      if (!validation || value.validationSha256 !== validation.sha256 ||
          value.sameAuthorPermitted !== true || value.sameAuthor !== (value.attribution.operator === d.attribution.operator) ||
          value.runtimeApplyAuthorized !== false || value.identityBasis !== "trusted-local-operator-reference") throw new Error("Corrupt configuration approval");
    }
    return { sequence: Number(row.sequence), document: value, sha256: String(row.sha256) };
  }
  function insertReceipt(d: ConfigurationDraft, kind: "validated" | "approved", attribution: ConfigurationOperator,
    extra: Record<string, unknown>) {
    const scope = d.scope;
    if (receipt(scope, d.revision, kind)) throw new ConfigurationConflict(`Configuration ${kind} receipt already exists`);
    const text = JSON.stringify({ kind, customer: scope.customer, runtime: scope.runtime, revision: d.revision,
      draftSha256: d.sha256, createdAt: new Date().toISOString(), attribution: context(attribution), ...extra });
    db.prepare("INSERT INTO configuration_receipts(customer,runtime,revision,kind,document,sha256) VALUES(?,?,?,?,?,?)")
      .run(scope.customer, scope.runtime, d.revision, kind, text, configurationHash(text));
    return receipt(scope, d.revision, kind)!;
  }
  function operation(scope: ConfigurationScope, id: string) {
    configurationScope(scope); operationId(id);
    const row = db.prepare("SELECT * FROM configuration_operations WHERE customer=? AND runtime=? AND operation_id=?")
      .get(scope.customer, scope.runtime, id);
    if (!row) return undefined;
    const intent = unpack(row);
    if (intent.customer !== scope.customer || intent.runtime !== scope.runtime || intent.operationId !== id ||
        !positive(intent.revision) || intent.revision !== row.revision || !timestamp(intent.createdAt) ||
        intent.executorEnabled !== false || intent.baseRevision !== 0) throw new Error("Corrupt configuration operation");
    const d = draft(scope, intent.revision), approval = receipt(scope, d.revision, "approved");
    if (!approval || intent.approvalSha256 !== approval.sha256 || intent.draftSha256 !== d.sha256) throw new Error("Corrupt operation approval");
    configurationObject(intent.attribution);
    if (typeof intent.attribution.operator !== "string" || typeof intent.attribution.reason !== "string") throw new Error("Corrupt operation attribution");
    context({ operator: intent.attribution.operator, reason: intent.attribution.reason });
    const rows = db.prepare("SELECT * FROM configuration_operation_events WHERE customer=? AND runtime=? AND operation_id=? ORDER BY sequence LIMIT 3")
      .all(scope.customer, scope.runtime, id);
    if (rows.length < 1 || rows.length > 2) throw new Error("Corrupt offline operation event count");
    const events = rows.map((r, i) => {
      const e = unpack(r);
      configurationObject(e.attribution);
      if (e.operationSha256 !== row.sha256 || e.state !== r.state || !timestamp(e.createdAt) ||
          typeof e.attribution.operator !== "string" || typeof e.attribution.reason !== "string" ||
          (i === 0 ? e.state !== "claimed" : e.state !== "uncertain" && e.state !== "cancelled-before-effects")) throw new Error("Corrupt configuration operation event");
      context({ operator: e.attribution.operator, reason: e.attribution.reason });
      return { sequence: Number(r.sequence), document: e, sha256: String(r.sha256) };
    });
    const state = events.at(-1)!.document.state;
    const claim = db.prepare("SELECT operation_id FROM configuration_claims WHERE customer=? AND runtime=?")
      .get(scope.customer, scope.runtime);
    if ((state !== "cancelled-before-effects" && claim?.operation_id !== id) ||
        (state === "cancelled-before-effects" && claim?.operation_id === id)) throw new Error("Corrupt operation claim");
    return { intent, sha256: String(row.sha256), state, events };
  }
  function event(scope: ConfigurationScope, id: string, hash: string, state: string, attribution: ConfigurationOperator) {
    const text = JSON.stringify({ operationSha256: hash, state, createdAt: new Date().toISOString(), attribution: context(attribution) });
    db.prepare("INSERT INTO configuration_operation_events(customer,runtime,operation_id,state,document,sha256) VALUES(?,?,?,?,?,?)")
      .run(scope.customer, scope.runtime, id, state, text, configurationHash(text));
  }
  return {
    createDraft(scope: ConfigurationScope, modelText: string, baseRevision: number, attribution: ConfigurationOperator) {
      configurationScope(scope); const model = parseConfigurationModel(modelText); const actor = context(attribution);
      if (baseRevision !== 0) throw new ConfigurationConflict("Offline foundation has no verified publication; expected base must be zero");
      return transaction(() => {
        const maximum = db.prepare("SELECT MAX(revision) AS revision FROM configuration_drafts WHERE customer=? AND runtime=?")
          .get(scope.customer, scope.runtime)?.revision;
        if (maximum !== null && !integer(maximum)) throw new Error("Corrupt draft sequence");
        const revision = (maximum ?? 0) + 1;
        if (!positive(revision)) throw new Error("Configuration revision exhausted");
        const text = JSON.stringify({ scope: { customer: scope.customer, runtime: scope.runtime }, revision, baseRevision,
          createdAt: new Date().toISOString(), attribution: actor, compiled: compileConfiguration(scope, model, revision) });
        db.prepare("INSERT INTO configuration_drafts VALUES(?,?,?,?,?)")
          .run(scope.customer, scope.runtime, revision, text, configurationHash(text));
        return draft(scope, revision);
      });
    },
    read(scope: ConfigurationScope, revision: number) {
      return snapshot(() => ({ draft: draft(scope, revision), validation: receipt(scope, revision, "validated"),
        approval: receipt(scope, revision, "approved"), runtimeStatus: "not-inspected" as const, executorEnabled: false as const }));
    },
    validate(scope: ConfigurationScope, revision: number, hash: string, attribution: ConfigurationOperator) {
      return transaction(() => {
        const d = draft(scope, revision);
        if (hash !== d.sha256) throw new ConfigurationConflict("Draft hash does not match");
        return insertReceipt(d, "validated", attribution, {
          compiler: d.compiled.compiler, modelSha256: d.compiled.modelSha256,
          dialplanSha256: d.compiled.dialplanSha256, queuesSha256: d.compiled.queuesSha256,
          impact: "Synthetic route and empty queue only; no disk/runtime inspection, namespace collision check or apply",
          diff: { baseline: "empty-uninspected", addedDialplan: d.compiled.dialplan, addedQueues: d.compiled.queues },
          runtimeValidated: false,
        });
      });
    },
    approve(scope: ConfigurationScope, revision: number, hash: string, validationHash: string, attribution: ConfigurationOperator) {
      return transaction(() => {
        const d = draft(scope, revision), validation = receipt(scope, revision, "validated");
        if (hash !== d.sha256 || !validation || validation.sha256 !== validationHash) throw new ConfigurationConflict("Exact validated draft required");
        return insertReceipt(d, "approved", attribution, { validationSha256: validation.sha256,
          sameAuthorPermitted: true, sameAuthor: attribution.operator === d.attribution.operator,
          identityBasis: "trusted-local-operator-reference", runtimeApplyAuthorized: false });
      });
    },
    claim(scope: ConfigurationScope, revision: number, approvalHash: string, baseRevision: number, id: string, attribution: ConfigurationOperator) {
      configurationScope(scope); operationId(id); const actor = context(attribution);
      return transaction(() => {
        const existing = operation(scope, id);
        if (existing) {
          if (existing.intent.revision !== revision || existing.intent.approvalSha256 !== approvalHash ||
              existing.intent.baseRevision !== baseRevision || JSON.stringify(existing.intent.attribution) !== JSON.stringify(actor)) {
            throw new ConfigurationConflict("Operation ID is bound to another intent");
          }
          return { ...existing, reused: true };
        }
        const d = draft(scope, revision), approval = receipt(scope, revision, "approved");
        if (!approval || approvalHash !== approval.sha256 || baseRevision !== d.baseRevision) throw new ConfigurationConflict("Approved base/revision required");
        if (db.prepare("SELECT 1 FROM configuration_claims WHERE customer=? AND runtime=?").get(scope.customer, scope.runtime)) {
          throw new ConfigurationConflict("Configuration operation already active; explicit reconciliation required");
        }
        const text = JSON.stringify({ customer: scope.customer, runtime: scope.runtime, operationId: id, revision,
          baseRevision, draftSha256: d.sha256, approvalSha256: approvalHash, createdAt: new Date().toISOString(),
          attribution: actor, executorEnabled: false });
        const hash = configurationHash(text);
        db.prepare("INSERT INTO configuration_operations VALUES(?,?,?,?,?,?)")
          .run(scope.customer, scope.runtime, id, revision, text, hash);
        db.prepare("INSERT INTO configuration_claims VALUES(?,?,?)").run(scope.customer, scope.runtime, id);
        event(scope, id, hash, "claimed", actor);
        return { ...operation(scope, id)!, reused: false };
      });
    },
    finishOffline(scope: ConfigurationScope, id: string, state: "uncertain" | "cancelled-before-effects", attribution: ConfigurationOperator) {
      return transaction(() => {
        const op = operation(scope, id);
        if (!op || op.state !== "claimed" || (state !== "uncertain" && state !== "cancelled-before-effects")) {
          throw new ConfigurationConflict("Only a claimed offline operation can transition once");
        }
        event(scope, id, op.sha256, state, attribution);
        if (state === "cancelled-before-effects") db.prepare("DELETE FROM configuration_claims WHERE customer=? AND runtime=? AND operation_id=?")
          .run(scope.customer, scope.runtime, id);
        return operation(scope, id)!;
      });
    },
    operation(scope: ConfigurationScope, id: string) { return snapshot(() => operation(scope, id)); },
    close() { db.close(); },
  };
}
