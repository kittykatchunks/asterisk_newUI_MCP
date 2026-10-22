import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { createAmiStatusSource } from "../src/pbx-status.ts";

test("AMI status uses fixed actions, matching IDs and bounded responses without returning credentials", async () => {
  const actions: string[] = [];
  let mode = "success";
  const server = createServer((socket) => {
    socket.write("Asterisk Call Manager/11.0.0\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 4);
        const action = /^Action: (.+)$/m.exec(frame)?.[1].trim();
        const id = /^ActionID: (.+)$/m.exec(frame)?.[1].trim();
        assert.ok(id);
        actions.push(action ?? "");
        if (mode === "timeout") continue;
        if (mode === "close") { socket.end(); continue; }
        if (mode === "large") { socket.write("x".repeat(65537)); continue; }
        if (mode === "denied") {
          socket.write(`Response: Error\r\nActionID: ${id}\r\nMessage: private-secret\r\n\r\n`); continue;
        }
        if (action === "Login") {
          assert.match(frame, /Events: off/);
          assert.match(frame, /Username: status-reader/);
          assert.match(frame, /Secret: private-secret/);
          socket.write(`Response: Success\r\nActionID: ${id}\r\n\r\n`);
        } else {
          assert.equal(action, "CoreStatus");
          socket.write("Event: Ignored\r\nActionID: unrelated\r\n\r\n");
          socket.write(`Response: Success\r\nActionID: ${id}\r\nCoreStartupDate: 2026-10-22\r\n`);
          socket.write(`CoreStartupTime: 12:30:00\r\nCoreCurrentCalls: ${mode === "invalid" ? "-1" : "2"}\r\n\r\n`);
        }
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ECONNRESET", "Only a client cancellation may interrupt this fixture socket");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = { customer: "customer-a", host: "127.0.0.1", port: address.port,
    username: "status-reader", secret: "private-secret", tls: false };
  const source = createAmiStatusSource([connection]);
  connection.secret = "later mutation";
  try {
    const result = await source.status("customer-a");
    assert.deepEqual({ ...result, checkedAt: "" }, {
      customer: "customer-a", checkedAt: "", coreStartedAtLocal: "2026-10-22 12:30:00", activeCalls: 2,
    });
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.deepEqual(actions, ["Login", "CoreStatus"]);
    assert.ok(!JSON.stringify(result).includes("private"));
    await assert.rejects(source.status("customer-b"), /not configured/);
    for (const failure of ["denied", "invalid", "large", "close"]) {
      mode = failure;
      await assert.rejects(source.status("customer-a"), (error: Error) =>
        /PBX/.test(error.message) && !error.message.includes("private"));
    }
    mode = "timeout";
    const started = Date.now();
    const held = source.status("customer-a");
    await assert.rejects(source.status("customer-a"), /already in progress/);
    await assert.rejects(held, /timed out/);
    assert.ok(Date.now() - started >= 3000);
    mode = "success";
    assert.equal((await source.status("customer-a")).activeCalls, 2);
    for (const bad of [
      { ...connection, host: "example.invalid" }, { ...connection, secret: "x\r\nAction: Command" },
      { ...connection, port: 0 }, { ...connection, customer: "../customer" },
    ]) assert.throws(() => createAmiStatusSource([bad]), /Invalid/);
    assert.throws(() => createAmiStatusSource([connection, connection]), /Invalid/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
