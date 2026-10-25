import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("agent-mode identity preflight preserves exact IDs and refuses missing, foreign or duplicate fixture data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-preflight-"));
  const execute = promisify(execFile);
  const script = fileURLToPath(new URL("../scripts/Read-ProofAgentSubjects.ps1", import.meta.url));
  const command = "$ErrorActionPreference = 'Stop'; & $env:AGENT_PREFLIGHT_SCRIPT -Root $env:AGENT_PREFLIGHT_ROOT -IdentityOnly:($env:SIMULATION_IDENTITY_ONLY -eq 'true') | ConvertTo-Json -Compress";
  const run = (identityOnly = false) => execute("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    timeout: 10000, env: { ...process.env, AGENT_PREFLIGHT_SCRIPT: script, AGENT_PREFLIGHT_ROOT: directory,
      SIMULATION_IDENTITY_ONLY: String(identityOnly) },
  });
  const accounts = [
    { username: "alice", customer: "customer-a", subject: randomUUID() },
    { username: "bob", customer: "customer-b", subject: randomUUID() },
  ];
  const identity = join(directory, ".local-proof", "identity");
  const engineering = join(directory, ".local-proof", "engineering");
  try {
    await mkdir(identity, { recursive: true });
    const path = join(identity, "accounts.json");
    await writeFile(path, JSON.stringify(accounts));
    assert.deepEqual(JSON.parse((await run(true)).stdout), { alice: accounts[0].subject, bob: accounts[1].subject },
      "Simulation-only preflight preserves identities without an assignment database");
    await assert.rejects(run(), /existing operator-provisioned/);
    await mkdir(engineering);
    // This preflight checks presence only; the trusted readonly store validates the schema on startup.
    await writeFile(join(engineering, "agents.sqlite"), "");
    const original = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse((await run()).stdout), { alice: accounts[0].subject, bob: accounts[1].subject });
    assert.equal(await readFile(path, "utf8"), original, "Preflight must never rewrite identities or credentials");
    for (const value of [
      [], [accounts[0]], [accounts[0], accounts[0]],
      [accounts[0], { ...accounts[1], subject: accounts[0].subject }],
      [accounts[0], { ...accounts[1], customer: "customer-a" }],
      [accounts[0], { ...accounts[1], subject: "invalid" }],
      [accounts[0], { ...accounts[1], username: "Bob" }],
    ]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(run(), /requires the existing|refuses invalid/);
      await assert.rejects(run(true), /requires the existing|refuses invalid/);
    }
    await writeFile(path, "{");
    await assert.rejects(run(), /JSON/);
    await rm(path);
    await assert.rejects(run(), /does not exist/);
  } finally { await rm(directory, { recursive: true }); }
});
