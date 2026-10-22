import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:tls";
import { promisify } from "node:util";
import { createAmiStatusSource } from "../src/pbx-status.ts";

const directory = process.env.ASTERISK_TEST_AMI_TLS_DIRECTORY;
const run = promisify(execFile);

test("AMI TLS authenticates the peer before sending credentials or fixed actions", {
  skip: !directory ? "Run scripts\\Test-AmiTlsProof.ps1 to generate isolated certificates and trust" : false,
}, async () => {
  assert.ok(directory);
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0", "TLS proof requires normal certificate verification");
  const trust = process.env.NODE_EXTRA_CA_CERTS;
  assert.equal(trust, join(directory, "trusted.pem"), "Trust must be installed before Node starts");
  for (const mode of ["valid", "untrusted", "mismatch", "expired"]) {
    const certificate = mode === "untrusted" ? "valid" : mode;
    const actions: string[] = [];
    let applicationBytes = 0;
    const server = createServer({
      cert: await readFile(join(directory, `${certificate}-cert.pem`)),
      key: await readFile(join(directory, `${certificate}-key.pem`)),
    }, (socket) => {
      let buffer = "";
      socket.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
      socket.on("data", (chunk: Buffer) => {
        applicationBytes += chunk.length;
        buffer += chunk.toString("utf8");
        let boundary: number;
        while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 4);
          const action = /^Action: (.+)$/m.exec(frame)?.[1].trim();
          const id = /^ActionID: (.+)$/m.exec(frame)?.[1].trim();
          assert.ok(id);
          actions.push(action ?? "");
          if (action === "Login") {
            assert.match(frame, /Secret: tls-test-only/);
            socket.write(`Response: Success\r\nActionID: ${id}\r\n\r\n`);
          } else if (action === "CoreStatus") {
            socket.write(`Response: Success\r\nActionID: ${id}\r\nCoreStartupDate: 2026-10-22\r\nCoreStartupTime: 12:30:00\r\nCoreCurrentCalls: 0\r\n\r\n`);
          } else {
            assert.equal(action, "PJSIPShowEndpoints");
            socket.write(`Response: Success\r\nActionID: ${id}\r\nEventList: start\r\n\r\n` +
              `Event: EndpointListComplete\r\nActionID: ${id}\r\nEventList: Complete\r\nListItems: 0\r\n\r\n`);
          }
        }
      });
    });
    const tlsErrors: Error[] = [];
    server.on("tlsClientError", (error) => tlsErrors.push(error));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = { customer: "customer-a", host: "127.0.0.1", port: address.port,
      username: "tls-reader", secret: "tls-test-only", tls: true };
    try {
      if (mode === "valid") {
        const source = createAmiStatusSource([config]);
        assert.equal((await source.status("customer-a")).activeCalls, 0);
        assert.deepEqual((await source.endpoints("customer-a")).endpoints, []);
        assert.deepEqual(actions, ["Login", "CoreStatus", "Login", "PJSIPShowEndpoints"]);
        assert.deepEqual(tlsErrors, []);
      } else {
        const env: NodeJS.ProcessEnv = { ...process.env, AMI_TLS_CONFIG: JSON.stringify(config) };
        if (mode === "untrusted") delete env.NODE_EXTRA_CA_CERTS;
        const worker = `
          import assert from "node:assert/strict";
          import { once } from "node:events";
          import { connect } from "node:tls";
          import { createAmiStatusSource } from "./src/pbx-status.ts";
          const config = JSON.parse(process.env.AMI_TLS_CONFIG);
          const socket = connect({ host: config.host, port: config.port, rejectUnauthorized: true });
          socket.setTimeout(3000, () => socket.destroy(new Error("TLS diagnostic timed out")));
          try {
            await assert.rejects(once(socket, "secureConnect"),
              (error) => error.code === ${JSON.stringify(mode === "untrusted" ? "DEPTH_ZERO_SELF_SIGNED_CERT"
                : mode === "mismatch" ? "ERR_TLS_CERT_ALTNAME_INVALID" : "CERT_HAS_EXPIRED")});
          } finally { socket.destroy(); }
          const source = createAmiStatusSource([config]);
          for (const method of ["status", "endpoints", "status"]) {
            await assert.rejects(source[method]("customer-a"),
              (error) => error.message === "PBX status connection failed");
          }
        `;
        await run(process.execPath, ["--input-type=module", "--eval", worker], { env, timeout: 15000 });
        assert.equal(applicationBytes, 0, `${mode}: no credentials or AMI data may be transmitted`);
        assert.deepEqual(actions, []);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});
