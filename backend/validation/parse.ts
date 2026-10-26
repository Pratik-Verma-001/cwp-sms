import type { ZodTypeAny, z } from "zod";
import { ApiError } from "../errors.js";

/** Parses a JSON body against a schema. Error text never echoes submitted values. */
export function parseBody<S extends ZodTypeAny>(raw: string, schema: S, maxBytes: number): z.infer<S> {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "body";
    throw new ApiError(400, "VALIDATION_ERROR", `Invalid request: ${where}: ${first?.message ?? "invalid"}`);
  }
  return result.data;
}
