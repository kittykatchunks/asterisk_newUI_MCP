import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertAgentAssignment, createAgentDirectory } from "./agent-directory.ts";
import type { AgentAssignment, AgentDirectory } from "./agent-directory.ts";

export interface AgentStore extends AgentDirectory {
  provision(assignments: readonly AgentAssignment[]): { inserted: number; unchanged: number };
  close(): void;
}

function parseAssignment(row: Record<string, unknown>): AgentAssignment {
  const assignment = { issuer: row.issuer, subject: row.subject, customer: row.customer,
    extension: row.extension, displayName: row.display_name };
  assertAgentAssignment(assignment);
  return assignment;
}

// Operator-only insertions; changing an assignment requires a separate future workflow.
export function openAgentStore(path: string): AgentStore {
  if (!isAbsolute(path)) throw new Error("Agent database requires an absolute local path");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported agent database version");
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
    provision(assignments) {
      createAgentDirectory(assignments);
      const entries = assignments.map(({ issuer, subject, customer, extension, displayName }) =>
        ({ issuer, subject, customer, extension, displayName }));
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
        db.exec("COMMIT");
        return { inserted, unchanged };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close() { db.close(); },
  };
}
