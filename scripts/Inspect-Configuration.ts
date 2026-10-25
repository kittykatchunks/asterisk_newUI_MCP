import { inspectConfigurationBinding, readConfigurationBinding, ConfigurationInspectionUnavailable } from "../src/configuration-inspector.ts";

async function main() {
  const [path, customer, runtime, ...extra] = process.argv.slice(2);
  if (!path || !customer || !runtime || extra.length) {
    throw new Error("Usage: node scripts\\Inspect-Configuration.ts <absolute-provisioned-binding> <customer> <runtime>. Read-only empty proof baseline; no apply or reload.");
  }
  const report = await inspectConfigurationBinding(await readConfigurationBinding(path), { customer, runtime });
  console.log(JSON.stringify(report));
  if (report.status !== "empty-baseline-observed") process.exitCode = 2;
}
await main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "unavailable", executorEnabled: false, publicationVerified: false,
    error: { code: error instanceof ConfigurationInspectionUnavailable ? error.code : "inspection-failed",
      message: error instanceof Error ? error.message : "Unknown configuration inspection failure" } }));
  process.exitCode = 1;
});
