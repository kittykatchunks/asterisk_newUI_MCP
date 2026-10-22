// @ts-check
import { connectReviewWorkspace } from "./review-workspace.js";

const match = location.pathname.match(/^\/engineering\/reviews\/([a-z0-9][a-z0-9-]{0,63})$/);
if (!match) throw new Error("Invalid review workspace path");
const bar = document.createElement("header");
const status = document.createElement("p");
status.setAttribute("role", "status");
const login = document.createElement("a");
login.textContent = "Sign in";
login.href = `/auth/login?customer=${encodeURIComponent(match[1])}`;
bar.append(status, login);
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
    login.hidden = true;
    status.textContent = `Signed in. Session expires ${session.expiresAt}`;
    const disconnect = await connectReviewWorkspace({ csrf });
    const logout = document.createElement("button");
    logout.textContent = "Sign out";
    bar.append(logout);
    logout.onclick = async () => {
      logout.disabled = true;
      try {
        const result = await fetch("/auth/logout", {
          method: "POST", credentials: "same-origin", redirect: "error",
          headers: { "X-CSRF-Token": csrf },
          signal: AbortSignal.timeout(15000),
        });
        if (result.status === 401) {
          disconnect();
          location.replace(`/engineering/reviews/${match[1]}`);
          return;
        }
        if (!result.ok) throw new Error(`Sign out failed (${result.status}). Retry sign out.`);
        disconnect();
        location.replace(`/engineering/reviews/${match[1]}`);
      } catch (error) {
        status.setAttribute("role", "alert");
        status.textContent = error instanceof Error ? error.message : "Sign out failed";
        logout.disabled = false;
      }
    };
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) throw new Error("Invalid session expiry");
    setTimeout(() => {
      disconnect();
      logout.remove();
      login.hidden = false;
      status.textContent = "Session expired. Sign in again.";
    }, Math.max(0, remaining));
  }
} catch (error) {
  status.setAttribute("role", "alert");
  status.textContent = error instanceof Error ? error.message : "Session connection failed";
}
