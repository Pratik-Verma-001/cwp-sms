import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, type HttpResult } from "./errors.js";

export const newRequestId = () => `req_${randomBytes(8).toString("hex")}`;

/** Reads the raw body with a hard size cap (the stream is aborted once exceeded). */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new ApiError(400, "BAD_REQUEST", "Could not read the request body.")));
  });
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function sendResult(res: ServerResponse, result: HttpResult, requestId: string): void {
  res.statusCode = result.status;
  res.setHeader("X-Request-Id", requestId);
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
  if (result.body === undefined) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(result.body));
}
