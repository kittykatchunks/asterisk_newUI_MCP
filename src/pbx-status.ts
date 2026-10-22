import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export interface PbxEndpoint {
  id: string;
  deviceState: string;
  hasContacts: boolean;
  activeChannels: number;
}

export interface PbxEndpointSnapshot {
  customer: string;
  checkedAt: string;
  endpoints: PbxEndpoint[];
}

export interface PbxEndpointSource {
  endpoints(customer: string): Promise<PbxEndpointSnapshot>;
}

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

export function createAmiStatusSource(connections: readonly AmiConnection[]): PbxStatusSource & PbxEndpointSource {
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
  async function query<T>(customer: string, action: "CoreStatus" | "PJSIPShowEndpoints",
    consume: (fields: Map<string, string>) => T | undefined): Promise<T> {
    const config = mapped.get(customer);
    if (!config) throw new Error("PBX status connection is not configured");
    if (inFlight.has(customer)) throw new Error("PBX status check is already in progress");
    inFlight.add(customer);
    try {
      return await new Promise<T>((resolve, reject) => {
        const socket = config.tls
          ? connectTls({ host: config.host, port: config.port, rejectUnauthorized: true })
          : connectTcp({ host: config.host, port: config.port });
        const id = randomUUID();
        let buffer = "";
        let bytes = 0;
        const decoder = new StringDecoder("utf8");
        let phase: "login" | "status" = "login";
        let settled = false;
        const finish = (error?: Error, result?: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error);
          else if (result !== undefined) resolve(result);
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
          buffer += decoder.write(chunk);
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
            if ((phase === "login" || fields.has("response")) && fields.get("response") !== "Success") {
              finish(new Error("PBX status action was denied")); return;
            }
            if (phase === "login") {
              phase = "status";
              socket.write(`Action: ${action}\r\nActionID: ${id}-status\r\n\r\n`);
              continue;
            }
            try {
              const result = consume(fields);
              if (result !== undefined) finish(undefined, result);
            } catch (error) {
              finish(error instanceof Error ? error : new Error("Invalid PBX status response"));
            }
          }
        });
      });
    } finally { inFlight.delete(customer); }
  }
  return {
    status(customer) {
      return query(customer, "CoreStatus", (fields): PbxStatus => {
        const date = fields.get("corestartupdate") ?? "";
        const time = fields.get("corestartuptime") ?? "";
        const calls = fields.get("corecurrentcalls") ?? "";
        if (fields.get("response") !== "Success" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time) ||
            !/^\d{1,9}$/.test(calls)) throw new Error("Invalid PBX core status fields");
        return { customer, checkedAt: new Date().toISOString(),
          coreStartedAtLocal: `${date} ${time}`, activeCalls: Number(calls) };
      });
    },
    endpoints(customer) {
      const endpoints: PbxEndpoint[] = [];
      let acknowledged = false;
      return query(customer, "PJSIPShowEndpoints", (fields): PbxEndpointSnapshot | undefined => {
        if (fields.has("response")) {
          if (acknowledged || fields.get("eventlist") !== "start") throw new Error("Invalid PBX endpoint list acknowledgement");
          acknowledged = true;
          return;
        }
        if (!acknowledged) throw new Error("PBX endpoint list was not acknowledged");
        if (fields.get("event") === "EndpointList") {
          const id = fields.get("objectname") ?? "";
          const deviceState = fields.get("devicestate") ?? "";
          const activeChannels = fields.get("activechannels") ?? "";
          const contacts = fields.get("contacts");
          if (fields.get("objecttype") !== "endpoint" || !id.trim() || id.length > 128 ||
              /[\x00-\x1f\x7f]/.test(id) || !/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(deviceState) ||
              !/^\d{1,9}$/.test(activeChannels) || contacts === undefined ||
              endpoints.length >= 200 || endpoints.some((endpoint) => endpoint.id === id)) {
            throw new Error("Invalid or oversized PBX endpoint list");
          }
          endpoints.push({ id, deviceState, hasContacts: !!contacts.trim(), activeChannels: Number(activeChannels) });
          return;
        }
        if (fields.get("event") !== "EndpointListComplete" || fields.get("eventlist") !== "Complete" ||
            fields.get("listitems") !== String(endpoints.length)) throw new Error("Incomplete PBX endpoint list");
        return { customer, checkedAt: new Date().toISOString(),
          endpoints: endpoints.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
      });
    },
  };
}
