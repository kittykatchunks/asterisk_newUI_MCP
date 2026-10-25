import { DatabaseSync } from "node:sqlite";
import { openCelHistory } from "../../src/cel-history.ts";
import { collectCelOnce } from "../../src/cel-collector.ts";
import { collectQueueOnce } from "../../src/queue-collector.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";
import { createDiagnosticApi } from "../../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../../src/diagnostic-store.ts";
import { createHistoryReader } from "../../src/history-reader.ts";
import type { ProjectionScope } from "../../src/history-projection.ts";

export interface RecoveryWorkerConfig {
  mode: "begin" | "collect-insert" | "publish-insert" | "api";
  historyPath: string; projectionPath: string; customer: string; source: string;
  kind: "cel" | "queue"; scope: ProjectionScope;
  origin?: string; issuer?: string; auditPath?: string;
}
function ready(detail: Record<string, unknown> = {}) { process.send?.({ type: "ready", ...detail }); }
function pause() {
  ready({ point: "uncommitted-insert" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
async function run(config: RecoveryWorkerConfig) {
  if (config.mode === "api") {
    const { origin, issuer, auditPath } = config;
    if (!origin || !issuer || !auditPath) throw new Error("Missing recovery API configuration");
    const audit = openDiagnosticStore(auditPath);
    const reader = createHistoryReader(config.historyPath, config.projectionPath);
    const server = createDiagnosticApi({ issuer, audience: "api", jwksUrl: issuer + "/jwks", allowLoopbackHttpForTests: true,
      memberships: ["customer-a", "customer-b"].map((customer) => ({
        issuer, subject: customer, customer, permissions: ["history:read"],
      })), supportGrants: [] }, audit.audit,
    (error, requestId) => {
      process.send?.({ type: "api-error", requestId, error: error instanceof Error ? error.name : "UnknownError" });
    }, undefined, undefined, { origin, issuer, authorizationEndpoint: issuer + "/authorize",
      tokenEndpoint: issuer + "/token", jwksUrl: issuer + "/jwks", clientId: "client", clientSecret: "synthetic-recovery",
      audience: "api", allowLoopbackHttpForTests: true }, undefined, undefined, undefined, undefined, undefined, reader);
    server.listen(Number(new URL(origin).port), "127.0.0.1", () => ready({ origin }));
    return;
  }
  if (config.mode === "collect-insert" || config.mode === "publish-insert") {
    // Pause the real writer after INSERT but before its transaction can commit.
    const target = config.mode === "publish-insert" ? "projection_revisions" : `${config.kind}_events`;
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = original.call(this, sql);
      if (new RegExp(`^\\s*INSERT INTO ${target}\\b`, "i").test(sql)) {
        statement.run = new Proxy(statement.run, {
          apply(insert, _receiver, args) {
            const result = Reflect.apply(insert, statement, args);
            pause();
            return result;
          },
        });
      }
      return statement;
    };
  }
  const history = openCelHistory(config.historyPath);
  if (config.mode === "begin") {
    if (config.kind === "cel") history.beginCollection(config.customer, config.source);
    else history.queue.collectors.begin(config.customer, config.source);
    ready({ point: "committed-attempt" });
    setInterval(() => {}, 1000);
  } else if (config.mode === "publish-insert") {
    const projections = openHistoryProjections(config.projectionPath);
    try { projections.rebuild(history, config.scope); }
    finally { projections.close(); history.close(); }
    throw new Error("Recovery publication failed to reach the injected pause");
  } else {
    try {
      if (config.kind === "cel") await collectCelOnce(history, config.customer, config.source);
      else await collectQueueOnce(history, config.customer, config.source);
    } finally { history.close(); }
    throw new Error("Recovery import failed to reach the injected pause");
  }
}
process.once("message", (config: RecoveryWorkerConfig) => {
  void run(config).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});
