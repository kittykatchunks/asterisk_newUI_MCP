import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface CommandBase {
  version: 1;
  operationId: string;
  customer: string;
  epoch: string;
  revision: number;
  leaseId: string;
  notAfter: number;
}

export type AgentProvisioningCommand = CommandBase & (
  { action: "prepare"; payload: { generationId: string; extension: string } } |
  { action: "activate" | "extend" | "drain" | "revoke"; payload: { generationId: string } }
);

export interface ProvisioningContext {
  requestId: string;
  actor: string;
  reason: string;
}

export interface ProvisioningIntent {
  command: AgentProvisioningCommand;
  sha256: string;
  acceptedAt: number;
  context: ProvisioningContext;
}

export interface ProvisioningReceipt {
  receiptId: string;
  sequence: number;
  stage: "applying" | "verified" | "failed" | "uncertain";
  code: string;
}

export interface AgentProvisioningStore {
  enrol(customer: string, epoch: string): void;
  enqueue(command: AgentProvisioningCommand, context: ProvisioningContext): ProvisioningIntent;
  operation(customer: string, operationId: string): { intent: ProvisioningIntent; receipts: ProvisioningReceipt[] } | undefined;
  pending(customer: string, limit?: number): ProvisioningIntent[];
  record(customer: string, operationId: string, receipt: ProvisioningReceipt): void;
  close(): void;
}

export class AgentProvisioningConflict extends Error {}

export interface AgentProvisioningJournal {
  accept(command: AgentProvisioningCommand, context: ProvisioningContext): ProvisioningIntent;
  operation(operationId: string): ReturnType<AgentProvisioningStore["operation"]>;
  next(): { state: "idle" } | {
    state: "ready" | "expired" | "reconcile" | "blocked";
    intent: ProvisioningIntent;
    receipts: ProvisioningReceipt[];
  };
  record(operationId: string, receipt: ProvisioningReceipt): void;
  close(): void;
}

export interface ProvisioningJournalBinding {
  customer: string;
  epoch: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Invalid provisioning fields");
  }
}
function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("Invalid provisioning UUID");
}
function assertCustomer(customer: string) {
  if (!slug.test(customer)) throw new Error("Invalid provisioning customer");
}
function canonicalCommand(input: unknown): AgentProvisioningCommand {
  exact(input, ["version", "operationId", "customer", "epoch", "revision", "leaseId", "notAfter", "action", "payload"]);
  assertUuid(input.operationId); assertUuid(input.epoch); assertUuid(input.leaseId);
  if (input.version !== 1 || typeof input.customer !== "string" || !slug.test(input.customer) ||
      typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      typeof input.notAfter !== "number" || !Number.isSafeInteger(input.notAfter) || input.notAfter < 1 ||
      !["prepare", "activate", "extend", "drain", "revoke"].includes(String(input.action))) {
    throw new Error("Invalid provisioning command");
  }
  const payload = input.payload;
  exact(payload, input.action === "prepare" ? ["generationId", "extension"] : ["generationId"]);
  assertUuid(payload.generationId);
  if (input.action === "prepare" && (typeof payload.extension !== "string" || !/^[0-9]{1,16}$/.test(payload.extension))) {
    throw new Error("Invalid provisioning extension");
  }
  const base: CommandBase = {
    version: 1, operationId: input.operationId, customer: input.customer, epoch: input.epoch,
    revision: input.revision, leaseId: input.leaseId, notAfter: input.notAfter,
  };
  if (input.action === "prepare" && typeof payload.extension === "string") {
    return { ...base, action: "prepare", payload: { generationId: payload.generationId, extension: payload.extension } };
  }
  if (input.action === "activate" || input.action === "extend" || input.action === "drain" || input.action === "revoke") {
    return { ...base, action: input.action, payload: { generationId: payload.generationId } };
  }
  throw new Error("Invalid provisioning action");
}
function context(input: ProvisioningContext): ProvisioningContext {
  exact(input, ["requestId", "actor", "reason"]);
  assertUuid(input.requestId);
  if (![input.actor, input.reason].every((value) => typeof value === "string" && value.trim() && !/[\x00-\x1f\x7f]/.test(value)) ||
      input.actor.length > 200 || input.reason.length > 2000) throw new Error("Invalid provisioning audit context");
  return { requestId: input.requestId, actor: input.actor, reason: input.reason };
}
function canonicalReceipt(input: ProvisioningReceipt): ProvisioningReceipt {
  exact(input, ["receiptId", "sequence", "stage", "code"]);
  assertUuid(input.receiptId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
      !["applying", "verified", "failed", "uncertain"].includes(input.stage) ||
      typeof input.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.code)) {
    throw new Error("Invalid provisioning receipt");
  }
  return { receiptId: input.receiptId, sequence: input.sequence, stage: input.stage, code: input.code };
}

