// @ts-check
export {};
const matchedCustomer = location.pathname.match(/^\/simulation\/(customer-[ab])$/)?.[1];
if (!matchedCustomer) throw new Error("Invalid simulation workspace path");
const customer = matchedCustomer;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const conversationId = /^synthetic-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const states = ["collecting", "awaiting confirmation", "submitting", "accepted", "rejected", "outcome unknown"];
/** @param {string} id */
function element(id) {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing simulation element ${id}`);
  return result;
}
/** @param {string} id */
function select(id) {
  const result = element(id);
  if (!(result instanceof HTMLSelectElement)) throw new Error(`Invalid select ${id}`);
  return result;
}
element("selected-customer").textContent = customer;
element("sign-in").setAttribute("href", `/auth/login?customer=${customer}&workspace=simulation`);
for (const id of ["pickup", "destination"]) {
  for (const label of ["station", "hotel"]) {
    const option = document.createElement("option");
    option.value = `${customer}-${label}`;
    option.textContent = `${customer} synthetic ${label}`;
    select(id).append(option);
  }
}
select("destination").value = `${customer}-hotel`;
const status = element("result-status");
const sessionStatus = element("session-status");
const workspace = element("workspace");
const lifetime = new AbortController();
let ended = false;
let busy = false;
let csrf = "";
let deadline = 0;
let conversation = "";
let operationId = "";
let needsRecovery = false;
let dirty = false;
let lastReference = "unavailable";
/** @type {import("./booking-simulation.ts").SimulatedBooking | undefined} */
let booking;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @param {string} message */
function end(message) {
  ended = true;
  lifetime.abort();
  clearTimeout(timer);
  csrf = ""; conversation = ""; operationId = ""; booking = undefined;
  element("conversations").replaceChildren();
  element("operation").textContent = "";
  element("handover-context").textContent = "";
  element("selection").textContent = "";
  select("pickup").value = `${customer}-station`;
  select("destination").value = `${customer}-hotel`;
  select("passenger").value = "Synthetic Alice";
  select("contact").value = "test-contact-alice";
  select("passengers").value = "2";
  workspace.hidden = true;
  element("sign-out").hidden = true;
  status.textContent = "";
  sessionStatus.textContent = message;
  element("sign-in").hidden = false;
}
function checkDeadline() {
  if (ended || !deadline) return;
  clearTimeout(timer);
  if (deadline <= Date.now()) end("Session expired. Sign in again; resume your own durable work explicitly.");
  else timer = setTimeout(checkDeadline, deadline - Date.now());
}
/** @param {string} message @param {boolean} [error] */
function message(message, error = false) {
  status.setAttribute("role", error ? "alert" : "status");
  status.textContent = message;
}
function controls() {
  const editable = booking && ["collecting", "awaiting confirmation"].includes(booking.state);
  const terminal = booking && ["accepted", "rejected"].includes(booking.state);
  element("create-draft").hidden = !!booking && !terminal;
  element("save-draft").hidden = !editable;
  element("review").hidden = booking?.state !== "collecting";
  element("confirm").hidden = booking?.state !== "awaiting confirmation" || booking.confirmedRevision === booking.revision;
  element("submission").hidden = booking?.state !== "awaiting confirmation" || booking.confirmedRevision !== booking.revision;
  element("reconcile").hidden = !booking || !["submitting", "outcome unknown"].includes(booking.state);
  element("read-operation").hidden = !operationId;
  element("handover-controls").hidden = !booking;
  for (const button of Array.from(workspace.querySelectorAll("button"))) {
    const recovery = ["refresh-list", "read-operation"].includes(button.id);
    button.disabled = ended || busy || (needsRecovery && !recovery);
  }
  for (const input of Array.from(workspace.querySelectorAll("select"))) input.disabled = ended || busy || needsRecovery;
  for (const id of ["pickup", "destination", "passenger", "contact", "passengers"]) {
    select(id).disabled ||= !conversation || (!!booking && !editable && !terminal);
  }
  element("create-draft").toggleAttribute("disabled",
    ended || busy || needsRecovery || !conversation || (!!booking && !terminal));
  for (const id of ["review", "confirm", "submit"]) {
    element(id).toggleAttribute("disabled", ended || busy || needsRecovery || dirty);
  }
}
/** @param {unknown} value @returns {asserts value is import("./booking-simulation.ts").SimulatedBooking} */
function validateBooking(value) {
  if (typeof value !== "object" || value === null ||
      !("simulation" in value) || value.simulation !== true ||
      !("customer" in value) || value.customer !== customer ||
      !("id" in value) || typeof value.id !== "string" || !uuid.test(value.id) ||
      (operationId && value.id !== operationId) ||
      !("conversation" in value) || typeof value.conversation !== "string" || !conversationId.test(value.conversation) ||
      (conversation && value.conversation !== conversation) ||
      !("revision" in value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !("confirmedRevision" in value) || !(value.confirmedRevision === null || value.confirmedRevision === value.revision) ||
      !("state" in value) || typeof value.state !== "string" || !states.includes(value.state) ||
      !("reason" in value) || typeof value.reason !== "string" ||
      !["draft_created", "draft_edited", "summary_presented", "explicit_confirmation", "submission_committed",
        "simulated_acceptance", "simulated_rejection", "simulated_uncertainty"].includes(value.reason) ||
      !("reference" in value) || (value.state === "accepted" ? value.reference !== `SIM-${value.id}` : value.reference !== null) ||
      !("details" in value) || typeof value.details !== "object" || value.details === null) {
    throw new Error("Invalid simulated operation response.");
  }
  const d = value.details;
  if (!("pickup" in d) || !("destination" in d) ||
      ![`${customer}-station`, `${customer}-hotel`].includes(String(d.pickup)) ||
      ![`${customer}-station`, `${customer}-hotel`].includes(String(d.destination)) || d.pickup === d.destination ||
      !("passenger" in d) || typeof d.passenger !== "string" || !/^Synthetic [A-Za-z ]{1,64}$/.test(d.passenger) ||
      !("contact" in d) || typeof d.contact !== "string" || !/^test-contact-[a-z0-9-]{1,32}$/.test(d.contact) ||
      !("passengers" in d) || typeof d.passengers !== "number" || !Number.isInteger(d.passengers) || d.passengers < 1 || d.passengers > 8 ||
      !("summary" in value) || value.summary !== `SIMULATION: book now; ${d.pickup} -> ${d.destination}; ${d.passenger}; ${d.contact}; passengers ${d.passengers}` ||
      (["submitting", "accepted", "rejected", "outcome unknown"].includes(value.state) && value.confirmedRevision !== value.revision)) {
    throw new Error("Invalid simulated journey response.");
  }
}
/** @param {unknown} value */
function showBooking(value) {
  validateBooking(value);
  booking = value; operationId = value.id; conversation = value.conversation; dirty = false;
  needsRecovery = false;
  for (const id of ["pickup", "destination", "passenger", "contact", "passengers"]) {
    const key = /** @type {keyof import("./booking-simulation.ts").SyntheticJourney} */ (id);
    select(id).value = String(value.details[key]);
  }
  element("selection").textContent = `SIMULATION conversation ${conversation}; operation ${operationId}.`;
  element("operation").textContent = `SIMULATION ONLY\n${value.summary}\nRevision: ${value.revision}\n` +
    `Confirmed revision: ${value.confirmedRevision ?? "none"}\nState: ${value.state}\n` +
    `Reason: ${value.reason}\nReference: ${value.reference ?? "none"}`;
}
/** @param {string} path @param {unknown} [body] */
async function request(path, body) {
  const response = await fetch(`/api/customers/${customer}/booking-simulation/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
  });
  const reference = response.headers.get("x-request-id");
  const id = reference && uuid.test(reference) ? reference : "unavailable";
  lastReference = id;
  if (ended) throw new Error("Workspace closed.");
  checkDeadline();
  if (ended) throw new Error("Session expired.");
  if (response.status === 401 || response.status === 403) {
    end(`Simulation access ${response.status === 401 ? "expired" : "denied"}. Sign in again (request ${id}).`);
    throw new Error("Simulation access ended.");
  }
  if (!response.ok) throw new Error(`${response.status === 409 ? "State or revision conflict" :
    response.status === 400 ? "Invalid or unsupported synthetic request" :
    response.status === 404 ? "Owned resource not found" : `Simulation unavailable (${response.status})`} (request ${id}).`);
  /** @type {unknown} */
  let value;
  try { value = await response.json(); }
  catch (error) { throw new Error(`Unreadable simulation response (request ${id}).`, { cause: error }); }
  if (ended) throw new Error("Workspace closed.");
  checkDeadline();
  if (ended) throw new Error("Session expired.");
  if (typeof value !== "object" || value === null ||
      !("simulation" in value) || value.simulation !== true || !("customer" in value) ||
      value.customer !== customer || !("result" in value)) throw new Error(`Invalid simulation response (request ${id}).`);
  message(`Simulation response received (request ${id}).`);
  return value.result;
}
/** @param {() => Promise<void>} action @param {boolean} [mutation] */
async function run(action, mutation = false) {
  if (ended || busy) return;
  checkDeadline();
  if (ended) return;
  busy = true; controls(); message("Checking simulation...");
  lastReference = "unavailable";
  element("handover-context").textContent = "";
  try { await action(); }
  catch (error) {
    if (!ended) {
      needsRecovery = true;
      message(`${error instanceof Error ? error.message : "Request failed."} (request ${lastReference}). ${mutation ? "Change" : "Read"} not confirmed. ` +
        "No outcome inferred. Refresh own exercises or read the known operation before another mutation; never automatically recreate or resubmit.", true);
    }
  } finally { busy = false; controls(); }
}
/** @param {string} id */
async function readOperation(id) {
  operationId = id; booking = undefined;
  element("operation").textContent = "";
  showBooking(await request(`operations/${id}`));
}
async function list() {
  const value = await request("conversations");
  if (typeof value !== "object" || value === null || !("conversations" in value) || !Array.isArray(value.conversations)) {
    throw new Error("Invalid own-exercise list.");
  }
  const fragment = document.createDocumentFragment();
  for (const entry of value.conversations) {
    if (typeof entry !== "object" || entry === null || entry.simulation !== true || entry.customer !== customer ||
        typeof entry.conversation !== "string" || !conversationId.test(entry.conversation) || !Array.isArray(entry.operations)) {
      throw new Error("Invalid owned conversation.");
    }
    const li = document.createElement("li");
    li.textContent = `SIMULATION ${entry.conversation}: `;
    if (entry.operations.length === 0) {
      const button = document.createElement("button");
      button.textContent = "Resume empty exercise";
      button.onclick = () => {
        if (ended || busy) return;
        conversation = entry.conversation; operationId = ""; booking = undefined; needsRecovery = false; dirty = false;
        element("operation").textContent = ""; element("handover-context").textContent = "";
        element("selection").textContent = `SIMULATION conversation ${conversation}; no operation yet.`;
        controls();
      };
      li.append(button);
    }
    for (const op of entry.operations) {
      if (typeof op !== "object" || op === null || typeof op.id !== "string" || !uuid.test(op.id) ||
          !states.includes(op.state) || !Number.isSafeInteger(op.revision) || op.revision < 1) {
        throw new Error("Invalid own-operation summary.");
      }
      const button = document.createElement("button");
      button.textContent = `Resume ${op.id} (${op.state}, revision ${op.revision})`;
      button.onclick = () => run(async () => { conversation = entry.conversation; await readOperation(op.id); });
      li.append(button);
    }
    fragment.append(li);
  }
  element("conversations").replaceChildren(fragment);
  conversation = ""; operationId = ""; booking = undefined; needsRecovery = false; dirty = false;
  element("operation").textContent = "";
  element("selection").textContent = "Own exercises loaded. Explicitly resume an operation or empty exercise; nothing has been created or reconciled.";
}
function details() {
  return { pickup: select("pickup").value, destination: select("destination").value,
    passenger: select("passenger").value, contact: select("contact").value,
    passengers: Number(select("passengers").value) };
}
for (const id of ["pickup", "destination", "passenger", "contact", "passengers"]) {
  select(id).onchange = () => {
    dirty = !!booking;
    element("handover-context").textContent = "";
    if (dirty) message("Unsaved changes. Save changes to invalidate confirmation before review or submission.");
    controls();
  };
}
element("refresh-list").onclick = () => run(list);
element("new-conversation").onclick = () => run(async () => {
  const value = await request("conversations", {});
  if (typeof value !== "object" || value === null || !("conversation" in value) ||
      typeof value.conversation !== "string" || !conversationId.test(value.conversation)) throw new Error("Invalid created exercise.");
  conversation = value.conversation; booking = undefined; operationId = ""; dirty = false; needsRecovery = false;
  element("operation").textContent = "";
  element("selection").textContent = `SIMULATION conversation ${conversation}; no operation yet.`;
}, true);
element("create-draft").onclick = () => run(async () => {
  operationId = ""; booking = undefined;
  showBooking(await request(`conversations/${conversation}/drafts`, { details: details() }));
}, true);
element("save-draft").onclick = () => run(async () => {
  showBooking(await request(`operations/${operationId}/edit`, { details: details(), revision: booking?.revision }));
}, true);
for (const action of ["review", "confirm", "submit"]) {
  element(action).onclick = () => run(async () => {
    if (!booking || dirty) throw new Error("Read or save the current details first.");
    showBooking(await request(`operations/${operationId}/${action}`, {
      revision: booking.revision, ...(action === "submit" ? { scenario: select("scenario").value } : {}),
    }));
  }, true);
}
element("read-operation").onclick = () => run(() => readOperation(operationId));
element("reconcile").onclick = () => run(async () => {
  showBooking(await request(`operations/${operationId}/reconcile`, {}));
}, true);
element("handover").onclick = () => run(async () => {
  const value = await request(`operations/${operationId}/handover`, { reason: select("handover-reason").value });
  validateBooking(value);
  if (!("handoverReason" in value) || value.handoverReason !== select("handover-reason").value) throw new Error("Invalid handover response.");
  showBooking(value);
  element("handover-context").textContent = `SIMULATION handover only; no transfer or cancellation.\n` +
    `Reason: ${value.handoverReason}\nCustomer: ${customer}\nConversation: ${conversation}\nOperation: ${operationId}\n` +
    `${value.summary}\nConfirmed revision: ${value.confirmedRevision ?? "none"}\nState: ${value.state}\nReference: ${value.reference ?? "none"}`;
});
element("retry-session").onclick = () => location.reload();
element("sign-out").onclick = async () => {
  const token = csrf;
  let logoutReference = "unavailable";
  // Clear data and abort in-flight work before waiting for the logout receipt.
  end("Signing out; server logout is not confirmed yet.");
  element("sign-out").setAttribute("disabled", "");
  try {
    const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "X-CSRF-Token": token }, signal: AbortSignal.timeout(15000) });
    const reference = response.headers.get("x-request-id");
    if (reference && uuid.test(reference)) logoutReference = reference;
    if (!response.ok && response.status !== 401) throw new Error(`Server returned ${response.status}`);
    element("sign-out").hidden = true;
    sessionStatus.textContent = "Signed out. No booking was cancelled; sign in to resume your own work.";
  } catch (error) {
    sessionStatus.setAttribute("role", "alert");
    sessionStatus.textContent = `Sign out not confirmed; server session may remain active. ${error instanceof Error ? error.message : "Request failed."} (request ${logoutReference}). Reload to check the session and retry sign out.`;
    element("retry-session").hidden = false;
  }
};
window.addEventListener("pagehide", () => end("Workspace closed."), { once: true });
document.addEventListener("visibilitychange", checkDeadline);
window.addEventListener("pageshow", checkDeadline);
let bootstrapReference = "unavailable";
try {
  const response = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store",
    redirect: "error", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
  const reference = response.headers.get("x-request-id");
  if (reference && uuid.test(reference)) bootstrapReference = reference;
  if (!ended) {
    if (response.status === 401) end("Sign in to use the synthetic workspace.");
    else {
      if (!response.ok) throw new Error(`Session unavailable (${response.status}).`);
      /** @type {unknown} */
      const session = await response.json();
      if (!ended) {
        if (typeof session !== "object" || session === null || !("customer" in session) || session.customer !== customer ||
            !("csrf" in session) || typeof session.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf) ||
            !("expiresAt" in session) || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) {
          throw new Error("Invalid or mismatched application session.");
        }
        csrf = session.csrf; deadline = Date.parse(session.expiresAt);
        checkDeadline();
        if (!ended) {
          element("sign-in").hidden = true; element("sign-out").hidden = false;
          workspace.hidden = false;
          sessionStatus.textContent = `Signed in for simulation. Session expires ${session.expiresAt}.`;
          await run(list);
        }
      }
    }
  }
} catch (error) {
  if (!ended) {
    end(`${error instanceof Error ? error.message : "Session unavailable."} (session request ${bootstrapReference}).`);
    sessionStatus.setAttribute("role", "alert");
    element("retry-session").hidden = false;
  }
}
