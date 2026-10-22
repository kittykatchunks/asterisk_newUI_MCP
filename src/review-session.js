// @ts-check
import { connectReviewWorkspace } from "./review-workspace.js";

const match = location.pathname.match(/^\/engineering\/reviews\/([a-z0-9][a-z0-9-]{0,63})$/);
if (!match) throw new Error("Invalid review workspace path");
const bar = document.createElement("header");
const status = document.createElement("p");
status.setAttribute("role", "status");
const expiryWarning = document.createElement("p");
expiryWarning.setAttribute("role", "status");
expiryWarning.hidden = true;
const login = document.createElement("a");
login.textContent = "Sign in";
login.href = `/auth/login?customer=${encodeURIComponent(match[1])}`;
bar.append(status, expiryWarning, login);
document.body.prepend(bar);

try {
  const response = await fetch("/auth/session", {
    credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) {
    status.textContent = "Sign in to review reports.";
  } else {
    if (!response.ok) throw new Error(`Session unavailable (${response.status})`);
    /** @type {unknown} */
    const session = await response.json();
    if (typeof session !== "object" || session === null ||
        !("csrf" in session) || typeof session.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.csrf) ||
        !("expiresAt" in session) || typeof session.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(session.expiresAt))) throw new Error("Invalid session response");
    const csrf = session.csrf;
    const deadline = Date.parse(session.expiresAt);
    if (deadline <= Date.now()) throw new Error("Session expired. Sign in again.");
    login.hidden = true;
    status.textContent = `Signed in. Session expires ${session.expiresAt}`;
    const workspace = new AbortController();
    let ended = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadlineTimer;
    function stopSessionUi() {
      ended = true;
      clearTimeout(deadlineTimer);
      document.removeEventListener("visibilitychange", checkDeadline);
      window.removeEventListener("pageshow", checkDeadline);
      expiryWarning.textContent = "";
      expiryWarning.hidden = true;
    }
    const logout = document.createElement("button");
    logout.textContent = "Sign out";
    bar.append(logout);
    function sessionRejected() {
      if (ended) return;
      stopSessionUi();
      workspace.abort();
      logout.remove();
      login.hidden = false;
      status.setAttribute("role", "alert");
      status.textContent = "Application session is no longer valid. Sign in again. Check the report state before retrying any decision.";
    }
    logout.onclick = async () => {
      logout.disabled = true;
      status.setAttribute("role", "status");
      status.textContent = "Signing out...";
      try {
        const result = await fetch("/auth/logout", {
          method: "POST", credentials: "same-origin", redirect: "error",
          headers: { "X-CSRF-Token": csrf },
          signal: AbortSignal.timeout(15000),
        });
        if (result.status === 401) {
          stopSessionUi();
          workspace.abort();
          location.replace(`/engineering/reviews/${match[1]}`);
          return;
        }
        if (!result.ok) throw new Error(`Server returned ${result.status}`);
        stopSessionUi();
        workspace.abort();
        location.replace(`/engineering/reviews/${match[1]}`);
      } catch (error) {
        if (ended) return;
        status.setAttribute("role", "alert");
        const detail = error instanceof Error ? error.message : "Unknown sign-out error";
        status.textContent = `Sign out was not confirmed. The session may still be active. Retry sign out. ${detail}`;
        logout.disabled = false;
      }
    };
    function checkDeadline() {
      if (ended) return;
      clearTimeout(deadlineTimer);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        stopSessionUi();
        workspace.abort();
        logout.remove();
        login.hidden = false;
        status.setAttribute("role", "status");
        status.textContent = "Session expired. Sign in again.";
        return;
      }
      expiryWarning.hidden = remaining > 120000;
      expiryWarning.textContent = expiryWarning.hidden ? "" :
        "Session expires in two minutes or less. Unsaved review work will be cleared at expiry. No decision is sent automatically.";
      deadlineTimer = setTimeout(checkDeadline, remaining > 120000 ? remaining - 120000 : remaining);
    }
    document.addEventListener("visibilitychange", checkDeadline);
    window.addEventListener("pageshow", checkDeadline);
    checkDeadline();
    try { await connectReviewWorkspace({ csrf, signal: workspace.signal, onUnauthorized: sessionRejected }); }
    catch (error) {
      stopSessionUi();
      workspace.abort();
      logout.remove();
      login.hidden = false;
      throw error;
    }
  }
} catch (error) {
  status.setAttribute("role", "alert");
  status.textContent = error instanceof Error ? error.message : "Session connection failed";
  const retry = document.createElement("button");
  retry.textContent = "Retry session connection";
  retry.onclick = () => {
    retry.disabled = true;
    location.reload();
  };
  bar.append(retry);
}
