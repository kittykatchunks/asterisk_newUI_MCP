// @ts-check
export {};
const matchedCustomer = location.pathname.match(/^\/agent\/([a-z0-9][a-z0-9-]{0,63})$/)?.[1];
if (!matchedCustomer) throw new Error("Invalid agent console path");
const customer = matchedCustomer;
/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing agent console element ${id}`);
  return value;
}
const status = element("session-status");
element("selected-customer").textContent = customer;
const guidance = element("workflow-guidance");
const warning = element("session-warning");
const login = element("sign-in");
const logout = element("sign-out");
const retry = element("retry-session");
const refresh = element("refresh");
const profileStatus = element("assignment-status");
const profile = element("assignment");
const deviceSection = element("device-reservation");
const deviceStatus = element("device-status");
const reserve = element("reserve-device");
const renew = element("renew-device");
const release = element("release-device");
const deviceId = crypto.randomUUID();
let csrf = "";
let assigned = false;
let deviceBusy = false;
/** @type {{ id: string, expiresAt: number } | undefined} */
let lease;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let leaseTimer;
login.setAttribute("href", `/auth/login?customer=${encodeURIComponent(customer)}&workspace=agent`);
/** @param {Response} response */
function reference(response) {
  const value = response.headers.get("x-request-id") ?? "";
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : "unavailable";
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
let ended = false;
let busy = false;
const lifetime = new AbortController();
function clearProfile() { profile.replaceChildren(); profile.hidden = true; }
/** @param {string} message */
function end(message) {
  ended = true;
  clearTimeout(timer);
  clearTimeout(leaseTimer);
  document.removeEventListener("visibilitychange", checkDeadline);
  window.removeEventListener("pageshow", checkDeadline);
  lifetime.abort();
  clearProfile();
  lease = undefined;
  assigned = false;
  deviceSection.hidden = true;
  deviceStatus.textContent = "No device reservation confirmed. Any server reservation may remain until expiry.";
  profileStatus.textContent = "No assignment loaded.";
  warning.hidden = true;
  warning.textContent = "";
  logout.hidden = true;
  refresh.hidden = true;
  login.hidden = false;
  status.textContent = message;
  guidance.textContent = "Sign in to load your own assignment. Any server reservation may remain until expiry; signing out does not confirm release.";
}
let deadline = 0;
function deviceControls() {
  deviceSection.hidden = ended || (!assigned && !lease);
  reserve.hidden = !!lease || !assigned;
  renew.hidden = !lease;
  release.hidden = !lease;
  for (const button of [reserve, renew, release]) {
    if (deviceBusy) button.setAttribute("disabled", "");
    else button.removeAttribute("disabled");
  }
  if (!ended) {
    guidance.textContent = deviceBusy ? "Wait for the reservation result before taking another reservation action." :
      lease && !assigned ? "Your assignment is not confirmed. Refresh it or attempt to release the known reservation; server checks still apply." :
      lease ? "Renew explicitly if needed. To move devices, release this reservation and wait for confirmation before signing out." :
      assigned ? "You can explicitly reserve this page's device. Phone connection remains disabled." :
      "Load your own assignment using Refresh assignment. If it is missing or access is denied, contact your administrator.";
  }
}
function checkLease() {
  clearTimeout(leaseTimer);
  if (ended || !lease) return;
  if (lease.expiresAt <= Date.now()) {
    lease = undefined;
    deviceStatus.setAttribute("role", "status");
    deviceStatus.textContent = "Reservation expired locally. Reserve again to check server ownership.";
    deviceControls();
  } else {
    leaseTimer = setTimeout(checkLease, lease.expiresAt - Date.now());
  }
}
/** @param {"acquire" | "renew" | "release"} action */
async function changeLease(action) {
  if (ended || deviceBusy) return;
  checkDeadline();
  checkLease();
  if (ended || (action !== "acquire" && !lease) || (action === "acquire" && !assigned)) return;
  deviceBusy = true;
  deviceControls();
  deviceStatus.setAttribute("role", "status");
  deviceStatus.textContent = "Checking device reservation...";
  let requestId = "unavailable";
  try {
    const response = await fetch(`/api/customers/${customer}/agent/device-lease${action === "acquire" ? "" : "/" + action}`, {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ deviceId, ...(action !== "acquire" && lease ? { leaseId: lease.id } : {}) }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    requestId = reference(response);
    if (ended) return;
    if (response.status === 401) { end("Application session is no longer valid. Sign in again."); return; }
    if (!response.ok) throw new Error(response.status === 409 ?
      "Device reservation conflict. Another owner may hold it; release there or wait for expiry." :
      response.status === 403 ? "Device reservation access is not permitted." :
      response.status === 404 ? "No agent assignment is provisioned." : `Device reservation unavailable (${response.status}).`);
    /** @type {unknown} */
    const value = await response.json();
    if (ended) return;
    checkDeadline();
    if (ended) return;
    if (typeof value !== "object" || value === null ||
        !("customer" in value) || value.customer !== customer) throw new Error("Invalid device reservation response.");
    if (action === "release") {
      if (!("code" in value) || value.code !== "agent_device_released") throw new Error("Invalid release response.");
      lease = undefined;
      clearTimeout(leaseTimer);
      deviceStatus.textContent = `Reservation released (request ${requestId}).`;
    } else {
      if (!("lease" in value) || typeof value.lease !== "object" || value.lease === null ||
          !("id" in value.lease) || typeof value.lease.id !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.lease.id) ||
          !("expiresAt" in value.lease) || typeof value.lease.expiresAt !== "number" ||
          !Number.isSafeInteger(value.lease.expiresAt) || value.lease.expiresAt <= Date.now() ||
          value.lease.expiresAt > deadline || value.lease.expiresAt > Date.now() + 60000 ||
          (action === "renew" && value.lease.id !== lease?.id)) throw new Error("Invalid device reservation response.");
      lease = { id: value.lease.id, expiresAt: value.lease.expiresAt };
      deviceStatus.textContent = `Device reserved until ${new Date(lease.expiresAt).toISOString()}. Phone remains disabled (request ${requestId}).`;
      checkLease();
    }
  } catch (error) {
    if (ended) return;
    deviceStatus.setAttribute("role", "alert");
    deviceStatus.textContent = `${error instanceof Error ? error.message : "Device request failed."} Reservation change not confirmed; server state may differ. Retry explicitly or wait for expiry (request ${requestId}).`;
  } finally { deviceBusy = false; deviceControls(); }
}
reserve.onclick = () => changeLease("acquire");
renew.onclick = () => changeLease("renew");
release.onclick = () => changeLease("release");
function checkDeadline() {
  if (ended) return;
  clearTimeout(timer);
  const remaining = deadline - Date.now();
  if (remaining <= 0) { end("Session expired. Sign in again."); return; }
  checkLease();
  warning.hidden = remaining > 120000;
  warning.textContent = warning.hidden ? "" : "Session expires in two minutes or less. Your loaded assignment will be cleared.";
  timer = setTimeout(checkDeadline, remaining > 120000 ? remaining - 120000 : remaining);
}
async function loadProfile() {
  if (ended || busy) return;
  checkDeadline();
  if (ended) return;
  busy = true;
  refresh.setAttribute("disabled", "");
  clearProfile();
  assigned = false;
  deviceControls();
  profileStatus.setAttribute("role", "status");
  profileStatus.textContent = "Checking your assignment...";
  let requestId = "unavailable";
  try {
    const response = await fetch(`/api/customers/${customer}/agent/profile`, {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    requestId = reference(response);
    if (ended) return;
    if (response.status === 401) { end("Application session is no longer valid. Sign in again."); return; }
    if (!response.ok) {
      throw new Error(response.status === 403 ? "Agent access is not permitted." :
        response.status === 404 ? "No agent assignment is provisioned." : `Assignment unavailable (${response.status}).`);
    }
    /** @type {unknown} */
    const value = await response.json();
    if (ended) return;
    checkDeadline();
    if (ended) return;
    if (typeof value !== "object" || value === null || !("customer" in value) || value.customer !== customer ||
        !("agent" in value) || typeof value.agent !== "object" || value.agent === null ||
        !("extension" in value.agent) || typeof value.agent.extension !== "string" || !/^[0-9]{1,16}$/.test(value.agent.extension) ||
        !("displayName" in value.agent) || typeof value.agent.displayName !== "string" ||
        !value.agent.displayName.trim() || value.agent.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(value.agent.displayName)) {
      throw new Error("Invalid agent assignment response.");
    }
    for (const [label, text] of [["Customer", customer], ["Agent", value.agent.displayName], ["Extension", value.agent.extension]]) {
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label; detail.textContent = text;
      profile.append(term, detail);
    }
    profile.hidden = false;
    assigned = true;
    deviceControls();
    profileStatus.textContent = `Assignment loaded (request ${requestId}).`;
  } catch (error) {
    if (ended) return;
    clearProfile();
    profileStatus.setAttribute("role", "alert");
    profileStatus.textContent = `${error instanceof Error ? error.message : "Assignment check failed."} (request ${requestId}).`;
  } finally { busy = false; refresh.removeAttribute("disabled"); }
}
refresh.onclick = loadProfile;
retry.onclick = () => location.reload();
window.addEventListener("pagehide", () => end("Console closed. Sign in again."), { once: true });
try {
  let requestId = "unavailable";
  try {
    const response = await fetch("/auth/session", {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    requestId = reference(response);
    if (ended) throw new Error("Console closed.");
    if (response.status === 401) { end("Sign in to view your agent assignment."); }
    else {
      if (!response.ok) throw new Error(`Session unavailable (${response.status}).`);
      /** @type {unknown} */
      const session = await response.json();
      if (ended) throw new Error("Console closed.");
      if (typeof session !== "object" || session === null || !("customer" in session) || session.customer !== customer ||
          !("csrf" in session) || typeof session.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf) ||
          !("expiresAt" in session) || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) {
        throw new Error("Invalid or mismatched application session.");
      }
      csrf = session.csrf;
      deadline = Date.parse(session.expiresAt);
      document.addEventListener("visibilitychange", checkDeadline);
      window.addEventListener("pageshow", checkDeadline);
      checkDeadline();
      if (!ended) {
        login.hidden = true; logout.hidden = false; refresh.hidden = false;
        status.textContent = `Signed in. Session expires ${session.expiresAt}`;
        logout.onclick = async () => {
          logout.setAttribute("disabled", "");
          let logoutId = "unavailable";
          try {
            const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", redirect: "error",
              headers: { "X-CSRF-Token": csrf }, signal: AbortSignal.timeout(15000) });
            logoutId = reference(response);
            if (ended) return;
            if (!response.ok && response.status !== 401) throw new Error(`Server returned ${response.status}`);
            end("Sign in to view your agent assignment.");
          } catch (error) {
            if (ended) return;
            status.setAttribute("role", "alert");
            status.textContent = `Sign out was not confirmed. Your session may still be active. Retry sign out. ${error instanceof Error ? error.message : "Request failed."} (request ${logoutId}).`;
            logout.removeAttribute("disabled");
          }
        };
        await loadProfile();
      }
    }
  } catch (error) {
    if (!ended) {
      end(`${error instanceof Error ? error.message : "Session connection failed."} (session bootstrap request ${requestId}).`);
      status.setAttribute("role", "alert");
      retry.hidden = false;
    }
  }
} catch (error) { end("Console could not start."); throw error; }
