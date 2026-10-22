import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

if (!process.argv[2]) throw new Error("Provide the generated report.html path");
const url = pathToFileURL(resolve(process.argv[2])).href;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(url);
  const total = await page.locator("#packets tbody tr").count();
  assert.ok(total >= 8);
  await page.getByRole("status").filter({ hasText: `${total} of ${total}` }).waitFor();
  const dialogs = await page.locator("#dialog-filter option").allTextContents();
  assert.ok(dialogs.length >= 2);
  await page.getByLabel("Dialog", { exact: true }).selectOption({ label: dialogs[1] });
  const selected = await page.locator("#dialog-filter").inputValue();
  assert.deepEqual(
    [...new Set(await page.locator("#packets tbody tr:visible").evaluateAll(
      (rows) => rows.map((row) => row.dataset.dialog)))], [selected],
  );
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Message filter").fill("sip 401");
  const challenges = await page.locator("#packets tbody tr:visible").count();
  assert.ok(challenges > 0 && challenges < total);
  await page.locator("#packets tbody tr:visible summary").first().click();
  await page.locator("#packets tbody tr:visible details[open] p").first().waitFor();
  await page.getByLabel("Message filter").fill("no-such-message");
  await page.getByText("No packets match these filters.", { exact: true }).waitFor();
  assert.equal(await page.locator("#packets tbody tr:visible").count(), 0);
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("#packets tbody tr:visible").count(), total);
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Reset filters" }).click();
  assert.equal(await page.locator("#packets tbody tr:visible").count(), total);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [url]);
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  try {
    const fallback = await noScript.newPage();
    await fallback.goto(url);
    assert.equal(await fallback.locator("#packets tbody tr:visible").count(), total);
  } finally { await noScript.close(); }
  console.log(`PASS report UI: ${total} packets; dialog/message filters, expansion, empty/reset, complete print, no-JS fallback, no external requests`);
} finally {
  await browser.close();
}
