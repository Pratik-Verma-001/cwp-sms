import { z } from "zod";
import { authenticateUser } from "../auth/userAuth.js";
import { ApiError, type HttpResult } from "../errors.js";
import type { StoredKey } from "../management/types.js";
import { generateApiKey } from "../security/apiKey.js";
import { SCOPES } from "../../shared/schemas/index.js";
import { parseBody } from "../validation/parse.js";
import { effectiveLimits } from "./limits.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

const createKeySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    environment: z.enum(["test", "live"]),
    scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    limits: z
      .object({
        requestsPerMinute: z.number().int().min(1).optional(),
        dailyUnits: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => !v.scopes?.includes("connector") || v.scopes.length === 1, {
    message: "connector keys cannot have other scopes",
    path: ["scopes"],
  });

/** Metadata only. The hash and the secret are never included. */
export function keyMeta(k: StoredKey) {
  return {
    keyId: k.keyId,
    name: k.name,
    prefix: k.prefix,
    environment: k.environment,
    scopes: k.scopes,
    kind: k.scopes.includes("connector") ? "connector" : "api",
    status: k.status,
    limits: k.limits,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  };
}

export async function createKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const body = parseBody(input.rawBody, createKeySchema, deps.config.maxRequestBodyBytes);

  const gen = generateApiKey(body.environment, deps.config.apiKeyPepper);
  const record: StoredKey = {
    keyId: gen.keyId,
    ownerUid: user.uid, // derived from the verified token, never from the body
    name: body.name,
    prefix: gen.prefix,
    secretHash: gen.secretHash,
    hashVersion: gen.hashVersion,
    environment: body.environment,
    scopes: body.scopes ?? ["sms:send", "sms:read"],
    status: "active",
    createdAt: now,
    // A key can never be more generous than the platform default until plans exist.
    limits: {
      requestsPerMinute: Math.min(body.limits?.requestsPerMinute ?? Infinity, deps.config.defaultRequestsPerMinute),
      dailyUnits: Math.min(body.limits?.dailyUnits ?? Infinity, deps.config.defaultDailyUnits),
    },
    ...(body.expiresInDays ? { expiresAt: new Date(now.getTime() + body.expiresInDays * 86_400_000) } : {}),
  };

  const maxKeys = effectiveLimits(user, deps.config).maxActiveKeys;
  if ((await deps.store.insertKey(record, maxKeys)) === "limit") {
    throw new ApiError(409, "KEY_LIMIT_REACHED", `At most ${maxKeys} active API keys are allowed. Revoke one first.`);
  }
  // The raw secret is returned exactly once and is never persisted.
  return { status: 201, body: { ...keyMeta(record), secret: gen.raw, secretShownOnce: true } };
}

export async function listKeys(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const keys = await deps.store.listKeys(user.uid);
  return { status: 200, body: { keys: keys.map(keyMeta) } };
}

export async function deleteKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const keyId = input.params.keyId ?? "";
  const r = /^[0-9a-f]{16}$/.test(keyId) ? await deps.store.deleteKey(user.uid, keyId) : "not_found";
  if (r === "not_found") throw new ApiError(404, "NOT_FOUND", "API key not found.");
  if (r === "still_active") throw new ApiError(409, "REVOKE_FIRST", "Revoke the key before deleting it.");
  return { status: 204 };
}

export async function revokeKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const keyId = input.params.keyId ?? "";
  // Foreign and unknown IDs are indistinguishable.
  if (!/^[0-9a-f]{16}$/.test(keyId) || (await deps.store.revokeKey(user.uid, keyId, now)) === "not_found") {
    throw new ApiError(404, "NOT_FOUND", "API key not found.");
  }
  return { status: 204 };
}
