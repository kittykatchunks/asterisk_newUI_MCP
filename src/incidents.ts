import { createHash } from "node:crypto";

export interface IncidentSummary {
  id: string;
  title: string;
  createdAt: string;
}

export interface ApprovedIncident {
  customer: string;
  summary: IncidentSummary;
  report?: { html: string; sha256: string };
}

export interface IncidentCatalog {
  list(customer: string): Promise<IncidentSummary[]>;
  report(customer: string, incident: string): Promise<string | undefined>;
}

export function assertApprovedIncident(entry: unknown): asserts entry is ApprovedIncident {
  if (typeof entry !== "object" || entry === null ||
      !("customer" in entry) || typeof entry.customer !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.customer) ||
      !("summary" in entry) || typeof entry.summary !== "object" || entry.summary === null ||
      !("id" in entry.summary) || typeof entry.summary.id !== "string" ||
      !/^incident-[0-9a-f]{32}$/.test(entry.summary.id) ||
      !("title" in entry.summary) || typeof entry.summary.title !== "string" ||
      !entry.summary.title.trim() || entry.summary.title.length > 200 ||
      !("createdAt" in entry.summary) || typeof entry.summary.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.summary.createdAt))) {
    throw new Error("Invalid incident catalog entry");
  }
  if ("report" in entry && entry.report !== undefined) {
    const report = entry.report;
    if (typeof report !== "object" || report === null ||
        !("html" in report) || typeof report.html !== "string" ||
        Buffer.byteLength(report.html) > 2 * 1024 * 1024 ||
        !("sha256" in report) || typeof report.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(report.sha256) ||
        createHash("sha256").update(report.html).digest("hex") !== report.sha256) {
      throw new Error("Approved incident report integrity check failed");
    }
  }
}

// Trusted ingestion is responsible for redaction approval. Hashes establish
// consistency with that approval, not that arbitrary HTML is safe.
export function createIncidentCatalog(entries: readonly ApprovedIncident[]): IncidentCatalog {
  const snapshot = structuredClone(entries);
  const seen = new Set<string>();
  for (const entry of snapshot) {
    assertApprovedIncident(entry);
    const key = `${entry.customer}/${entry.summary.id}`;
    if (seen.has(key)) {
      throw new Error("Invalid or duplicate incident catalog entry");
    }
    seen.add(key);
  }
  return {
    async list(customer) {
      return snapshot.filter((entry) => entry.customer === customer)
        .map((entry) => ({ id: entry.summary.id, title: entry.summary.title, createdAt: entry.summary.createdAt }));
    },
    async report(customer, incident) {
      return snapshot.find((entry) => entry.customer === customer &&
        entry.summary.id === incident)?.report?.html;
    },
  };
}
