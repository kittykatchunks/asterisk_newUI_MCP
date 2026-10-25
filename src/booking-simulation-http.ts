import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAccessVerifier } from "./access.ts";
import type { ApplicationSessionIdentity } from "./application-session.ts";
import { BookingSimulationError, BookingSimulationInputError, BookingSimulationOwnershipError } from "./booking-simulation.ts";
import type { BookingSimulationStore, SimulationCase } from "./booking-simulation.ts";
import type { AccessAudit } from "./diagnostic-api.ts";
import { HttpInputError, readJsonBody } from "./http-json.ts";

const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const operationActions = ["edit", "review", "confirm", "submit", "reconcile", "handover"] as const;
type OperationAction = typeof operationActions[number];
type Target = { action: "list" | "conversation"; method: "GET" | "POST" } |
  { action: "create" | "read" | OperationAction; id: string; method: "GET" | "POST" };
function route(path: string, method: string | undefined): Target | undefined {
  if (path === "conversations") return method === "POST" ?
    { action: "conversation", method: "POST" } : { action: "list", method: "GET" };
  const draft = path.match(new RegExp(`^conversations/(synthetic-${uuid})/drafts$`));
  if (draft) return { action: "create", id: draft[1], method: "POST" };
  const operation = path.match(new RegExp(`^operations/(${uuid})(?:/(edit|review|confirm|submit|reconcile|handover))?$`));
  if (operation) {
    if (!operation[2]) return { action: "read", id: operation[1], method: "GET" };
    const action = operationActions.find((entry) => entry === operation[2]);
    if (action) return { action, id: operation[1], method: "POST" };
  }
  return undefined;
}
function input(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new HttpInputError(400, "invalid_booking_simulation_input");
  }
  return Object.fromEntries(Object.entries(value));
}

export async function handleBookingSimulationRequest(
  request: IncomingMessage, response: ServerResponse, requestId: string,
  customer: string, path: string, issuer: string,
  currentSession: () => ApplicationSessionIdentity | undefined,
  verify: ReturnType<typeof createAccessVerifier>,
  audit: (event: AccessAudit) => Promise<void>,
  store?: BookingSimulationStore,
) {
  let recorded = false;
  let subject: string | undefined;
  let bookingOperation: string | undefined;
  const record = (status: number, outcome: string) => audit({
    requestId, timestamp: new Date().toISOString(), customer, subject,
    operation: "booking-simulation", bookingOperation, status, outcome,
  });
  const send = async (status: number, code: string) => {
    if (!recorded) await record(status, code);
    request.resume();
    if (status === 401) response.setHeader("WWW-Authenticate", 'Session realm="simulation"');
    response.writeHead(status).end(JSON.stringify({ requestId, simulation: true, code }));
  };
  const session = currentSession();
  if (!session) { await send(401, "application_session_required"); return; }
  subject = session.subject;
  if (session.customer !== customer) { await send(403, "customer_access_denied"); return; }
  for (const permission of ["agent:access", "booking:simulate"] as const) {
    const access = await verify(request.headers.authorization, customer, permission);
    if (!access.allowed) { await send(access.status, access.code); return; }
    if (access.subject !== session.subject || access.basis !== "membership") {
      throw new Error("Booking simulation session identity mismatch");
    }
  }
  if (!store) { await send(503, "booking_simulation_disabled"); return; }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.search) { await send(400, "invalid_booking_simulation_query"); return; }
  const target = route(path, request.method);
  if (!target) { await send(404, "booking_simulation_route_not_found"); return; }
  if (request.method !== target.method) {
    response.setHeader("Allow", path === "conversations" ? "GET, POST" : target.method);
    await send(405, "method_not_allowed"); return;
  }
  const workspace = store.forOwner({ issuer, subject, customer });
  try {
    let value: Record<string, unknown> = {};
    if (target.method === "POST") {
      const keys = target.action === "create" ? ["details"] : target.action === "edit" ? ["details", "revision"] :
        target.action === "confirm" || target.action === "review" ? ["revision"] : target.action === "submit" ? ["scenario", "revision"] :
          target.action === "handover" ? ["reason"] : [];
      value = input(await readJsonBody(request, "booking_simulation", 2048), keys);
      if (["edit", "review", "confirm", "submit"].includes(target.action) &&
          (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1)) {
        throw new HttpInputError(400, "invalid_booking_simulation_revision");
      }
      if (target.action === "submit" &&
          !["accept", "reject", "lose-reply", "unresolved"].some((scenario) => scenario === value.scenario)) {
        throw new HttpInputError(400, "invalid_booking_simulation_scenario");
      }
      if (target.action === "handover" &&
          !["human_requested", "caller_disconnected", "unsupported_request"].some((reason) => reason === value.reason)) {
        throw new HttpInputError(400, "invalid_booking_simulation_handover");
      }
    }
    // Check ownership before recording a guessed ID as an authorised operation.
    if ("id" in target && target.action !== "create") {
      workspace.read(target.id);
      bookingOperation = target.id;
    }
    await record(200, `simulation_${target.action}_${target.method === "POST" ? "requested" : "view_requested"}`);
    recorded = true;
    // Body parsing and auditing may yield to logout or session rotation.
    const live = currentSession();
    if (!live || live.sessionId !== session.sessionId || live.subject !== subject || live.customer !== customer) {
      await send(401, "application_session_required"); return;
    }
    let result;
    switch (target.action) {
      case "list": result = { conversations: workspace.list() }; break;
      case "conversation": result = workspace.createConversation(); break;
      case "create": result = workspace.create(target.id, value.details); break;
      case "read": result = workspace.read(target.id); break;
      case "edit": result = workspace.edit(target.id, value.details, Number(value.revision)); break;
      case "review": result = workspace.review(target.id, Number(value.revision)); break;
      case "confirm": result = workspace.confirm(target.id, Number(value.revision)); break;
      case "submit": result = workspace.submit(target.id, value.scenario as SimulationCase, Number(value.revision)); break;
      case "reconcile": result = workspace.reconcile(target.id); break;
      case "handover": result = workspace.handover(target.id,
        value.reason as "human_requested" | "caller_disconnected" | "unsupported_request"); break;
    }
    response.writeHead(200).end(JSON.stringify({ requestId, simulation: true, customer, result }));
  } catch (error) {
    if (error instanceof HttpInputError) {
      if (error.status === 408 || error.status === 413) response.setHeader("Connection", "close");
      await send(error.status, error.code); return;
    }
    if (error instanceof BookingSimulationOwnershipError) {
      await send(404, "simulation_resource_not_found"); return;
    }
    if (error instanceof BookingSimulationInputError) {
      await send(400, "invalid_booking_simulation_input"); return;
    }
    if (error instanceof BookingSimulationError) {
      await send(409, "booking_simulation_conflict"); return;
    }
    throw error;
  }
}