// Trusted backend persistence only: callers must authenticate and verify ownership before enqueue.
export function openAgentProvisioningStore(path: string, options: { now?: () => number } = {}): AgentProvisioningStore {
  return openProvisioningStorage(path, options).store;
}

export function openAgentProvisioningJournal(path: string, binding: ProvisioningJournalBinding,
  options: { now?: () => number } = {}): AgentProvisioningJournal {
  exact(binding, ["customer", "epoch"]);
  assertCustomer(binding.customer); assertUuid(binding.epoch);
  return openProvisioningStorage(path, options, { ...binding }).journal;
}

function openProvisioningStorage(path: string, options: { now?: () => number },
  binding?: ProvisioningJournalBinding) {
  if (!isAbsolute(path)) throw new Error("Provisioning database requires an absolute local path");
  const clock = options.now ?? Date.now;
  function now() {
    const time = clock();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid provisioning clock");
    return time;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported provisioning database version");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error("Refusing to initialise a nonempty unversioned provisioning database");
      }
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE provisioning_authorities (
          customer TEXT PRIMARY KEY, epoch TEXT NOT NULL, revision INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE provisioning_intents (
          operation_id TEXT PRIMARY KEY, customer TEXT NOT NULL, epoch TEXT NOT NULL,
          revision INTEGER NOT NULL, command TEXT NOT NULL, sha256 TEXT NOT NULL,
          accepted_at INTEGER NOT NULL, context TEXT NOT NULL,
          UNIQUE(customer, epoch, revision)
        ) STRICT;
        CREATE TABLE provisioning_receipts (
          receipt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
          sequence INTEGER NOT NULL, receipt TEXT NOT NULL, UNIQUE(operation_id, sequence)
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    db.prepare("SELECT customer, epoch, revision FROM provisioning_authorities LIMIT 0");
    db.prepare("SELECT operation_id, customer, epoch, revision, command, sha256, accepted_at, context FROM provisioning_intents LIMIT 0");
    db.prepare("SELECT receipt_id, operation_id, sequence, receipt FROM provisioning_receipts LIMIT 0");
    const hasBinding = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provisioning_worker_binding'").get();
    if (!binding && hasBinding) throw new Error("Worker journal cannot be opened as a backend provisioning store");
    if (binding) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Recheck under the writer lock so competing first opens cannot choose different bindings.
        const exists = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provisioning_worker_binding'").get();
        if (!exists) {
          if (db.prepare("SELECT 1 FROM provisioning_authorities LIMIT 1").get() ||
              db.prepare("SELECT 1 FROM provisioning_intents LIMIT 1").get() ||
              db.prepare("SELECT 1 FROM provisioning_receipts LIMIT 1").get()) {
            throw new Error("Refusing to repurpose a backend provisioning database as a worker journal");
          }
          db.exec("CREATE TABLE provisioning_worker_binding (id INTEGER PRIMARY KEY CHECK (id = 1), customer TEXT NOT NULL, epoch TEXT NOT NULL) STRICT");
          db.prepare("INSERT INTO provisioning_worker_binding VALUES (1, ?, ?)").run(binding.customer, binding.epoch);
          db.prepare("INSERT INTO provisioning_authorities VALUES (?, ?, 0)").run(binding.customer, binding.epoch);
        }
        const rows = db.prepare("SELECT id, customer, epoch FROM provisioning_worker_binding").all();
        const authorities = db.prepare("SELECT customer, epoch FROM provisioning_authorities").all();
        if (rows.length !== 1 || rows[0].id !== 1 || rows[0].customer !== binding.customer || rows[0].epoch !== binding.epoch ||
            authorities.length !== 1 || authorities[0].customer !== binding.customer || authorities[0].epoch !== binding.epoch) {
          throw new AgentProvisioningConflict("Worker journal customer or authority binding mismatch");
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  } catch (error) { db.close(); throw error; }
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function read(customer: string, id: string): ProvisioningIntent | undefined {
    const row = db.prepare("SELECT * FROM provisioning_intents WHERE customer = ? AND operation_id = ?").get(customer, id);
    if (!row) return undefined;
    if (typeof row.command !== "string" || typeof row.context !== "string" ||
        typeof row.accepted_at !== "number" || !Number.isSafeInteger(row.accepted_at) || row.accepted_at < 0) {
      throw new Error("Invalid stored provisioning intent");
    }
    const command = canonicalCommand(JSON.parse(row.command));
    const recordedContext = context(JSON.parse(row.context));
    if (JSON.stringify(command) !== row.command || hash(row.command) !== row.sha256 ||
        command.customer !== customer || command.operationId !== id || command.epoch !== row.epoch ||
        command.revision !== row.revision || command.notAfter <= row.accepted_at ||
        JSON.stringify(recordedContext) !== row.context) throw new Error("Stored provisioning intent mismatch");
    return { command, sha256: hash(row.command), acceptedAt: row.accepted_at, context: recordedContext };
  }
  function receipts(id: string) {
    const rows = db.prepare("SELECT * FROM provisioning_receipts WHERE operation_id = ? ORDER BY sequence").all(id);
    let previous: ProvisioningReceipt | undefined;
    return rows.map((row) => {
      if (typeof row.receipt !== "string") throw new Error("Invalid stored provisioning receipt");
      const receipt = canonicalReceipt(JSON.parse(row.receipt));
      if (JSON.stringify(receipt) !== row.receipt || receipt.receiptId !== row.receipt_id ||
          receipt.sequence !== row.sequence) throw new Error("Stored provisioning receipt mismatch");
      transition(previous, receipt);
      previous = receipt;
      return receipt;
    });
  }
  function transition(previous: ProvisioningReceipt | undefined, next: ProvisioningReceipt) {
    const permitted = !previous ? ["applying", "uncertain"] :
      previous.stage === "applying" ? ["verified", "failed", "uncertain"] :
      previous.stage === "uncertain" ? ["applying", "verified", "failed"] : [];
    if (next.sequence !== (previous?.sequence ?? 0) + 1 || !permitted.includes(next.stage)) {
      throw new AgentProvisioningConflict("Invalid provisioning receipt transition");
    }
  }
  function persistReceipt(customer: string, id: string, receipt: ProvisioningReceipt) {
    if (!read(customer, id)) throw new AgentProvisioningConflict("Provisioning operation not found");
    const json = JSON.stringify(receipt);
    const history = receipts(id);
    const existing = history.find((entry) => entry.receiptId === receipt.receiptId);
    if (existing) {
      if (JSON.stringify(existing) !== json) throw new AgentProvisioningConflict("Provisioning receipt conflict");
      return;
    }
    transition(history.at(-1), receipt);
    db.prepare("INSERT INTO provisioning_receipts VALUES (?, ?, ?, ?)").run(receipt.receiptId, id, receipt.sequence, json);
  }
  function head(customer: string) {
    let expectedRevision = 1;
    for (const row of db.prepare("SELECT operation_id FROM provisioning_intents WHERE customer = ? ORDER BY revision").iterate(customer)) {
      if (typeof row.operation_id !== "string") throw new Error("Invalid stored provisioning operation ID");
      const intent = read(customer, row.operation_id);
      if (!intent || intent.command.revision !== expectedRevision++ ||
          (binding && intent.command.epoch !== binding.epoch)) throw new Error("Worker journal revision or authority mismatch");
      const history = receipts(row.operation_id);
      if (history.at(-1)?.stage !== "verified") return { intent, receipts: history };
    }
    const authority = db.prepare("SELECT revision FROM provisioning_authorities WHERE customer = ?").get(customer);
    if (!authority || authority.revision !== expectedRevision - 1) throw new Error("Worker journal revision gap");
    return undefined;
  }
  const store: AgentProvisioningStore = {
    enrol(customer, epoch) {
      assertCustomer(customer); assertUuid(epoch);
      transaction(() => {
        const row = db.prepare("SELECT epoch FROM provisioning_authorities WHERE customer = ?").get(customer);
        if (row && row.epoch !== epoch) throw new AgentProvisioningConflict("Provisioning authority already enrolled; epoch rotation is not implemented");
        if (!row) db.prepare("INSERT INTO provisioning_authorities VALUES (?, ?, 0)").run(customer, epoch);
      });
    },
    enqueue(input, auditContext) {
      const command = canonicalCommand(input);
      const recordedContext = context(auditContext);
      const json = JSON.stringify(command);
      return transaction(() => {
        const existing = read(command.customer, command.operationId);
        if (existing) {
          if (existing.sha256 !== hash(json)) throw new AgentProvisioningConflict("Provisioning operation payload conflict");
          return existing;
        }
        const authority = db.prepare("SELECT epoch, revision FROM provisioning_authorities WHERE customer = ?").get(command.customer);
        if (!authority || authority.epoch !== command.epoch) throw new AgentProvisioningConflict("Provisioning authority mismatch");
        if (typeof authority.revision !== "number" || !Number.isSafeInteger(authority.revision) || authority.revision < 0) {
          throw new Error("Invalid stored provisioning revision");
        }
        if (command.revision !== authority.revision + 1) throw new AgentProvisioningConflict("Provisioning revision out of order");
        const acceptedAt = now();
        if (command.notAfter <= acceptedAt) throw new AgentProvisioningConflict("Provisioning authorisation expired");
        db.prepare("INSERT INTO provisioning_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(command.operationId, command.customer, command.epoch, command.revision, json, hash(json), acceptedAt, JSON.stringify(recordedContext));
        db.prepare("UPDATE provisioning_authorities SET revision = ? WHERE customer = ?").run(command.revision, command.customer);
        return { command, sha256: hash(json), acceptedAt, context: recordedContext };
      });
    },
    operation(customer, id) {
      assertCustomer(customer); assertUuid(id);
      return transaction(() => {
        const intent = read(customer, id);
        return intent ? { intent, receipts: receipts(id) } : undefined;
      });
    },
    pending(customer, limit = 100) {
      assertCustomer(customer);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid provisioning pending limit");
      return transaction(() => {
        const result: ProvisioningIntent[] = [];
        for (const row of db.prepare("SELECT operation_id FROM provisioning_intents WHERE customer = ? ORDER BY revision").iterate(customer)) {
          if (typeof row.operation_id !== "string") throw new Error("Invalid stored provisioning operation ID");
          const intent = read(customer, row.operation_id);
          if (!intent) throw new Error("Stored provisioning operation missing");
          const last = receipts(row.operation_id).at(-1);
          if (last?.stage !== "verified" && last?.stage !== "failed") result.push(intent);
          if (result.length === limit) break;
        }
        return result;
      });
    },
    record(customer, id, input) {
      assertCustomer(customer); assertUuid(id);
      const receipt = canonicalReceipt(input);
      transaction(() => persistReceipt(customer, id, receipt));
    },
    close() { db.close(); },
  };
  const journal: AgentProvisioningJournal = {
    accept(command, auditContext) {
      if (!binding) throw new Error("Worker journal binding required");
      if (command.customer !== binding.customer || command.epoch !== binding.epoch) {
        throw new AgentProvisioningConflict("Worker command customer or authority mismatch");
      }
      return store.enqueue(command, auditContext);
    },
    operation(id) {
      if (!binding) throw new Error("Worker journal binding required");
      return store.operation(binding.customer, id);
    },
    next() {
      if (!binding) throw new Error("Worker journal binding required");
      return transaction(() => {
        const time = now();
        const first = head(binding.customer);
        if (!first) return { state: "idle" };
        const stage = first.receipts.at(-1)?.stage;
        const state = stage === "failed" ? "blocked" : stage ? "reconcile" :
          first.intent.command.notAfter <= time ? "expired" : "ready";
        return { state, ...first };
      });
    },
    record(id, input) {
      if (!binding) throw new Error("Worker journal binding required");
      assertUuid(id);
      const receipt = canonicalReceipt(input);
      transaction(() => {
        const history = receipts(id);
        if (history.some((entry) => entry.receiptId === receipt.receiptId)) {
          persistReceipt(binding.customer, id, receipt);
          return;
        }
        const first = head(binding.customer);
        if (!first || first.intent.command.operationId !== id) throw new AgentProvisioningConflict("Worker operation is not the ordered head");
        if (receipt.stage === "applying" && first.intent.command.notAfter <= now()) {
          throw new AgentProvisioningConflict("Worker operation authorisation expired");
        }
        persistReceipt(binding.customer, id, receipt);
      });
    },
    close() { store.close(); },
  };
  return { store, journal };
}
