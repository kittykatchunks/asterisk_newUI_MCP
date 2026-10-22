import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { localEngineeringRoot } from "../../src/local-engineering.ts";

export async function createFixtureSipSocket(customer: string) {
  assert.ok(customer === "customer-a" || customer === "customer-b");
  const script = await readFile(join(localEngineeringRoot, "tests", "identity", "fixture-sip-socket.py"), "utf8");
  const child = spawn("docker", ["compose", "-f", join(localEngineeringRoot, "compose.status-proof.yaml"),
    "exec", "-T", customer, "python3", "-u", "-c", script], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let port = 0;
  let closing = false;
  let failure: Error | undefined;
  class FixtureSocket extends EventEmitter {
    address() { return { port }; }
    send(packet: Buffer | string, destination: number, host: string, callback: (error: Error | null) => void) {
      if (failure) { callback(failure); return; }
      child.stdin.write(JSON.stringify({ packet: Buffer.from(packet).toString("base64"), port: destination, host }) + "\n",
        (error) => callback(error ?? null));
    }
    async close() {
      closing = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        lines.close();
        assert.fail("Owned SIP fixture bridge already exited unexpectedly");
      }
      const exited = once(child, "exit");
      const timer = setTimeout(() => child.kill(), 3000);
      child.stdin.end();
      try {
        const [code, signal] = await exited;
        assert.equal(code, 0, `Owned SIP fixture bridge must exit cleanly (${signal ?? "no signal"})`);
        assert.equal(failure, undefined);
      } finally { clearTimeout(timer); lines.close(); }
    }
  }
  const socket = new FixtureSocket();
  const fail = (error: Error) => { socket.emit("error", error); };
  // Keep failures available to the next send/close even between SIP transactions.
  socket.on("error", (error: Error) => { failure = error; });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", () => fail(new Error("Owned SIP fixture bridge reported an error")));
  child.on("exit", (code) => {
    if (!closing) fail(new Error(`Owned SIP fixture bridge exited unexpectedly (${code})`));
  });
  lines.on("line", (line: string) => {
    const message = JSON.parse(line);
    assert.ok(message && typeof message === "object", "Invalid owned SIP fixture bridge message");
    if ("ready" in message) {
      assert.ok(Number.isInteger(message.ready) && message.ready > 0 && message.ready <= 65535);
      port = message.ready;
      socket.emit("ready");
    } else {
      assert.ok(typeof message.packet === "string" && message.packet.length <= 87384);
      assert.equal(message.port, 5060);
      assert.equal(message.address, "127.0.0.1");
      socket.emit("message", Buffer.from(message.packet, "base64"), { port: message.port, address: message.address });
    }
  });
  const timer = setTimeout(() => {
    fail(new Error("Owned SIP fixture bridge startup timed out"));
    child.kill();
  }, 5000);
  try { await once(socket, "ready"); }
  catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
  finally { clearTimeout(timer); }
  return socket;
}
