import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertAgentIdentity, type AgentIdentity } from "./agent-directory.ts";

export type BookingState = "collecting" | "awaiting confirmation" | "submitting" |
  "accepted" | "rejected" | "outcome unknown";
export type SimulationCase = "accept" | "reject" | "lose-reply" | "unresolved";
export interface SyntheticJourney {
  pickup: string;
  destination: string;
  passenger: string;
  contact: string;
  passengers: number;
}
interface Transition { state: BookingState; reason: string; revision: number }
export interface SimulatedBooking {
  simulation: true;
  id: string;
  customer: string;
  conversation: string;
  revision: number;
  confirmedRevision: number | null;
  state: BookingState;
  details: SyntheticJourney;
  summary: string;
  reference: string | null;
  reason: string;
  history: Transition[];
}
export class BookingSimulationError extends Error {}
export class BookingSimulationInputError extends BookingSimulationError {}
export class BookingSimulationOwnershipError extends BookingSimulationError {}
class UncertainSimulationOutcome extends Error {}
const customers = ["customer-a", "customer-b"];
const states: BookingState[] = ["collecting", "awaiting confirmation", "submitting",
  "accepted", "rejected", "outcome unknown"];
const scenarios: SimulationCase[] = ["accept", "reject", "lose-reply", "unresolved"];
const reasons = ["draft_created", "draft_edited", "summary_presented", "explicit_confirmation",
  "submission_committed", "simulated_acceptance", "simulated_rejection", "simulated_uncertainty"];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function scope(customer: string, conversation?: string) {
  if (!customers.includes(customer) || (conversation !== undefined &&
      !/^synthetic-[a-z0-9-]{1,64}$/.test(conversation))) {
    throw new BookingSimulationInputError("Invalid synthetic customer/conversation scope");
  }
}
function journey(customer: string, value: unknown): SyntheticJourney {
  scope(customer);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "contact,destination,passenger,passengers,pickup" ||
      !("pickup" in value) || !("destination" in value) ||
      typeof value.pickup !== "string" || typeof value.destination !== "string" ||
      ![value.pickup, value.destination].every((id) =>
        id === `${customer}-station` || id === `${customer}-hotel`) ||
      value.pickup === value.destination ||
      !("passenger" in value) || typeof value.passenger !== "string" ||
      !/^Synthetic [A-Za-z ]{1,64}$/.test(value.passenger) ||
      !("contact" in value) || typeof value.contact !== "string" ||
      !/^test-contact-[a-z0-9-]{1,32}$/.test(value.contact) ||
      !("passengers" in value) || typeof value.passengers !== "number" ||
      !Number.isInteger(value.passengers) || value.passengers < 1 || value.passengers > 8) {
    throw new BookingSimulationInputError("Invalid or unsupported synthetic journey");
  }
  return { pickup: value.pickup, destination: value.destination,
    passenger: value.passenger, contact: value.contact, passengers: value.passengers };
}
function summary(details: SyntheticJourney) {
  return `SIMULATION: book now; ${details.pickup} -> ${details.destination}; ` +
    `${details.passenger}; ${details.contact}; passengers ${details.passengers}`;
}
function validate(value: unknown): asserts value is SimulatedBooking {
  if (typeof value !== "object" || value === null) throw new Error("Corrupt booking simulation record");
  const b = value as Partial<SimulatedBooking>;
  if (typeof b.customer !== "string" || typeof b.conversation !== "string" ||
      typeof b.id !== "string" || !uuid.test(b.id) || b.simulation !== true ||
      typeof b.revision !== "number" || !Number.isSafeInteger(b.revision) || b.revision < 1 ||
      !(b.confirmedRevision === null || b.confirmedRevision === b.revision) ||
      !b.state || !states.includes(b.state) || !b.reason || !reasons.includes(b.reason) ||
      !Array.isArray(b.history) || b.history.length === 0) throw new Error("Corrupt booking simulation record");
  const revision = b.revision;
  let details: SyntheticJourney;
  try {
    scope(b.customer, b.conversation);
    details = journey(b.customer, b.details);
  } catch (error) {
    if (error instanceof BookingSimulationInputError) {
      throw new Error("Corrupt booking simulation record", { cause: error });
    }
    throw error;
  }
  if (b.summary !== summary(details) ||
      (b.state === "accepted" ? b.reference !== `SIM-${b.id}` : b.reference !== null) ||
      (["submitting", "accepted", "rejected", "outcome unknown"].includes(b.state) &&
        b.confirmedRevision !== b.revision) ||
      b.history.some((entry) => !entry || !states.includes(entry.state) ||
        !reasons.includes(entry.reason) || !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1 || entry.revision > revision) ||
      b.history.at(-1)?.state !== b.state || b.history.at(-1)?.reason !== b.reason ||
      b.history.at(-1)?.revision !== b.revision) throw new Error("Corrupt booking simulation record");
}

