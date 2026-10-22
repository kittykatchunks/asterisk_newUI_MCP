import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentProvisioningAdapter } from "../../src/agent-provisioning-executor.ts";
import type { AgentProvisioningExpiryAdapter } from "../../src/agent-provisioning-expiry.ts";
import type { ProvisioningJournalBinding } from "../../src/agent-provisioning-store.ts";

// Test-only, deliberately one generation slot per customer; never a PBX adapter.
export function openFakeProvisioningRuntime(path: string, input: ProvisioningJournalBinding,
  options: { now?: () => number } = {}) {
  if (!isAbsolute(path)) throw new Error("Fake runtime requires an absolute path");
  const binding = { ...input };
  const clock = options.now ?? Date.now;
  const db = new DatabaseSync(path);
  const transaction = <T>(action: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA synchronous = FULL");
    transaction(() => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        db.exec(`CREATE TABLE fake_binding (customer TEXT, epoch TEXT) STRICT;
          CREATE TABLE fake_generations (
            id TEXT PRIMARY KEY, extension TEXT NOT NULL, deadline INTEGER NOT NULL,
            phase TEXT NOT NULL, dialogs INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE fake_effects (operation_id TEXT PRIMARY KEY, command TEXT NOT NULL) STRICT;`);
        db.prepare("INSERT INTO fake_binding VALUES (?, ?)").run(binding.customer, binding.epoch);
      }
      const rows = db.prepare("SELECT customer, epoch FROM fake_binding").all();
      if (rows.length !== 1 || rows[0].customer !== binding.customer || rows[0].epoch !== binding.epoch) {
        throw new Error("Fake runtime binding mismatch");
      }
    });
  } catch (error) { db.close(); throw error; }
  const now = () => {
    const time = clock();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid fake runtime clock");
    return time;
  };
  const generation = (id: string) => {
    const row = db.prepare("SELECT * FROM fake_generations WHERE id = ?").get(id);
    if (!row || typeof row.id !== "string" || typeof row.extension !== "string" ||
        typeof row.deadline !== "number" || !Number.isSafeInteger(row.deadline) || row.deadline < 1 ||
        typeof row.phase !== "string" || !["prepared", "active", "draining", "removed"].includes(row.phase) ||
        typeof row.dialogs !== "number" || !Number.isSafeInteger(row.dialogs) || row.dialogs < -1) {
      throw new Error("Invalid or missing fake generation");
    }
    return { generationId: row.id, extension: row.extension, notAfter: row.deadline,
      phase: row.phase, dialogs: row.dialogs };
  };
  const revoke = (id: string) => {
    const row = generation(id);
    if (row.phase === "removed" && row.dialogs === 0) return;
    if (row.phase !== "draining" || row.dialogs !== 0) throw new Error("Fake removal requires drained zero-dialog state");
    db.prepare("UPDATE fake_generations SET phase = 'removed' WHERE id = ?").run(id);
  };
  const execution: AgentProvisioningAdapter = {
    async apply(command, signal) {
      signal.throwIfAborted();
      transaction(() => {
        if (command.customer !== binding.customer || command.epoch !== binding.epoch) throw new Error("Fake command scope mismatch");
        const json = JSON.stringify(command);
        const effect = db.prepare("SELECT command FROM fake_effects WHERE operation_id = ?").get(command.operationId);
        if (effect) {
          if (typeof effect.command !== "string" || !isDeepStrictEqual(JSON.parse(effect.command), command)) {
            throw new Error("Fake operation conflict");
          }
          return;
        }
        if (command.notAfter <= now()) throw new Error("Fake command expired");
        const id = command.payload.generationId;
        if (command.action === "prepare") {
          if (db.prepare("SELECT 1 FROM fake_generations WHERE phase != 'removed' LIMIT 1").get()) {
            throw new Error("Fake replacement blocked by existing generation");
          }
          db.prepare("INSERT INTO fake_generations VALUES (?, ?, ?, 'prepared', 0)")
            .run(id, command.payload.extension, command.notAfter);
        } else {
          const row = generation(id);
          if (command.action === "activate" || command.action === "extend") {
            if (row.notAfter <= now() || !["prepared", "active"].includes(row.phase) ||
                command.notAfter < row.notAfter) throw new Error("Fake generation cannot activate or extend");
            db.prepare("UPDATE fake_generations SET phase = ?, deadline = ? WHERE id = ?")
              .run(command.action === "activate" ? "active" : row.phase, command.notAfter, id);
          } else if (command.action === "drain") {
            if (row.phase === "removed") throw new Error("Fake generation already removed");
            db.prepare("UPDATE fake_generations SET phase = 'draining' WHERE id = ?").run(id);
          } else revoke(id);
        }
        signal.throwIfAborted();
        db.prepare("INSERT INTO fake_effects VALUES (?, ?)").run(command.operationId, json);
      });
    },
    async observe(command, signal) {
      signal.throwIfAborted();
      if (command.customer !== binding.customer || command.epoch !== binding.epoch) throw new Error("Fake observation scope mismatch");
      const effect = db.prepare("SELECT command FROM fake_effects WHERE operation_id = ?").get(command.operationId);
      if (!effect) return "unknown";
      if (typeof effect.command !== "string" || !isDeepStrictEqual(JSON.parse(effect.command), command)) {
        throw new Error("Fake observation conflict");
      }
      return "verified";
    },
  };
  const expiry: AgentProvisioningExpiryAdapter = {
    async inventory(signal) {
      signal.throwIfAborted();
      return db.prepare("SELECT id FROM fake_generations WHERE phase != 'removed' ORDER BY id").all().map((row) => {
        const state = generation(String(row.id));
        return { generationId: state.generationId, notAfter: state.notAfter, draining: state.phase === "draining" };
      });
    },
    async fence(id, signal) {
      signal.throwIfAborted();
      transaction(() => {
        const state = generation(id);
        if (state.phase !== "removed") db.prepare("UPDATE fake_generations SET phase = 'draining' WHERE id = ?").run(id);
      });
    },
    async observe(id, signal) {
      signal.throwIfAborted();
      const state = generation(id);
      return { newCallsBlocked: state.phase !== "active",
        dialogs: state.dialogs === -1 ? "unknown" : state.dialogs, removed: state.phase === "removed" };
    },
    async revoke(id, signal) { signal.throwIfAborted(); transaction(() => revoke(id)); },
  };
  return {
    execution, expiry, generation,
    startCall(id: string) {
      transaction(() => {
        const state = generation(id);
        if (state.phase !== "active" || state.notAfter <= now() || state.dialogs < 0) throw new Error("Fake new call denied");
        db.prepare("UPDATE fake_generations SET dialogs = dialogs + 1 WHERE id = ?").run(id);
      });
    },
    setDialogs(id: string, dialogs: number | "unknown") {
      transaction(() => {
        const state = generation(id);
        if (state.phase === "removed" || (dialogs !== "unknown" && (!Number.isSafeInteger(dialogs) || dialogs < 0))) {
          throw new Error("Invalid fake dialog observation");
        }
        db.prepare("UPDATE fake_generations SET dialogs = ? WHERE id = ?").run(dialogs === "unknown" ? -1 : dialogs, id);
      });
    },
    effectCount() { return db.prepare("SELECT count(*) AS count FROM fake_effects").get()?.count; },
    close() { db.close(); },
  };
}
