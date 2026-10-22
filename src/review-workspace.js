// @ts-check
import { createReviewPreview } from "./review-preview.js";

/** @param {Response} response */
export function requestReference(response) {
  const id = response.headers.get("X-Request-Id");
  return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : "unavailable";
}

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
 * @param {string | { csrf: string, signal?: AbortSignal, onUnauthorized?: () => void }} connection
 * @returns {Promise<() => void>}
 */
export async function connectReviewWorkspace(connection) {
  let accessToken = typeof connection === "string" ? connection : "";
  let csrf = typeof connection === "string" ? "" : connection.csrf;
  const sessionSignal = typeof connection === "string" ? undefined : connection.signal;
  const onUnauthorized = typeof connection === "string" ? undefined : connection.onUnauthorized;
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
  const decisionReceipt = element("p", "");
  decisionReceipt.setAttribute("role", "status");
  decisionReceipt.setAttribute("aria-label", "Last confirmed review");
  decisionReceipt.hidden = true;
  const error = element("p", "");
  error.setAttribute("role", "alert");
  error.tabIndex = -1;
  /** @type {HTMLElement | undefined} */
  let focusAfterRequest;
  function restoreRequestFocus() {
    focusAfterRequest?.focus();
    focusAfterRequest = undefined;
  }
  const refresh = document.createElement("button");
  refresh.textContent = "Refresh pending reports";
  const list = document.createElement("section");
  list.setAttribute("aria-label", "Pending reports");
  const filterControls = document.createElement("div");
  filterControls.hidden = true;
  const filterLabel = element("label", "Filter pending reports");
  const filter = document.createElement("input");
  filter.type = "search";
  filter.maxLength = 200;
  filterLabel.append(filter);
  const clearFilter = document.createElement("button");
  clearFilter.textContent = "Clear pending filter";
  const filterStatus = element("p", "");
  filterStatus.setAttribute("role", "status");
  const orderLabel = document.createElement("label");
  orderLabel.textContent = "Sort pending reports";
  orderLabel.htmlFor = "pending-report-order";
  const order = document.createElement("select");
  order.id = "pending-report-order";
  for (const [value, text] of [
    ["candidate", "Candidate ID (default)"], ["oldest", "Created: oldest first"], ["newest", "Created: newest first"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    order.append(option);
  }
  filterControls.append(filterLabel, clearFilter, orderLabel, order, filterStatus,
    element("p", "Filters loaded titles, incident IDs and candidate IDs only. It does not search report contents or change the open review."));
  /** @type {{ item: HTMLElement, fields: string[], id: string, createdAt: number }[]} */
  let cards = [];
  function applyOrder() {
    const sorted = [...cards].sort((a, b) => {
      const dateOrder = order.value === "oldest" ? a.createdAt - b.createdAt
        : order.value === "newest" ? b.createdAt - a.createdAt : 0;
      return dateOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    for (const card of sorted) list.append(card.item);
  }
  function applyFilter() {
    const query = filter.value.trim().toLowerCase();
    if (filter.value.length > filter.maxLength) {
      filterStatus.textContent = "Filter is limited to 200 characters. The displayed list has not changed.";
      return;
    }
    let visible = 0;
    for (const card of cards) {
      card.item.hidden = !card.fields.some((field) => field.includes(query));
      if (!card.item.hidden) visible++;
    }
    filterStatus.textContent = `${visible} of ${cards.length} loaded pending report(s) shown.` +
      (query && !visible ? " No matches. Clear the filter to show all loaded pending reports." : "") +
      ` Order: ${order.selectedOptions.item(0)?.textContent}.`;
  }
  order.onchange = () => { applyOrder(); applyFilter(); };
  filter.oninput = applyFilter;
  filter.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); applyFilter(); }
  };
  clearFilter.onclick = () => { filter.value = ""; applyFilter(); };
  const detail = document.createElement("section");
  detail.setAttribute("aria-label", "Candidate review");
  detail.hidden = true;
  root.append(warning, status, decisionReceipt, error, refresh, filterControls, list, detail);

  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Confirm review decision");
  const confirmation = element("p", "");
  const confirm = document.createElement("button");
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.autofocus = true;
  dialog.append(confirmation, confirm, cancel);
  root.append(dialog);
  cancel.onclick = () => dialog.close();
  /** @type {(() => Promise<void>) | undefined} */
  let commit;
  let hasDraft = () => false;
  /** @param {BeforeUnloadEvent} event */
  const warnBeforeUnload = (event) => {
    if (disposed || !selected || !hasDraft()) return;
    event.preventDefault();
    event.returnValue = true;
  };
  function updateUnloadWarning() {
    window.removeEventListener("beforeunload", warnBeforeUnload);
    if (!disposed && selected && hasDraft()) window.addEventListener("beforeunload", warnBeforeUnload);
  }
  confirm.onclick = () => {
    const action = commit;
    dialog.close();
    if (action) void action();
  };
  dialog.onclose = () => {
    commit = undefined;
    confirmation.textContent = "";
  };
  /** @param {() => Promise<void>} action @param {string} message @param {string} buttonText */
  function leaveReview(action, message, buttonText) {
    if (busy || disposed) return;
    if (!selected || !hasDraft()) { void action(); return; }
    dialog.setAttribute("aria-label", "Discard local review");
    confirmation.textContent = `${message} Discard the entered reason and scope check? No approval or rejection will be sent.`;
    confirm.textContent = buttonText;
    commit = action;
    dialog.showModal();
  }
  function clearReview() {
    selected = undefined;
    hasDraft = () => false;
    updateUnloadWarning();
    detail.replaceChildren();
    detail.hidden = true;
  }

  /** @param {string} path @param {RequestInit} [options] @returns {Promise<unknown>} */
  async function request(path, options = {}) {
    if (disposed) throw new DOMException("Review connection closed", "AbortError");
    /** @type {Response} */
    let response;
    try { response = await fetch(path, {
      ...options, credentials: csrf ? "same-origin" : "omit", cache: "no-store", redirect: "error",
      headers: { ...(csrf ? { "X-CSRF-Token": csrf } : { Authorization: `Bearer ${accessToken}` }), ...(options.headers ?? {}) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    }); } catch (cause) {
      if (disposed) throw cause;
      if (!(cause instanceof TypeError) && !(cause instanceof DOMException)) throw cause;
      const detail = cause instanceof DOMException && cause.name === "TimeoutError" ? "Request timed out" : "Failed to fetch";
      throw new Error(`${detail} (request unavailable). Refresh before retrying; a lost response may follow a committed decision. No automatic retry was sent.`, { cause });
    }
    if (response.status === 401 && onUnauthorized) {
      onUnauthorized();
      throw new Error("Application session is no longer valid. Sign in again. Check the report state before retrying any decision.");
    }
    const requestId = requestReference(response);
    let body;
    try { body = await response.json(); }
    catch (cause) {
      if (disposed) throw cause;
      if (cause instanceof TypeError || cause instanceof DOMException) {
        throw new Error(`Response interrupted (${response.status}; request ${requestId}). Refresh before retrying; a lost response may follow a committed decision. No automatic retry was sent.`, { cause });
      }
      if (!(cause instanceof SyntaxError)) throw cause;
      throw new Error(`Invalid JSON response (${response.status}; request ${requestId}). Refresh before retrying; a lost response may follow a committed decision.`);
    }
    if (!response.ok) {
      const code = record(body) && typeof body.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(body.code)
        ? body.code : "invalid_error_response";
      throw new Error(`Request failed (${response.status}: ${code}; request ${requestId}). Refresh before retrying; a lost response may follow a committed decision.`);
    }
    return body;
  }
  function controls() {
    refresh.disabled = busy;
    filter.disabled = busy;
    order.disabled = busy;
    root.querySelectorAll("button").forEach((button) => {
      if (button !== refresh) button.disabled = busy;
    });
  }
  /** @param {unknown} cause */
  function failure(cause) {
    if (disposed) return;
    error.textContent = cause instanceof Error ? cause.message : "Review operation failed";
    status.textContent = "";
    clearReview();
    focusAfterRequest = error;
  }
  /** @param {() => Promise<void>} operation */
  async function run(operation) {
    if (busy || disposed) return;
    busy = true;
    focusAfterRequest = undefined;
    error.textContent = "";
    controls();
    try { await operation(); }
    catch (cause) { failure(cause); }
    finally {
      busy = false;
      if (!disposed) {
        controls();
        restoreRequestFocus();
      }
    }
  }
  async function load() {
    if (disposed) return;
    clearReview();
    list.replaceChildren();
    cards = [];
    filterControls.hidden = true;
    filterStatus.textContent = "";
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
      button.onclick = () => leaveReview(() => run(() => inspect(candidate)),
        `Open candidate ${candidate.id} instead of the current review?`, "Discard and open");
      item.append(button);
      list.append(item);
      cards.push({ item, id: candidate.id, createdAt: Date.parse(candidate.summary.createdAt),
        fields: [candidate.summary.title, candidate.summary.id, candidate.id]
        .map((field) => field.toLowerCase()) });
    }
    applyOrder();
    filterControls.hidden = false;
    applyFilter();
    status.textContent = body.candidates.length ? `${body.candidates.length} pending report(s).` : "No pending reports.";
    focusAfterRequest = filter;
  }
  /** @param {{ id: string, sha256: string, summary: { id: string, title: string, createdAt: string } }} candidate */
  async function inspect(candidate) {
    clearReview();
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
    const heading = element("h2", entry.summary.title);
    heading.tabIndex = -1;
    detail.append(heading,
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
    hasDraft = () => reason.value.length > 0 || checked.checked;
    reason.oninput = updateUnloadWarning;
    checked.onchange = updateUnloadWarning;
    const close = document.createElement("button");
    close.textContent = "Close review without deciding";
    const closeReview = async () => {
      clearReview();
      commit = undefined;
      confirmation.textContent = "";
      error.textContent = "";
      status.textContent = "Review closed. No decision sent. The report remains pending.";
      filter.focus();
    };
    close.onclick = () => {
      if (!selected) return;
      leaveReview(closeReview, "Close this review? The report will remain pending.", "Discard and close");
    };
    detail.append(close);
    for (const decision of ["approve", "reject"]) {
      const button = document.createElement("button");
      button.textContent = decision === "approve" ? "Approve report" : "Reject report";
      button.onclick = () => {
        if (busy || !selected) return;
        if (!reason.value.trim() || !checked.checked) {
          error.textContent = "Enter a review reason and confirm the scope/redaction checks before continuing.";
          error.focus();
          return;
        }
        const snapshot = selected;
        const reviewReason = reason.value;
        dialog.setAttribute("aria-label", "Confirm review decision");
        confirmation.textContent = `${decision === "approve" ? "Approve disclosure of" : "Reject"} "${snapshot.title}" for ${customer}, incident ${snapshot.incident}? Snapshot ${snapshot.sha256}. Reason: ${reviewReason}`;
        confirm.textContent = decision === "approve" ? "Confirm approval" : "Confirm rejection";
        commit = () => run(async () => {
          const result = await request(`${endpoint}/${snapshot.id}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision, reason: reviewReason, sha256: snapshot.sha256 }),
          });
          if (!record(result) || result.code !== "incident_review_recorded") throw new Error("Invalid review confirmation response");
          if (disposed) return;
          decisionReceipt.textContent = `Confirmed review: ${decision}. Candidate: ${snapshot.id}. Snapshot SHA-256: ${snapshot.sha256}. This decision was recorded; any following list-refresh error does not undo it. Do not submit it again.`;
          decisionReceipt.hidden = false;
          await load();
          status.textContent = `Review recorded: ${decision}. ${status.textContent}`;
        });
        dialog.showModal();
      };
      detail.append(button);
    }
    detail.hidden = false;
    status.textContent = "Review the exact snapshot below. No decision has been sent.";
    focusAfterRequest = heading;
  }
  refresh.onclick = () => leaveReview(() => run(load), "Refresh the pending list and close the current review?", "Discard and refresh");
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    sessionSignal?.removeEventListener("abort", dispose);
    controller.abort();
    accessToken = "";
    csrf = "";
    selected = undefined;
    hasDraft = () => false;
    updateUnloadWarning();
    commit = undefined;
    cards = [];
    filter.value = "";
    root.replaceChildren(element("p", "Review connection closed."));
  };
  disconnect = dispose;
  sessionSignal?.addEventListener("abort", dispose, { once: true });
  if (sessionSignal?.aborted) dispose();
  await run(load);
  return dispose;
}
