// @ts-check
export {};
const customer = location.pathname.match(/^\/engineering\/history\/([a-z0-9][a-z0-9-]{0,63})$/)?.[1];
if (!customer) throw new Error("Invalid history workspace path");
/** @param {string} id */
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing history element ${id}`);
  return node;
}
element("customer").textContent = customer;
element("sign-in").setAttribute("href", `/auth/login?customer=${customer}&workspace=history`);
let csrf = "", runtime = "", epoch = "", revision = "latest";
let scopeAfter = 0, revisionAfter = 0, deadline = 0, generation = 0, busy = false;
let requestReference = "unavailable";
let controller = new AbortController();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function clearEvidence() {
  for (const id of ["freshness", "warnings", "observations", "references"]) element(id).textContent = "";
}
/** @param {string} message */
function end(message) {
  generation++; controller.abort(); controller = new AbortController(); clearTimeout(timer);
  csrf = ""; deadline = 0; runtime = ""; epoch = ""; revision = "latest"; busy = false;
  clearEvidence(); element("scope-list").replaceChildren(); element("revision-list").replaceChildren();
  element("status").textContent = "";
  element("selection").textContent = ""; element("workspace").hidden = true;
  element("sign-out").hidden = true; element("sign-in").hidden = false;
  element("session-status").textContent = message;
}
function expiry() {
  clearTimeout(timer);
  if (deadline <= Date.now()) end("Session expired. Sign in again.");
  else timer = setTimeout(expiry, deadline - Date.now());
}
/** @param {string} path */
async function request(path) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: controller.signal,
    headers: csrf ? { "X-CSRF-Token": csrf } : {} });
  const ref = response.headers.get("X-Request-Id") ?? "unavailable";
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) end(`Session or history access lost (${response.status}); reference ${ref}. Sign in again.`);
    throw new Error(`History request failed (${response.status}); reference ${ref}.`);
  }
  const value = await response.json();
  if (!object(value)) throw new Error(`Invalid response; reference ${ref}.`);
  requestReference = ref;
  return value;
}
/** @param {() => Promise<void>} action */
async function run(action) {
  if (busy) return;
  busy = true; const started = generation; clearEvidence();
  element("workspace").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await action();
    if (started === generation) element("status").textContent =
      `Read completed; reference ${requestReference}. Local evidence only; completeness unverified.`;
  }
  catch (error) {
    if (started === generation) {
      clearEvidence(); element("status").setAttribute("role", "alert");
      element("status").textContent = error instanceof Error ? error.message : "History read failed.";
    }
  } finally {
    if (started === generation) {
      busy = false;
      element("workspace").querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }
}
/** @param {unknown} value */
function result(value) {
  if (!object(value) || value.customer !== customer || !object(value.result)) throw new Error("Mismatched history response.");
  return value.result;
}
/** @param {unknown} value @param {string} name */
function cursor(value, name) {
  if (value !== null && !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)) throw new Error(`Invalid ${name} cursor.`);
  return value;
}
/** @param {string} label @param {() => void} action @param {string} list */
function button(label, action, list) {
  const row = document.createElement("li"), control = document.createElement("button");
  control.textContent = label; control.addEventListener("click", action); row.append(control); element(list).append(row);
}
function query() { return new URLSearchParams({ runtime, epoch, revision }).toString(); }
async function readStored(check = false) {
  const started = generation, chosenRuntime = runtime, chosenEpoch = epoch, chosenRevision = revision;
  const value = result(await request(`/api/customers/${customer}/history/${check ? "check" : "stored"}?${query()}`));
  if (started !== generation) return;
  if (!object(value.scope) || value.scope.customer !== customer || value.scope.runtime !== chosenRuntime ||
      value.scope.epoch !== chosenEpoch || (chosenRevision !== "latest" && value.id !== Number(chosenRevision)) ||
      typeof value.id !== "number" || typeof value.algorithm !== "string" ||
      !/^marked-caller-v[1-5]$/.test(value.algorithm) || !object(value.freshness) ||
      !["not-checked", "inputs-match", "inputs-changed"].includes(String(value.freshness.state)) ||
      (!check && value.freshness.state !== "not-checked") ||
      !object(value.observation) || !Array.isArray(value.observation.journeys) || !Array.isArray(value.observation.issues)) {
    throw new Error("Invalid or mismatched revision response.");
  }
  const view = value.observation;
  element("freshness").textContent = JSON.stringify({ revision: value.id, algorithm: value.algorithm,
    createdAt: value.createdAt, sourceDocumentSha256: value.sha256, inputSha256: value.inputSha256, freshness: value.freshness,
    legacy: value.algorithm !== "marked-caller-v5" ? "Fields absent in older algorithms are unavailable, not negative." : false }, null, 2);
  element("warnings").textContent = JSON.stringify({ quality: view.quality, issues: view.issues, coverage: view.coverage,
    inputCapabilities: view.input, currentQueueCollectionCapability: value.currentQueueCollectionCapability,
    currentQuality: value.currentQuality, currentCoverage: value.currentCoverage, collectorHealth: value.collectorHealth }, null, 2);
  element("observations").textContent = JSON.stringify(view.journeys, null, 2);
  element("references").textContent = "Record references are preserved in the observations and issues above. Raw records are not exposed.";
}
async function revisions(append = false) {
  const started = generation;
  const value = result(await request(`/api/customers/${customer}/history/revisions?${new URLSearchParams({
    runtime, epoch, after: String(append ? revisionAfter : 0), limit: "50" })}`));
  if (started !== generation) return;
  if (!Array.isArray(value.revisions) || value.revisions.length > 50) throw new Error("Invalid revision page.");
  const next = cursor(value.nextAfterId, "revision");
  if (!append) element("revision-list").replaceChildren();
  for (const row of value.revisions) {
    if (!object(row) || !object(row.scope) || row.scope.customer !== customer || row.scope.runtime !== runtime ||
        row.scope.epoch !== epoch || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 1) throw new Error("Invalid revision metadata.");
    button(`Revision ${row.id} / ${row.algorithm}`, () => {
      revision = String(row.id); element("selection").textContent = `${runtime} / ${epoch} / revision ${revision}`;
      void run(() => readStored());
    }, "revision-list");
  }
  revisionAfter = next ?? 0; element("more-revisions").hidden = next === null;
  element("stored").hidden = false; element("check").hidden = false;
}
async function scopes(append = false) {
  const started = generation;
  const value = result(await request(`/api/customers/${customer}/history/scopes?after=${append ? scopeAfter : 0}&limit=50`));
  if (started !== generation) return;
  if (!Array.isArray(value.scopes) || value.scopes.length > 50) throw new Error("Invalid scope page.");
  const next = cursor(value.nextAfterId, "scope");
  if (!append) {
    element("scope-list").replaceChildren(); element("revision-list").replaceChildren();
    runtime = ""; epoch = ""; revision = "latest"; element("selection").textContent = "";
    element("stored").hidden = true; element("check").hidden = true; element("more-revisions").hidden = true;
  }
  for (const row of value.scopes) {
    if (!object(row) || ![row.runtime, row.epoch].every((v) => typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(v))) throw new Error("Invalid scope metadata.");
    button(`${row.runtime} / ${row.epoch}`, () => {
      runtime = String(row.runtime); epoch = String(row.epoch); revision = "latest";
      element("selection").textContent = `${runtime} / ${epoch} / latest`;
      void run(() => revisions());
    }, "scope-list");
  }
  scopeAfter = next ?? 0; element("more-scopes").hidden = next === null;
  if (!value.scopes.length && !append) element("selection").textContent = "No stored scopes for this authorized customer.";
}
async function boot() {
  end("Checking application session..."); const started = generation;
  try {
    const value = await request("/auth/session");
    if (started !== generation) return;
    if (value.customer !== customer || typeof value.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrf) ||
        typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now()) throw new Error("Invalid or mismatched application session.");
    csrf = value.csrf; deadline = Date.parse(value.expiresAt); expiry();
    element("session-status").textContent = "Session checked; history membership is verified on every read.";
    element("sign-in").hidden = true; element("sign-out").hidden = false; element("workspace").hidden = false;
    await run(() => scopes());
  } catch (error) {
    if (started === generation) end(error instanceof Error ? error.message : "Session connection failed.");
  }
}
element("scopes").addEventListener("click", () => { void run(() => scopes()); });
element("more-scopes").addEventListener("click", () => { void run(() => scopes(true)); });
element("more-revisions").addEventListener("click", () => { void run(() => revisions(true)); });
element("stored").addEventListener("click", () => { void run(() => readStored()); });
element("check").addEventListener("click", () => { void run(() => readStored(true)); });
element("retry").addEventListener("click", () => { void boot(); });
element("sign-out").addEventListener("click", () => {
  const token = csrf; end("Signing out; local protected data cleared.");
  void fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": token } })
    .then((r) => { element("session-status").textContent = r.ok ? "Signed out." : "Local data cleared; server logout not confirmed."; })
    .catch(() => { element("session-status").textContent = "Local data cleared; server logout not confirmed."; });
});
window.addEventListener("pagehide", () => end("Workspace closed."));
void boot();
