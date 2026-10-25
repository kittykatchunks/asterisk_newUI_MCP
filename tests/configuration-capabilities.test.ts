import assert from "node:assert/strict";
import { test } from "node:test";
import { captureQueueCapabilities, QUEUE_CAPABILITY_COMMANDS } from "./configuration-inspection/capabilities.ts";
import { configurationHash } from "../src/configuration-model.ts";

function metadata(command: string) {
  if (command === "core show version") return "Asterisk 22.11.0 synthetic offline fixture";
  if (command === "core show help queue") return "queue show -- Show status";
  if (command === "core show functions like QUEUE") return "8 matching custom functions installed.";
  if (command.startsWith("core show function ")) return `Info about Function '${command.slice("core show function ".length)}'`;
  if (command.startsWith("manager show command ")) return `Info about Manager Command '${command.slice("manager show command ".length)}'`;
  if (command === "module show like res_ari") return "0 modules loaded";
  return "HTTP Server Status:\nServer Disabled";
}
test("QPU-01: capability capture uses only the exact finite metadata commands and cannot establish policy truth", async () => {
  const calls: string[] = [];
  const capture = await captureQueueCapabilities(async (command) => { calls.push(command); return metadata(command); });
  assert.deepEqual(calls, [...QUEUE_CAPABILITY_COMMANDS]);
  assert.equal(calls.length, 13); assert.equal(capture.exactPolicyReaderEstablished, false);
  assert.deepEqual(capture.unobservedFields, ["timeout", "joinempty", "leavewhenempty"]);
  assert.equal("runtimeApplyAuthorized" in capture, false);
  for (const item of capture.commands) assert.equal(item.sha256, configurationHash(item.output));
});
test("QPU-02: formatting normalization preserves metadata identity without interpreting absence as unsupported policy proof", async () => {
  const capture = await captureQueueCapabilities(async (command) => `\x1b[1;35m${metadata(command).replaceAll("\n", "\r\n")}\x1b[0m\n`);
  for (const item of capture.commands) assert.equal(item.output, metadata(item.command));
  assert.equal(capture.exactPolicyReaderEstablished, false);
});
test("QPU-03: missing/truncated/unrecognized/oversized or foreign-version metadata fails explicitly", async () => {
  for (const text of ["", "No such command", "x".repeat(65537), "Asterisk 23.0.0 fixture"]) {
    await assert.rejects(captureQueueCapabilities(async () => text));
  }
  await assert.rejects(captureQueueCapabilities(async (command) =>
    command === "manager show command GetConfig" ? "No such command" : metadata(command)));
});
test("QPU-04: failed read aborts the capture and never substitutes an empty or successful inventory", async () => {
  let count = 0;
  await assert.rejects(captureQueueCapabilities(async (command) => {
    if (++count === 3) throw new Error("Synthetic read outage");
    return metadata(command);
  }), /Synthetic read outage/);
  assert.equal(count, 3);
});
