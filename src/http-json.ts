import type { IncomingMessage } from "node:http";

export class HttpInputError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(request: IncomingMessage, prefix: string, maxBytes: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpInputError(415, `${prefix}_json_required`);
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new HttpInputError(415, `${prefix}_encoding_unsupported`);
  }
  const text = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
      if (error) { request.resume(); reject(error); }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) finish(new HttpInputError(413, `${prefix}_body_too_large`));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = (error: Error) => finish(error);
    const aborted = () => finish(new HttpInputError(400, `${prefix}_request_aborted`));
    const timer = setTimeout(() => finish(new HttpInputError(408, `${prefix}_body_timeout`)), 5000);
    request.on("data", data).once("end", end).once("error", fail).once("aborted", aborted);
  });
  try { return JSON.parse(text); }
  catch { throw new HttpInputError(400, `invalid_${prefix}_json`); }
}
