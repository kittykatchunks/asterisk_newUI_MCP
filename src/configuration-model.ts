import { createHash } from "node:crypto";

export const CONFIGURATION_COMPILER = "isolated-empty-queue-v1";
export interface ConfigurationScope { customer: string; runtime: string }
export interface ConfigurationModel { schemaVersion: 1; routeId: string; queueId: string; waitSeconds: number }
export class ConfigurationValidationError extends Error {
  readonly issues: readonly { code: string; path: string; message: string }[];
  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "ConfigurationValidationError";
    this.issues = [{ code, path, message }];
  }
}
export const configurationHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function configurationObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid configuration object");
}
export function configurationSlug(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error("Invalid configuration slug");
}
export function configurationScope(value: ConfigurationScope) {
  configurationSlug(value.customer); configurationSlug(value.runtime);
}
export function configurationNamespace(scope: ConfigurationScope) {
  configurationScope(scope);
  return `cp-${configurationHash(JSON.stringify([scope.customer, scope.runtime])).slice(0, 24)}`;
}
export function configurationModel(value: unknown): ConfigurationModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationValidationError("object-required", "$", "Configuration model must be an object");
  }
  configurationObject(value);
  if (Object.keys(value).sort().join(",") !== "queueId,routeId,schemaVersion,waitSeconds" || value.schemaVersion !== 1) {
    throw new ConfigurationValidationError("fields-or-version", "$", "Expected only schemaVersion:1, routeId, queueId and waitSeconds");
  }
  for (const field of ["routeId", "queueId"] as const) {
    if (typeof value[field] !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value[field])) {
      throw new ConfigurationValidationError("slug-required", `$.${field}`, "Expected a lowercase slug of 1 through 32 characters");
    }
  }
  configurationSlug(value.routeId); configurationSlug(value.queueId);
  if (typeof value.waitSeconds !== "number" || !Number.isSafeInteger(value.waitSeconds) ||
      value.waitSeconds < 1 || value.waitSeconds > 30) {
    throw new ConfigurationValidationError("wait-range", "$.waitSeconds", "Configuration wait requires an integer from 1 through 30");
  }
  return { schemaVersion: 1, routeId: value.routeId, queueId: value.queueId, waitSeconds: value.waitSeconds };
}
export function parseConfigurationModel(text: string): ConfigurationModel {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096) {
    throw new ConfigurationValidationError("input-size", "$", "Configuration model requires at most 4096 UTF-8 bytes");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigurationValidationError("invalid-json", "$", "Configuration model must be valid JSON");
  }
  const tokens = text.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]/g) ?? [];
  const keys = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key: unknown = JSON.parse(token);
      if (typeof key !== "string" || keys.has(key)) throw new ConfigurationValidationError("duplicate-field", "$", "Duplicate configuration model field");
      keys.add(key);
    }
    if (/^-?[0-9]/.test(token) && !/^(?:0|[1-9][0-9]*)$/.test(token)) {
      throw new ConfigurationValidationError("noncanonical-number", "$", "Configuration numbers require canonical unsigned integer tokens");
    }
  }
  return configurationModel(value);
}
export function compileConfiguration(scope: ConfigurationScope, input: unknown, revision: number) {
  configurationScope(scope);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid configuration revision");
  const model = configurationModel(input);
  const canonical = JSON.stringify(model), modelSha256 = configurationHash(canonical);
  const namespace = configurationNamespace(scope);
  const context = `${namespace}-${model.routeId}`, queue = `${namespace}-${model.queueId}`;
  const routeRevision = `cp-v1-${revision}-${modelSha256.slice(0, 16)}`;
  const dialplan = `[${context}]\nexten => entry,1,Set(HISTORY_JOURNEY=\${UUID()})\n` +
    ` same => n,Set(HISTORY_VISIT=\${UUID()})\n` +
    ` same => n,CELGenUserEvent(HISTORY_ENTRY,{"v":1,"journeyId":"\${HISTORY_JOURNEY}","entryKind":"synthetic","routeRevision":"${routeRevision}"})\n` +
    ` same => n,Answer()\n` +
    ` same => n,CELGenUserEvent(HISTORY_QUEUE_VISIT,{"v":1,"journeyId":"\${HISTORY_JOURNEY}","visitId":"\${HISTORY_VISIT}","queue":"${queue}","routeRevision":"${routeRevision}"})\n` +
    ` same => n,Queue(${queue},,,n,${model.waitSeconds})\n same => n,Hangup()\n`;
  const queues = `[${queue}]\nstrategy = ringall\ntimeout = 2\njoinempty = yes\nleavewhenempty = no\n`;
  return { compiler: CONFIGURATION_COMPILER, model, canonical, modelSha256, namespace, context, queue, routeRevision,
    dialplan, queues, dialplanSha256: configurationHash(dialplan), queuesSha256: configurationHash(queues) };
}
