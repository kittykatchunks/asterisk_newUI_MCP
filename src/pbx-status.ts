import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { randomUUID } from "node:crypto";

export interface PbxStatus {
  customer: string;
  checkedAt: string;
  coreStartedAtLocal: string;
  activeCalls: number;
}

export interface PbxStatusSource {
  status(customer: string): Promise<PbxStatus>;
}

export interface AmiConnection {
  customer: string;
  host: string;
  port: number;
  username: string;
  secret: string;
  tls: boolean;
}

export function createAmiStatusSource(connections: readonly AmiConnection[]): PbxStatusSource {
  const mapped = new Map<string, AmiConnection>();
  for (const connection of connections) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connection.customer) || mapped.has(connection.customer) ||
        !connection.host || /[\s/\\]/.test(connection.host) ||
        !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
        typeof connection.tls !== "boolean" ||
        (!connection.tls && !["127.0.0.1", "::1"].includes(connection.host)) ||
        ![connection.username, connection.secret].every((value) =>
          typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\r\n\0]/.test(value))) {
      throw new Error("Invalid AMI status connection; plaintext is restricted to literal loopback addresses");
    }
    mapped.set(connection.customer, { ...connection });
  }
  const inFlight = new Set<string>();
  return {
    async status(customer) {
      const config = mapped.get(customer);
      if (!config) throw new Error("PBX status connection is not configured");
      if (inFlight.has(customer)) throw new Error("PBX status check is already in progress");
      inFlight.add(customer);
      try {
        return await new Promise<PbxStatus>((resolve, reject) => {
          const socket = config.tls
            ? connectTls({ host: config.host, port: config.port, rejectUnauthorized: true })
            : connectTcp({ host: config.host, port: config.port });
          const id = randomUUID();
          let buffer = "";
          let bytes = 0;
          let phase: "login" | "status" = "login";
          let settled = false;
          const finish = (error?: Error, result?: PbxStatus) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else if (result) resolve(result);
          };
          const timer = setTimeout(() => finish(new Error("PBX status check timed out")), 3000);
          socket.once(config.tls ? "secureConnect" : "connect", () => {
            socket.write(`Action: Login\r\nActionID: ${id}-login\r\nUsername: ${config.username}\r\nSecret: ${config.secret}\r\nEvents: off\r\n\r\n`);
          });
          socket.on("error", () => finish(new Error("PBX status connection failed")));
          socket.on("close", () => finish(new Error("PBX status connection closed before confirmation")));
          socket.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) { finish(new Error("PBX status response exceeded its limit")); return; }
            buffer += chunk.toString("utf8");
            let boundary: number;
            while (!settled && (boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 4);
              const fields = new Map<string, string>();
              for (const line of frame.split("\r\n")) {
                const colon = line.indexOf(":");
                if (colon < 0) continue;
                const key = line.slice(0, colon).toLowerCase();
                if (fields.has(key)) { finish(new Error("Invalid PBX status response")); return; }
                fields.set(key, line.slice(colon + 1).trim());
              }
              if (fields.get("actionid") !== `${id}-${phase}`) continue;
              if (fields.get("response") !== "Success") {
                finish(new Error("PBX status action was denied")); return;
              }
              if (phase === "login") {
                phase = "status";
                socket.write(`Action: CoreStatus\r\nActionID: ${id}-status\r\n\r\n`);
                continue;
              }
              const date = fields.get("corestartupdate") ?? "";
              const time = fields.get("corestartuptime") ?? "";
              const calls = fields.get("corecurrentcalls") ?? "";
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time) ||
                  !/^\d{1,9}$/.test(calls)) {
                finish(new Error("Invalid PBX core status fields")); return;
              }
              finish(undefined, { customer, checkedAt: new Date().toISOString(),
                coreStartedAtLocal: `${date} ${time}`, activeCalls: Number(calls) });
            }
          });
        });
      } finally { inFlight.delete(customer); }
    },
  };
}
