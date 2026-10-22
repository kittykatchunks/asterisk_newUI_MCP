import { build } from "esbuild";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const directory = new URL("../../.local-proof/webrtc/", import.meta.url);
const read = (customer, name) => readFile(new URL(`${customer}/${name}`, directory), "utf8");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./client.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const pins = await Promise.all(["customer-a", "customer-b"].map((customer) => read(customer, "pin.txt")));
const server = createServer({
  cert: await read("customer-a", "cert.pem"),
  key: await read("customer-a", "key.pem"),
}, (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/client.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(bundle.outputFiles[0].text);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Local WebRTC proof</title><h1>Engineering WebRTC proof</h1><pre id="status">Loading</pre><script src="/client.js"></script></html>');
  } else {
    response.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      `--ignore-certificate-errors-spki-list=${pins.map((pin) => pin.trim()).join(",")}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTPS address");
  for (const [customer, port] of [["customer-a", 18089], ["customer-b", 28089]]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`https://127.0.0.1:${address.port}/`);
      await page.waitForFunction(() => typeof window.runProof === "function");
      let timer;
      try {
        await Promise.race([
          page.evaluate(
            (config) => window.runProof(config),
            { port, password: (await read(customer, "password.txt")).trim() },
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${customer}: browser proof exceeded 60 seconds`)), 60000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const result = await page.evaluate(() => window.proofResult);
      if (errors.length || result.state !== "passed") {
        throw new Error(`${customer}: ${JSON.stringify(result)} ${errors.join("; ")}`);
      }
      console.log(`PASS ${customer}: ${JSON.stringify(result.stats)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