// The customer-only methods remain trusted harness APIs; HTTP must use forOwner.
export function openBookingSimulation(path: string, options: {
  afterEffect?: () => void;
} = {}) {
  if (!isAbsolute(path)) throw new Error("Booking simulation requires an absolute database path");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported booking simulation schema");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error("Refusing nonempty unversioned booking database");
      }
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE simulated_bookings (id TEXT PRIMARY KEY, customer TEXT NOT NULL, record TEXT NOT NULL) STRICT;
        CREATE TABLE simulated_dispatch (id TEXT PRIMARY KEY, customer TEXT NOT NULL,
          payload TEXT NOT NULL, scenario TEXT NOT NULL, outcome TEXT NOT NULL) STRICT;
        PRAGMA user_version = 1; COMMIT;`);
    }
    db.prepare("SELECT id, customer, record FROM simulated_bookings LIMIT 0");
    db.prepare("SELECT id, customer, payload, scenario, outcome FROM simulated_dispatch LIMIT 0");
    if (version === 0 || version === 1) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE simulated_conversations (id TEXT PRIMARY KEY, customer TEXT NOT NULL,
          issuer TEXT NOT NULL, subject TEXT NOT NULL) STRICT;
        PRAGMA user_version = 2; COMMIT;`);
    }
    for (const row of db.prepare("SELECT id, customer, issuer, subject FROM simulated_conversations").all()) {
      assertAgentIdentity(row);
      scope(row.customer, String(row.id));
      if (typeof row.id !== "string" || !row.id.startsWith("synthetic-") ||
          !uuid.test(row.id.slice("synthetic-".length))) throw new Error("Corrupt simulation conversation");
    }
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Corrupt booking database");
    for (const row of db.prepare("SELECT id, customer, record FROM simulated_bookings").all()) {
      const record: unknown = JSON.parse(String(row.record));
      validate(record);
      if (record.id !== row.id || record.customer !== row.customer) throw new Error("Stored booking scope mismatch");
    }
  } catch (error) { db.close(); throw error; }
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function read(customer: string, id: string): SimulatedBooking {
    scope(customer);
    if (!uuid.test(id)) throw new BookingSimulationInputError("Invalid operation ID");
    const row = db.prepare("SELECT record FROM simulated_bookings WHERE customer = ? AND id = ?").get(customer, id);
    if (!row) throw new BookingSimulationError("Booking operation not found in customer scope");
    const value: unknown = JSON.parse(String(row.record));
    validate(value);
    if (value.customer !== customer || value.id !== id) throw new Error("Stored booking scope mismatch");
    const effect = dispatchRead(value);
    if (["accepted", "rejected"].includes(value.state) && effect?.outcome !== value.state) {
      throw new Error("Stored booking outcome does not match simulated dispatch");
    }
    return value;
  }
  function save(b: SimulatedBooking) {
    validate(b);
    db.prepare("UPDATE simulated_bookings SET record = ? WHERE customer = ? AND id = ?")
      .run(JSON.stringify(b), b.customer, b.id);
    return b;
  }
  function transition(b: SimulatedBooking, state: BookingState, reason: string) {
    b.state = state; b.reason = reason;
    b.history.push({ state, reason, revision: b.revision });
    return save(b);
  }
  function payload(b: SimulatedBooking) {
    return JSON.stringify({ conversation: b.conversation, revision: b.revision, details: b.details });
  }
  function dispatchRead(b: SimulatedBooking) {
    const row = db.prepare("SELECT * FROM simulated_dispatch WHERE id = ?").get(b.id);
    if (!row) return undefined;
    if (row.customer !== b.customer || row.payload !== payload(b) ||
        !scenarios.some((scenario) => scenario === row.scenario) ||
        row.outcome !== (row.scenario === "unresolved" ? "outcome unknown" :
          row.scenario === "reject" ? "rejected" : "accepted")) {
      throw new Error("Conflicting or corrupt simulated dispatch record");
    }
    return { outcome: String(row.outcome), scenario: String(row.scenario) };
  }
  function noUncertainReplacement(customer: string, conversation: string, id?: string) {
    for (const row of db.prepare("SELECT id FROM simulated_bookings WHERE customer = ?").all(customer)) {
      const previous = read(customer, String(row.id));
      if (previous.id !== id && previous.conversation === conversation &&
          ["submitting", "outcome unknown"].includes(previous.state)) {
        throw new BookingSimulationError("Reconcile the existing uncertain operation; do not create a replacement");
      }
    }
  }
  function settle(b: SimulatedBooking, outcome: string | undefined) {
    if (!["submitting", "outcome unknown"].includes(b.state)) return b;
    if (outcome === "accepted") {
      b.reference = `SIM-${b.id}`;
      return transition(b, "accepted", "simulated_acceptance");
    }
    return outcome === "rejected" ? transition(b, "rejected", "simulated_rejection") :
      transition(b, "outcome unknown", "simulated_uncertainty");
  }
  try {
    for (const row of db.prepare("SELECT id, customer FROM simulated_bookings").all()) {
      read(String(row.customer), String(row.id));
    }
    for (const row of db.prepare("SELECT id, customer FROM simulated_dispatch").all()) {
      read(String(row.customer), String(row.id));
    }
  } catch (error) { db.close(); throw error; }
  const store = {
    create(customer: string, conversation: string, input: unknown) {
      if (typeof conversation !== "string") throw new BookingSimulationInputError("Synthetic conversation required");
      scope(customer, conversation);
      const details = journey(customer, input);
      return transaction(() => {
        noUncertainReplacement(customer, conversation);
        const b: SimulatedBooking = { simulation: true, id: randomUUID(), customer, conversation,
          revision: 1, confirmedRevision: null, state: "collecting", details, summary: summary(details),
          reference: null, reason: "draft_created",
          history: [{ state: "collecting", reason: "draft_created", revision: 1 }] };
        db.prepare("INSERT INTO simulated_bookings VALUES (?, ?, ?)").run(b.id, customer, JSON.stringify(b));
        return b;
      });
    },
    read,
    edit(customer: string, id: string, input: unknown, expectedRevision?: number) {
      const details = journey(customer, input);
      return transaction(() => {
        const b = read(customer, id);
        if (expectedRevision !== undefined && expectedRevision !== b.revision) throw new BookingSimulationError("Current revision required");
        if (!["collecting", "awaiting confirmation"].includes(b.state)) throw new BookingSimulationError("Submitted payload is immutable");
        b.details = details; b.summary = summary(details); b.revision++; b.confirmedRevision = null;
        return transition(b, "collecting", "draft_edited");
      });
    },
    review(customer: string, id: string, expectedRevision?: number) {
      return transaction(() => {
        const b = read(customer, id);
        if (expectedRevision !== undefined && expectedRevision !== b.revision) throw new BookingSimulationError("Current revision required");
        if (b.state !== "collecting") throw new BookingSimulationError("Draft is not collecting");
        return transition(b, "awaiting confirmation", "summary_presented");
      });
    },
    confirm(customer: string, id: string, revision: number) {
      return transaction(() => {
        const b = read(customer, id);
        if (b.state !== "awaiting confirmation" || revision !== b.revision) throw new BookingSimulationError("Current summary confirmation required");
        b.confirmedRevision = revision;
        return transition(b, "awaiting confirmation", "explicit_confirmation");
      });
    },
    submit(customer: string, id: string, scenario: SimulationCase, expectedRevision?: number) {
      if (!scenarios.includes(scenario)) throw new BookingSimulationInputError("Invalid simulation case");
      const b = transaction(() => {
        const current = read(customer, id);
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new BookingSimulationError("Current revision required");
        if (["accepted", "rejected", "outcome unknown"].includes(current.state)) return current;
        if (current.state !== "awaiting confirmation" || current.confirmedRevision !== current.revision) {
          throw new BookingSimulationError("Confirm current revision or reconcile pending submission");
        }
        noUncertainReplacement(customer, current.conversation, current.id);
        return transition(current, "submitting", "submission_committed");
      });
      if (b.state !== "submitting") return b;
      try {
        const result = transaction(() => {
          const existing = dispatchRead(b);
          if (existing) return existing;
          const outcome = scenario === "unresolved" ? "outcome unknown" :
            scenario === "reject" ? "rejected" : "accepted";
          db.prepare("INSERT INTO simulated_dispatch VALUES (?, ?, ?, ?, ?)")
            .run(id, customer, payload(b), scenario, outcome);
          return { outcome, scenario };
        });
        options.afterEffect?.();
        if (result.scenario === "lose-reply" || result.outcome === "outcome unknown") throw new UncertainSimulationOutcome();
        return transaction(() => settle(read(customer, id), result.outcome));
      } catch (error) {
        if (!(error instanceof UncertainSimulationOutcome)) throw error;
        return transaction(() => settle(read(customer, id), "outcome unknown"));
      }
    },
    reconcile(customer: string, id: string) {
      return transaction(() => {
        const b = read(customer, id);
        if (!["submitting", "outcome unknown"].includes(b.state)) return b;
        return settle(b, dispatchRead(b)?.outcome);
      });
    },
    handover(customer: string, id: string, reason: "caller_disconnected" | "human_requested" | "unsupported_request") {
      if (!["caller_disconnected", "human_requested", "unsupported_request"].includes(reason)) throw new BookingSimulationInputError("Invalid handover reason");
      return { ...read(customer, id), handoverReason: reason };
    },
    close() { db.close(); },
  };
  return {
    ...store,
    forOwner(identity: AgentIdentity) {
      assertAgentIdentity(identity);
      const owner = { ...identity };
      scope(owner.customer);
      function conversation(id: string) {
        if (!db.prepare(`SELECT 1 FROM simulated_conversations
            WHERE id = ? AND customer = ? AND issuer = ? AND subject = ?`)
          .get(id, owner.customer, owner.issuer, owner.subject)) {
          throw new BookingSimulationOwnershipError("Simulation resource not found in owner scope");
        }
      }
      function operation(id: string) {
        if (!uuid.test(id)) throw new BookingSimulationOwnershipError("Simulation resource not found in owner scope");
        const row = db.prepare(`SELECT b.record FROM simulated_bookings b
          JOIN simulated_conversations c ON c.id = json_extract(b.record, '$.conversation')
            AND c.customer = b.customer
          WHERE b.id = ? AND c.customer = ? AND c.issuer = ? AND c.subject = ?`)
          .get(id, owner.customer, owner.issuer, owner.subject);
        if (!row) throw new BookingSimulationOwnershipError("Simulation resource not found in owner scope");
        return read(owner.customer, id);
      }
      return {
        createConversation() {
          return transaction(() => {
            const id = `synthetic-${randomUUID()}`;
            if (db.prepare("SELECT 1 FROM simulated_bookings WHERE json_extract(record, '$.conversation') = ?").get(id)) {
              throw new Error("Simulation conversation ID collision");
            }
            db.prepare("INSERT INTO simulated_conversations VALUES (?, ?, ?, ?)").run(
              id, owner.customer, owner.issuer, owner.subject);
            return { simulation: true as const, customer: owner.customer, conversation: id };
          });
        },
        list() {
          return db.prepare(`SELECT id FROM simulated_conversations
            WHERE customer = ? AND issuer = ? AND subject = ? ORDER BY id`)
            .all(owner.customer, owner.issuer, owner.subject).map((row) => {
              const id = String(row.id);
              const operations = db.prepare(`SELECT id FROM simulated_bookings
                  WHERE customer = ? AND json_extract(record, '$.conversation') = ? ORDER BY id`)
                .all(owner.customer, id).map((entry) => {
                  const b = operation(String(entry.id));
                  return { id: b.id, state: b.state, revision: b.revision };
                });
              return { simulation: true as const, customer: owner.customer, conversation: id, operations };
            });
        },
        create(id: string, input: unknown) {
          conversation(id);
          return store.create(owner.customer, id, input);
        },
        read: operation,
        edit(id: string, input: unknown, revision: number) {
          operation(id);
          return store.edit(owner.customer, id, input, revision);
        },
        review(id: string, revision: number) {
          operation(id);
          return store.review(owner.customer, id, revision);
        },
        confirm(id: string, revision: number) {
          operation(id);
          return store.confirm(owner.customer, id, revision);
        },
        submit(id: string, scenario: SimulationCase, revision: number) {
          operation(id);
          return store.submit(owner.customer, id, scenario, revision);
        },
        reconcile(id: string) {
          operation(id);
          return store.reconcile(owner.customer, id);
        },
        handover(id: string, reason: Parameters<typeof store.handover>[2]) {
          operation(id);
          return store.handover(owner.customer, id, reason);
        },
      };
    },
  };
}
export type BookingSimulationStore = ReturnType<typeof openBookingSimulation>;
