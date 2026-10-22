import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertAgentIdentity } from "./agent-directory.ts";
import type { AgentIdentity } from "./agent-directory.ts";

export interface AgentDeviceOwner extends AgentIdentity {
  sessionId: string;
  sessionExpiresAt: number;
  deviceId: string;
}

export interface AgentDeviceLease {
  id: string;
  expiresAt: number;
}

export class AgentDeviceLeaseError extends Error {
  readonly code: "device_lease_conflict" | "device_lease_not_owned" | "device_session_expired";

  constructor(code: AgentDeviceLeaseError["code"]) {
    super(code);
    this.code = code;
    this.name = "AgentDeviceLeaseError";
  }
}

export interface AgentDeviceLeaseStore {
  current(owner: AgentDeviceOwner, leaseId: string): AgentDeviceLease;
  acquire(owner: AgentDeviceOwner): AgentDeviceLease;
  renew(owner: AgentDeviceOwner, leaseId: string): AgentDeviceLease;
  release(owner: AgentDeviceOwner, leaseId: string): void;
  close(): void;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const leaseDuration = 60000;

// Trusted backend primitive, not an authentication or SIP-authorisation boundary.
export function openAgentDeviceLeaseStore(path: string, options: { now?: () => number } = {}): AgentDeviceLeaseStore {
  if (!isAbsolute(path)) throw new Error("Device lease database requires an absolute local path");
  const now = options.now ?? Date.now;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported device lease database version");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error("Refusing to initialise a nonempty unversioned device lease database");
      }
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE agent_device_leases (
          issuer TEXT NOT NULL, subject TEXT NOT NULL, customer TEXT NOT NULL,
          id TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL, device_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (issuer, subject, customer)
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    db.prepare("SELECT issuer, subject, customer, id, session_hash, device_id, expires_at FROM agent_device_leases LIMIT 0");
  } catch (error) { db.close(); throw error; }
  const find = db.prepare("SELECT * FROM agent_device_leases WHERE issuer = ? AND subject = ? AND customer = ?");
  function validate(owner: AgentDeviceOwner) {
    assertAgentIdentity(owner);
    if (!/^[A-Za-z0-9_-]{43}$/.test(owner.sessionId) || !uuid.test(owner.deviceId) ||
        !Number.isSafeInteger(owner.sessionExpiresAt) || owner.sessionExpiresAt <= 0) {
      throw new Error("Invalid device lease owner");
    }
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + leaseDuration)) {
      throw new Error("Invalid device lease clock");
    }
    if (owner.sessionExpiresAt <= time) throw new AgentDeviceLeaseError("device_session_expired");
    return { time, hash: createHash("sha256").update(owner.sessionId).digest("hex") };
  }
  function read(owner: AgentDeviceOwner) {
    const row = find.get(owner.issuer, owner.subject, owner.customer);
    if (!row) return undefined;
    if (typeof row.id !== "string" || !uuid.test(row.id) ||
        typeof row.session_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.session_hash) ||
        typeof row.device_id !== "string" || !uuid.test(row.device_id) ||
        typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) || row.expires_at <= 0) {
      throw new Error("Invalid stored device lease");
    }
    return { id: row.id, hash: row.session_hash, deviceId: row.device_id, expiresAt: row.expires_at };
  }
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function owned(owner: AgentDeviceOwner, id: string, hash: string, time: number) {
    if (!uuid.test(id)) throw new Error("Invalid device lease ID");
    const lease = read(owner);
    if (!lease || lease.id !== id || lease.hash !== hash || lease.deviceId !== owner.deviceId || lease.expiresAt <= time) {
      throw new AgentDeviceLeaseError("device_lease_not_owned");
    }
    return lease;
  }
  return {
    current(owner, id) {
      const { time, hash } = validate(owner);
      const lease = owned(owner, id, hash, time);
      return { id: lease.id, expiresAt: Math.min(lease.expiresAt, owner.sessionExpiresAt) };
    },
    acquire(owner) {
      return transaction(() => {
        const { time, hash } = validate(owner);
        const existing = read(owner);
        if (existing && existing.expiresAt > time) {
          if (existing.hash !== hash || existing.deviceId !== owner.deviceId) {
            throw new AgentDeviceLeaseError("device_lease_conflict");
          }
          const expiresAt = Math.min(existing.expiresAt, owner.sessionExpiresAt);
          if (expiresAt !== existing.expiresAt) {
            db.prepare("UPDATE agent_device_leases SET expires_at = ? WHERE id = ?").run(expiresAt, existing.id);
          }
          return { id: existing.id, expiresAt };
        }
        const lease = { id: randomUUID(), expiresAt: Math.min(time + leaseDuration, owner.sessionExpiresAt) };
        db.prepare(`INSERT INTO agent_device_leases
          (issuer, subject, customer, id, session_hash, device_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (issuer, subject, customer) DO UPDATE SET
          id = excluded.id, session_hash = excluded.session_hash, device_id = excluded.device_id, expires_at = excluded.expires_at`)
          .run(owner.issuer, owner.subject, owner.customer, lease.id, hash, owner.deviceId, lease.expiresAt);
        return lease;
      });
    },
    renew(owner, id) {
      return transaction(() => {
        const { time, hash } = validate(owner);
        const lease = owned(owner, id, hash, time);
        const expiresAt = Math.min(time + leaseDuration, owner.sessionExpiresAt);
        db.prepare("UPDATE agent_device_leases SET expires_at = ? WHERE id = ?").run(expiresAt, lease.id);
        return { id: lease.id, expiresAt };
      });
    },
    release(owner, id) {
      transaction(() => {
        const { time, hash } = validate(owner);
        const lease = owned(owner, id, hash, time);
        db.prepare("DELETE FROM agent_device_leases WHERE id = ?").run(lease.id);
      });
    },
    close() { db.close(); },
  };
}
