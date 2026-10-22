import type { DiagnosticStore } from "../src/diagnostic-store.ts";
import type { ApprovedIncident } from "../src/incidents.ts";

// Synthetic fixtures only; this is not automated approval for customer evidence.
export function approveSyntheticIncidents(store: DiagnosticStore, entries: readonly ApprovedIncident[]) {
  for (const candidate of store.stage(entries)) {
    store.review(candidate.id, {
      sha256: candidate.sha256, decision: "approve",
      reviewer: "synthetic-fixture-reviewer", reason: "Known synthetic report fixture; no customer data",
    });
  }
}
