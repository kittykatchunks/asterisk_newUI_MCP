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

// Trusted ingestion is responsible for redaction approval. Hashes establish
// consistency with that approval, not that arbitrary HTML is safe.
export function createIncidentCatalog(entries: readonly ApprovedIncident[]): IncidentCatalog {
  const snapshot = structuredClone(entries);
  const seen = new Set<string>();
  for (const entry of snapshot) {
    const key = `${entry.customer}/${entry.summary.id}`;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.customer) ||
        !/^incident-[0-9a-f]{32}$/.test(entry.summary.id) ||
        !entry.summary.title.trim() || entry.summary.title.length > 200 ||
        !Number.isFinite(Date.parse(entry.summary.createdAt)) || seen.has(key)) {
      throw new Error("Invalid or duplicate incident catalog entry");
    }
    seen.add(key);
    if (entry.report && (Buffer.byteLength(entry.report.html) > 2 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(entry.report.sha256) ||
        createHash("sha256").update(entry.report.html).digest("hex") !== entry.report.sha256)) {
      throw new Error("Approved incident report integrity check failed");
    }
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
