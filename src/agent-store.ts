import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { assertAgentAssignment, createAgentDirectory } from "./agent-directory.ts";
import type { AgentAssignment, AgentDirectory } from "./agent-directory.ts";

export interface AgentStore extends AgentDirectory {
  provision(assignments: readonly AgentAssignment[], context: AgentProvisionContext): AgentProvisionReceipt;
  receipt(id: string): RecordedAgentProvision | undefined;
  close(): void;
}

export interface AgentProvisionContext {
  operator: string;
  reason: string;
}

export interface AgentProvisionReceipt {
  id: string;
  timestamp: string;
  sha256: string;
  inserted: number;
  unchanged: number;
}

export interface RecordedAgentProvision extends AgentProvisionReceipt, AgentProvisionContext {
  assignments: AgentAssignment[];
}

function assertProvisionContext(context: AgentProvisionContext) {
  if (!context || ![context.operator, context.reason].every((value) =>
    typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)) ||
      context.operator.length > 200 || context.reason.length > 2000) {
    throw new Error("Agent provisioning requires a bounded operator and reason");
  }
}

function parseAssignment(row: Record<string, unknown>): AgentAssignment {
  const assignment = { issuer: row.issuer, subject: row.subject, customer: row.customer,
    extension: row.extension, displayName: row.display_name };
  assertAgentAssignment(assignment);
  return assignment;
}

// Operator-only insertions; changing an assignment requires a separate future workflow.
export function openAgentStore(path: string, options: { readOnly?: boolean } = {}): AgentStore {
  if (!isAbsolute(path)) throw new Error("Agent database requires an absolute local path");
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  try {
    db.exec("PRAGMA busy_timeout = 250;");
    if (!options.readOnly) db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported agent database version");
    if (options.readOnly && version !== 2) throw new Error("Read-only agent store requires schema version 2; migrate with the trusted writer first");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error("Refusing to initialise a nonempty unversioned agent database");
      }
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE agent_assignments (
          issuer TEXT NOT NULL, subject TEXT NOT NULL, customer TEXT NOT NULL,
          extension TEXT NOT NULL, display_name TEXT NOT NULL,
          PRIMARY KEY (issuer, subject, customer)
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    db.prepare("SELECT issuer, subject, customer, extension, display_name FROM agent_assignments LIMIT 0");
    if (version === 0 || version === 1) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE agent_provision_receipts (
          id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, operator TEXT NOT NULL,
          reason TEXT NOT NULL, sha256 TEXT NOT NULL, inserted INTEGER NOT NULL,
          unchanged INTEGER NOT NULL, assignments TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 2;
        COMMIT;`);
    }
    db.prepare("SELECT id, timestamp, operator, reason, sha256, inserted, unchanged, assignments FROM agent_provision_receipts LIMIT 0");
  } catch (error) { db.close(); throw error; }
  const find = db.prepare("SELECT issuer, subject, customer, extension, display_name FROM agent_assignments WHERE issuer = ? AND subject = ? AND customer = ?");
  const insert = db.prepare("INSERT INTO agent_assignments (issuer, subject, customer, extension, display_name) VALUES (?, ?, ?, ?, ?)");
  return {
    profile(issuer, subject, customer) {
      const row = find.get(issuer, subject, customer);
      if (!row) return undefined;
      const assignment = parseAssignment(row);
      if (assignment.issuer !== issuer || assignment.subject !== subject || assignment.customer !== customer) {
        throw new Error("Stored agent assignment scope mismatch");
      }
      return { extension: assignment.extension, displayName: assignment.displayName };
    },
    provision(assignments, context) {
      assertProvisionContext(context);
      createAgentDirectory(assignments);
      const entries = assignments.map(({ issuer, subject, customer, extension, displayName }) =>
        ({ issuer, subject, customer, extension, displayName }));
      const json = JSON.stringify(entries);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const sha256 = createHash("sha256").update(json).digest("hex");
      let inserted = 0;
      let unchanged = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const assignment of entries) {
          const existing = find.get(assignment.issuer, assignment.subject, assignment.customer);
          if (existing) {
            const recorded = parseAssignment(existing);
            if (recorded.extension !== assignment.extension || recorded.displayName !== assignment.displayName) {
              throw new Error("Agent assignment already exists with different provisioned values");
            }
            unchanged++;
          } else {
            insert.run(assignment.issuer, assignment.subject, assignment.customer, assignment.extension, assignment.displayName);
            inserted++;
          }
        }
        db.prepare(`INSERT INTO agent_provision_receipts
          (id, timestamp, operator, reason, sha256, inserted, unchanged, assignments)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, timestamp, context.operator, context.reason, sha256, inserted, unchanged, json);
        db.exec("COMMIT");
        return { id, timestamp, sha256, inserted, unchanged };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    receipt(id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        throw new Error("Invalid agent provisioning receipt ID");
      }
      const row = db.prepare("SELECT * FROM agent_provision_receipts WHERE id = ?").get(id);
      if (!row) return undefined;
      if (row.id !== id || typeof row.timestamp !== "string" ||
          !Number.isFinite(Date.parse(row.timestamp)) || new Date(row.timestamp).toISOString() !== row.timestamp ||
          typeof row.operator !== "string" || typeof row.reason !== "string" ||
          typeof row.assignments !== "string" || typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
          createHash("sha256").update(row.assignments).digest("hex") !== row.sha256 ||
          typeof row.inserted !== "number" || !Number.isSafeInteger(row.inserted) || row.inserted < 0 ||
          typeof row.unchanged !== "number" || !Number.isSafeInteger(row.unchanged) || row.unchanged < 0) {
        throw new Error("Invalid stored agent provisioning receipt");
      }
      const context = { operator: row.operator, reason: row.reason };
      assertProvisionContext(context);
      const value: unknown = JSON.parse(row.assignments);
      if (!Array.isArray(value)) throw new Error("Invalid stored agent provisioning assignments");
      const assignments: AgentAssignment[] = value.map((item: unknown) => {
        assertAgentAssignment(item);
        const { issuer, subject, customer, extension, displayName } = item;
        return { issuer, subject, customer, extension, displayName };
      });
      createAgentDirectory(assignments);
      if (JSON.stringify(assignments) !== row.assignments || row.inserted + row.unchanged !== assignments.length) {
        throw new Error("Agent provisioning receipt batch mismatch");
      }
      return { id, timestamp: row.timestamp, sha256: row.sha256,
        inserted: row.inserted, unchanged: row.unchanged, ...context, assignments };
    },
    close() { db.close(); },
  };
}
