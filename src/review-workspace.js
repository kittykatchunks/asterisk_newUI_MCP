// @ts-check
import { createReviewPreview } from "./review-preview.js";

/** @param {string} tag @param {string} text */
function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is Record<string, unknown> & { id: string, sha256: string }} */
function reference(value) {
  return record(value) && typeof value.id === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.id) &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

/** @param {unknown} value @returns {value is { id: string, title: string, createdAt: string }} */
function summary(value) {
  return record(value) && typeof value.id === "string" && /^incident-[0-9a-f]{32}$/.test(value.id) &&
    typeof value.title === "string" && !!value.title.trim() && value.title.length <= 200 &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

/** @param {unknown} value @returns {value is { id: string, sha256: string, summary: { id: string, title: string, createdAt: string } }} */
function pendingReference(value) { return reference(value) && summary(value.summary); }

/** @type {(() => void) | undefined} */
let disconnect;

/**
 * Called by a trusted session adapter. Tokens stay in this connection closure,
 * never in DOM attributes, URLs or browser storage.
 * @param {string | { csrf: string }} connection
 * @returns {Promise<() => void>}
 */
export async function connectReviewWorkspace(connection) {
  let accessToken = typeof connection === "string" ? connection : "";
  let csrf = typeof connection === "string" ? "" : connection.csrf;
  const match = location.pathname.match(/^\/engineering\/reviews\/([a-z0-9][a-z0-9-]{0,63})$/);
  const container = document.getElementById("review-workspace");
  if (!container || !match || (!accessToken.trim() && !csrf.trim())) throw new Error("Invalid review workspace connection");
  disconnect?.();
  const root = container;
  const customer = match[1];
  const endpoint = `/api/customers/${customer}/diagnostics/reviews`;
  const controller = new AbortController();
  let disposed = false;
  let busy = false;
  /** @type {{ id: string, sha256: string, title: string, incident: string } | undefined} */
  let selected;
  root.replaceChildren(element("h1", "Engineering report review"), element("p", `Customer: ${customer}`));
  const warning = element("p", "Unapproved evidence. Check customer scope, redaction and disclosure suitability. The rendered preview removes active content and report styling; inspect the original source as well.");
  const status = element("p", "");
  status.setAttribute("role", "status");
  const error = element("p", "");
  error.setAttribute("role", "alert");
  const refresh = document.createElement("button");
  refresh.textContent = "Refresh pending reports";
  const list = document.createElement("section");
  list.setAttribute("aria-label", "Pending reports");
  const detail = document.createElement("section");
  detail.setAttribute("aria-label", "Candidate review");
  detail.hidden = true;
  root.append(warning, status, error, refresh, list, detail);

  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Confirm review decision");
  const confirmation = element("p", "");
  const confirm = document.createElement("button");
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  dialog.append(confirmation, confirm, cancel);
  root.append(dialog);
  cancel.onclick = () => dialog.close();
  /** @type {(() => Promise<void>) | undefined} */
  let commit;
  confirm.onclick = () => { dialog.close(); if (commit) void commit(); };

  /** @param {string} path @param {RequestInit} [options] @returns {Promise<unknown>} */
  async function request(path, options = {}) {
    if (disposed) throw new DOMException("Review connection closed", "AbortError");
    const response = await fetch(path, {
      ...options, credentials: csrf ? "same-origin" : "omit", cache: "no-store", redirect: "error",
      headers: { ...(csrf ? { "X-CSRF-Token": csrf } : { Authorization: `Bearer ${accessToken}` }), ...(options.headers ?? {}) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    const body = await response.json();
    if (!response.ok) {
      const code = record(body) && typeof body.code === "string" ? body.code : "invalid_error_response";
      const requestId = record(body) && typeof body.requestId === "string" ? body.requestId : "unavailable";
      throw new Error(`Request failed (${response.status}: ${code}; request ${requestId}). Refresh before retrying; a lost response may follow a committed decision.`);
    }
    return body;
  }
  function controls() {
    refresh.disabled = busy;
    root.querySelectorAll("button").forEach((button) => {
      if (button !== refresh) button.disabled = busy;
    });
  }
  /** @param {unknown} cause */
  function failure(cause) {
    if (disposed) return;
    error.textContent = cause instanceof Error ? cause.message : "Review operation failed";
    status.textContent = "";
    selected = undefined;
    detail.replaceChildren();
    detail.hidden = true;
  }
  /** @param {() => Promise<void>} operation */
  async function run(operation) {
    if (busy || disposed) return;
    busy = true;
    error.textContent = "";
    controls();
    try { await operation(); }
    catch (cause) { failure(cause); }
    finally { busy = false; if (!disposed) controls(); }
  }
  async function load() {
    if (disposed) return;
    selected = undefined;
    detail.replaceChildren();
    detail.hidden = true;
    list.replaceChildren();
    status.textContent = "Loading pending reports...";
    const body = await request(endpoint);
    if (!record(body) || !Array.isArray(body.candidates) || !body.candidates.every(pendingReference)) {
      throw new Error("Invalid pending report response");
    }
    if (disposed) return;
    for (const candidate of body.candidates) {
      const item = document.createElement("article");
      item.append(element("h2", candidate.summary.title),
        element("p", `Incident: ${candidate.summary.id}`),
        element("p", `Created: ${candidate.summary.createdAt}`),
        element("p", `Candidate: ${candidate.id}`),
        element("p", `Snapshot SHA-256: ${candidate.sha256}`));
      const button = document.createElement("button");
      button.textContent = `Inspect ${candidate.id}`;
      button.onclick = () => { void run(() => inspect(candidate)); };
      item.append(button);
      list.append(item);
    }
    status.textContent = body.candidates.length ? `${body.candidates.length} pending report(s).` : "No pending reports.";
  }
  /** @param {{ id: string, sha256: string, summary: { id: string, title: string, createdAt: string } }} candidate */
  async function inspect(candidate) {
    selected = undefined;
    detail.hidden = true;
    detail.replaceChildren();
    const body = await request(`${endpoint}/${candidate.id}`);
    if (!record(body) || !reference(body.candidate) || body.candidate.id !== candidate.id ||
        body.candidate.sha256 !== candidate.sha256 || !record(body.candidate.entry)) {
      throw new Error("Candidate snapshot changed or response is invalid. Refresh pending reports.");
    }
    const entry = body.candidate.entry;
    if (entry.customer !== customer || !record(entry.summary) ||
        typeof entry.summary.id !== "string" || !/^incident-[0-9a-f]{32}$/.test(entry.summary.id) ||
        typeof entry.summary.title !== "string" || typeof entry.summary.createdAt !== "string" ||
        (entry.report !== undefined && (!record(entry.report) || typeof entry.report.html !== "string"))) {
      throw new Error("Invalid candidate content or customer scope");
    }
    if (entry.summary.id !== candidate.summary.id || entry.summary.title !== candidate.summary.title ||
        entry.summary.createdAt !== candidate.summary.createdAt) {
      throw new Error("Candidate metadata changed. Refresh pending reports.");
    }
    if (disposed) return;
    selected = { ...candidate, title: entry.summary.title, incident: entry.summary.id };
    detail.append(element("h2", entry.summary.title),
      element("p", `Incident: ${entry.summary.id}`), element("p", `Created: ${entry.summary.createdAt}`),
      element("p", `Snapshot SHA-256: ${candidate.sha256}`));
    const preview = element("pre", "No HTML report attached.");
    preview.setAttribute("aria-label", "Inert report preview");
    if (record(entry.report) && typeof entry.report.html === "string") {
      preview.textContent = entry.report.html;
      const rendered = createReviewPreview(entry.report.html);
      detail.append(element("h3", "Restricted rendered preview"),
        element("p", `Simplified text/table view. ${rendered.removed} unsupported or active element(s) removed or unwrapped; source attributes and styling are stripped. This is not a redaction check or an exact export rendering.`),
        rendered.search,
        rendered.frame);
    }
    const source = document.createElement("details");
    source.append(element("summary", "Original report source"), preview);
    detail.append(source);
    const reasonLabel = element("label", "Review reason");
    const reason = document.createElement("textarea");
    reason.maxLength = 2000;
    reasonLabel.append(reason);
    const checkedLabel = element("label", "I checked customer scope, redaction and disclosure suitability.");
    const checked = document.createElement("input");
    checked.type = "checkbox";
    checkedLabel.prepend(checked);
    detail.append(reasonLabel, checkedLabel);
    for (const decision of ["approve", "reject"]) {
      const button = document.createElement("button");
      button.textContent = decision === "approve" ? "Approve report" : "Reject report";
      button.onclick = () => {
        if (busy || !selected) return;
        if (!reason.value.trim() || !checked.checked) {
          error.textContent = "Enter a review reason and confirm the scope/redaction checks before continuing.";
          return;
        }
        const snapshot = selected;
        const reviewReason = reason.value;
        confirmation.textContent = `${decision === "approve" ? "Approve disclosure of" : "Reject"} "${snapshot.title}" for ${customer}, incident ${snapshot.incident}? Snapshot ${snapshot.sha256}. Reason: ${reviewReason}`;
        confirm.textContent = decision === "approve" ? "Confirm approval" : "Confirm rejection";
        commit = () => run(async () => {
          const result = await request(`${endpoint}/${snapshot.id}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision, reason: reviewReason, sha256: snapshot.sha256 }),
          });
          if (!record(result) || result.code !== "incident_review_recorded") throw new Error("Invalid review confirmation response");
          if (disposed) return;
          await load();
          status.textContent = `Review recorded: ${decision}. ${status.textContent}`;
        });
        dialog.showModal();
      };
      detail.append(button);
    }
    detail.hidden = false;
    status.textContent = "Review the exact snapshot below. No decision has been sent.";
  }
  refresh.onclick = () => { void run(load); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    accessToken = "";
    csrf = "";
    selected = undefined;
    commit = undefined;
    root.replaceChildren(element("p", "Review connection closed."));
  };
  disconnect = dispose;
  await run(load);
  return dispose;
}
