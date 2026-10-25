import { configurationHash, configurationObject, configurationScope, type ConfigurationScope } from "./configuration-model.ts";
import { CONFIGURATION_UNOBSERVED_QUEUE_POLICIES, EMPTY_PROOF_DIALPLAN, EMPTY_PROOF_QUEUE, parseConfigurationBinding,
  type ConfigurationBinding, type inspectConfigurationBinding } from "./configuration-inspector.ts";

type Inspection = Awaited<ReturnType<typeof inspectConfigurationBinding>>;
export interface ConfigurationReview {
  version: 1; customer: string; runtime: string; bindingSha256: string; observationSha256: string;
  baselineSha256: string; observedAt: string; queuePolicyStatus: "unsupported"; runtimeApplyAuthorized: false;
}
export function parseConfigurationReview(input: unknown): ConfigurationReview {
  configurationObject(input);
  if (Object.keys(input).sort().join(",") !==
      "baselineSha256,bindingSha256,customer,observationSha256,observedAt,queuePolicyStatus,runtime,runtimeApplyAuthorized,version" ||
      input.version !== 1 || typeof input.customer !== "string" || typeof input.runtime !== "string" ||
      input.queuePolicyStatus !== "unsupported" || input.runtimeApplyAuthorized !== false ||
      typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt)) ||
      new Date(input.observedAt).toISOString() !== input.observedAt) throw new Error("Invalid offline inspection review");
  for (const key of ["bindingSha256", "observationSha256", "baselineSha256"] as const) {
    if (typeof input[key] !== "string" || !/^[0-9a-f]{64}$/.test(input[key])) throw new Error("Invalid review digest");
  }
  configurationScope({ customer: input.customer, runtime: input.runtime });
  return { version: 1, customer: input.customer, runtime: input.runtime, bindingSha256: String(input.bindingSha256),
    observationSha256: String(input.observationSha256), baselineSha256: String(input.baselineSha256),
    observedAt: input.observedAt, queuePolicyStatus: "unsupported", runtimeApplyAuthorized: false };
}
export function configurationReview(input: ConfigurationBinding, observation: Inspection): ConfigurationReview {
  const binding = parseConfigurationBinding(input);
  if (observation.customer !== binding.customer || observation.runtime !== binding.runtime ||
      observation.version !== 1 || observation.namespace !== binding.namespace || observation.compiler !== binding.compiler ||
      observation.baseline !== binding.baseline || observation.baseRevision !== 0 ||
      observation.bindingSha256 !== configurationHash(JSON.stringify(binding)) ||
      observation.status !== "empty-baseline-observed" || observation.issues.length !== 0 ||
      observation.executorEnabled !== false || observation.publicationVerified !== false ||
      observation.queuePolicy.status !== "unsupported" || JSON.stringify(observation.queuePolicy.unobservedFields) !==
      JSON.stringify(CONFIGURATION_UNOBSERVED_QUEUE_POLICIES)) throw new Error("Exact matching successful empty-baseline observation required");
  const files = Object.fromEntries(Object.entries(observation.disk.files).sort(([a], [b]) => a.localeCompare(b, "en")));
  const expected = Object.fromEntries(Object.entries(binding.files).sort(([a], [b]) => a.localeCompare(b, "en")));
  if (JSON.stringify(files) !== JSON.stringify(expected) ||
      observation.loaded.expectedDialplanSha256 !== configurationHash(JSON.stringify(EMPTY_PROOF_DIALPLAN)) ||
      observation.loaded.expectedQueuesSha256 !== configurationHash(EMPTY_PROOF_QUEUE) ||
      observation.loaded.loadedDialplanSha256 !== observation.loaded.expectedDialplanSha256 ||
      observation.loaded.loadedQueuesSha256 !== observation.loaded.expectedQueuesSha256 ||
      observation.loaded.reservedContextCount !== 0 || observation.loaded.reservedQueueCount !== 0) {
    throw new Error("Inspection review baseline does not match");
  }
  return parseConfigurationReview({ version: 1, customer: binding.customer, runtime: binding.runtime,
    bindingSha256: observation.bindingSha256, observationSha256: configurationHash(JSON.stringify(observation)),
    baselineSha256: configurationHash(JSON.stringify({ files, dialplan: observation.loaded.loadedDialplanSha256,
      queues: observation.loaded.loadedQueuesSha256, queuePolicy: observation.queuePolicy })),
    observedAt: observation.observedAt, queuePolicyStatus: "unsupported", runtimeApplyAuthorized: false });
}
export function compareConfigurationReview(review: ConfigurationReview, binding: ConfigurationBinding, current: Inspection,
  scope: ConfigurationScope) {
  const previous = parseConfigurationReview(review); configurationScope(scope);
  if (previous.customer !== scope.customer || previous.runtime !== scope.runtime) throw new Error("Review scope mismatch");
  const next = configurationReview(binding, current);
  if (next.customer !== scope.customer || next.runtime !== scope.runtime ||
      previous.bindingSha256 !== next.bindingSha256 || previous.baselineSha256 !== next.baselineSha256) {
    throw new Error("Reviewed binding or observed baseline changed");
  }
  if (next.observedAt < previous.observedAt) throw new Error("Current observation predates approval review");
  return { status: "reviewed-baseline-matches" as const, reviewedObservationSha256: previous.observationSha256,
    currentObservationSha256: next.observationSha256, executorEnabled: false, runtimeApplyAuthorized: false,
    queuePolicyStatus: "unsupported" as const };
}
