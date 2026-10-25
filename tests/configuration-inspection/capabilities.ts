import { configurationHash } from "../../src/configuration-model.ts";

export const QUEUE_CAPABILITY_COMMANDS = [
  "core show version", "core show help queue", "core show functions like QUEUE",
  "core show function QUEUE_VARIABLES", "core show function QUEUE_MEMBER",
  "manager show command QueueStatus", "manager show command QueueSummary", "manager show command QueueRule",
  "manager show command GetConfig", "manager show command GetConfigJSON", "manager show command Getvar",
  "module show like res_ari", "http show status",
] as const;

export async function captureQueueCapabilities(read: (command: string) => Promise<string>) {
  const commands: { command: string; output: string; sha256: string }[] = [];
  for (const command of QUEUE_CAPABILITY_COMMANDS) {
    const output = (await read(command)).replace(/\x1b\[[0-9;]*m/g, "").replaceAll("\r\n", "\n").trim();
    if (!output || Buffer.byteLength(output) > 64 * 1024) throw new Error("Missing or excessive queue capability metadata");
    const expected = command === "core show version" ? /^Asterisk 22\.11\.0\b/ :
      command === "core show help queue" ? /queue show\s+--/ :
      command === "core show functions like QUEUE" ? /[0-9]+ matching custom functions installed\./ :
      command.startsWith("core show function ") ? new RegExp(`Info about Function '${command.slice("core show function ".length)}'`) :
      command.startsWith("manager show command ") ? new RegExp(`Info about Manager Command '${command.slice("manager show command ".length)}'`) :
      command === "module show like res_ari" ? /[0-9]+ modules loaded/ : /HTTP Server Status:/;
    if (!expected.test(output)) throw new Error(`Unsupported capability metadata for ${command}`);
    commands.push({ command, output, sha256: configurationHash(output) });
  }
  return { version: 1, commands, effects: "fixed CLI help/metadata only; no AMI/ARI request, function evaluation, module load, reload or call",
    exactPolicyReaderEstablished: false, unobservedFields: ["timeout", "joinempty", "leavewhenempty"],
    conclusion: "Metadata is research evidence only, never an automatic absence proof or policy reader" };
}
