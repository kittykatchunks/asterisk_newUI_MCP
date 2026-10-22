import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { openAgentStore } from "./agent-store.ts";

interface AgentBackupManifest {
  version: 1;
  schema: 2;
  createdAt: string;
  sha256: string;
  assignments: number;
  receipts: number;
}

function absolute(...paths: string[]) {
  if (!paths.every(isAbsolute)) throw new Error("Agent backup paths must be absolute local paths");
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function inspect(path: string) {
  const store = openAgentStore(path, { readOnly: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0].integrity_check !== "ok") throw new Error("Agent backup integrity check failed");
    let assignments = 0;
    for (const row of db.prepare("SELECT issuer, subject, customer FROM agent_assignments").iterate()) {
      if (typeof row.issuer !== "string" || typeof row.subject !== "string" || typeof row.customer !== "string" ||
          !store.profile(row.issuer, row.subject, row.customer)) throw new Error("Invalid agent backup assignment");
      assignments++;
    }
    let receipts = 0;
    for (const row of db.prepare("SELECT id FROM agent_provision_receipts").iterate()) {
      if (typeof row.id !== "string" || !store.receipt(row.id)) throw new Error("Invalid agent backup receipt");
      receipts++;
    }
    return { assignments, receipts };
  } finally { db?.close(); store.close(); }
}

function manifest(value: unknown): AgentBackupManifest {
  if (typeof value !== "object" || value === null ||
      !("version" in value) || value.version !== 1 || !("schema" in value) || value.schema !== 2 ||
      !("createdAt" in value) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      !("sha256" in value) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !("assignments" in value) || typeof value.assignments !== "number" ||
      !Number.isSafeInteger(value.assignments) || value.assignments < 0 ||
      !("receipts" in value) || typeof value.receipts !== "number" ||
      !Number.isSafeInteger(value.receipts) || value.receipts < 0) throw new Error("Invalid agent backup manifest");
  return { version: 1, schema: 2, createdAt: value.createdAt, sha256: value.sha256,
    assignments: value.assignments, receipts: value.receipts };
}

export async function backupAgentStore(sourcePath: string, parentDirectory: string): Promise<string> {
  absolute(sourcePath, parentDirectory);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(parentDirectory, "agent-backup-"));
    const path = join(directory, "agents.sqlite");
    await backup(source, path);
    const counts = inspect(path);
    const record: AgentBackupManifest = { version: 1, schema: 2,
      createdAt: new Date().toISOString(), sha256: await digest(path), ...counts };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(record) + "\n", { flag: "wx" });
    return directory;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true });
    throw error;
  } finally { source.close(); }
}

export async function restoreAgentStore(backupDirectory: string, parentDirectory: string): Promise<string> {
  absolute(backupDirectory, parentDirectory);
  const record = manifest(JSON.parse(await readFile(join(backupDirectory, "manifest.json"), "utf8")));
  const directory = await mkdtemp(join(parentDirectory, "agent-restore-"));
  try {
    const path = join(directory, "agents.sqlite");
    await copyFile(join(backupDirectory, "agents.sqlite"), path, constants.COPYFILE_EXCL);
    if (await digest(path) !== record.sha256) throw new Error("Agent backup checksum mismatch");
    const counts = inspect(path);
    if (counts.assignments !== record.assignments || counts.receipts !== record.receipts) {
      throw new Error("Agent backup manifest count mismatch");
    }
    return path;
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}
