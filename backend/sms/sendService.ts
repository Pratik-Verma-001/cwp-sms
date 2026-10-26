import { createHash, randomBytes } from "node:crypto";
import { authenticateApiKey } from "../auth/apiKeyAuth.js";
import type { Config } from "../config.js";
import { ApiError, toErrorResult, type HttpResult } from "../errors.js";
import { hashValue } from "../security/apiKey.js";
import {
  type SendRequest,
  countSmsUnits,
  idempotencyKeySchema,
  maskDestination,
  sendRequestSchema,
} from "../../shared/schemas/index.js";
import { platformLiveEnabled } from "../services/limits.js";
import type { JobRecord, SendStore, UserRecord } from "./store.js";

export interface Deps {
  store: SendStore;
  config: Config;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface SendInput {
  authorization?: string;
  idempotencyKey?: string;
  contentType?: string;
  rawBody: string;
}

const defaultNewId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jobResponse(job: JobRecord) {
  return {
    id: job.jobId,
    status: job.status,
    mode: job.mode,
    simulated: job.mode === "demo",
    createdAt: job.createdAt.toISOString(),
    statusUrl: `/api/v1/sms/status/${job.jobId}`,
  };
}

export async function handleSend(input: SendInput, deps: Deps, requestId: string): Promise<HttpResult> {
  try {
    return await processSend(input, deps);
  } catch (err) {
    return toErrorResult(err, requestId);
  }
}

async function processSend(input: SendInput, deps: Deps): Promise<HttpResult> {
  const { store, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? defaultNewId;

  const { key, user } = await authenticateApiKey(input.authorization, store, config, now, ["sms:send"]);

  if (!(input.contentType ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  if (Buffer.byteLength(input.rawBody, "utf8") > config.maxRequestBodyBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  const parsed = sendRequestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "body";
    throw new ApiError(400, "VALIDATION_ERROR", `Invalid request: ${where}: ${first?.message ?? "invalid"}`);
  }
  const idemParsed = idempotencyKeySchema.safeParse(input.idempotencyKey ?? "");
  if (!idemParsed.success) {
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header of 1-128 characters (letters, digits, . _ : -) is required.",
    );
  }

  return submitJob(
    {
      ownerUid: key.ownerUid,
      user,
      credentialId: key.keyId,
      credentialAllowsLive: key.environment === "live",
      baseLimits: key.limits,
      body: parsed.data,
      idempotencyKey: idemParsed.data,
    },
    deps,
  );
}

export interface SubmitArgs {
  ownerUid: string;
  user: UserRecord;
  /** API key id, or `dash_<uid>` for sends made from the dashboard. Scopes idempotency and rate limiting. */
  credentialId: string;
  credentialAllowsLive: boolean;
  baseLimits: { requestsPerMinute: number; dailyUnits: number };
  body: SendRequest;
  idempotencyKey: string;
}

/** Shared by the public API and the dashboard so both obey exactly the same rules. */
export async function submitJob(a: SubmitArgs, deps: Deps): Promise<HttpResult> {
  const { store, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? defaultNewId;
  const { body, user } = a;

  // Mode is enforced server-side. Demo never reaches the live queue.
  const mode = body.mode ?? config.defaultMode;
  if (mode === "demo") {
    if (!user.demoModeEnabled) {
      throw new ApiError(403, "DEMO_DISABLED", "Demo mode is disabled for this account.");
    }
  } else {
    const platformLive = platformLiveEnabled(await store.getPlatformSettings(), config);
    if (!platformLive || !user.liveSendingEnabled || !a.credentialAllowsLive) {
      throw new ApiError(
        403,
        "LIVE_SENDING_DISABLED",
        "Live sending is not enabled for this environment, account, or key. Use mode \"demo\".",
      );
    }
  }

  const destinationHash = hashValue(config.apiKeyPepper, "dest", body.to);
  if (await store.isSuppressed(a.ownerUid, destinationHash)) {
    throw new ApiError(422, "RECIPIENT_SUPPRESSED", "The recipient is on the account suppression list.");
  }

  if (mode === "live") {
    const online = await store.hasEligibleDevice(a.ownerUid, now, config.deviceOnlineWindowSeconds);
    if (!online) {
      throw new ApiError(409, "NO_ELIGIBLE_DEVICE", "No connected device is currently online and permitted to send.", true);
    }
  }

  const units = mode === "live" ? countSmsUnits(body.message) : 0;
  const normalizedPayloadHash = sha256(
    JSON.stringify([body.to, body.message, mode, body.clientReference ?? null]),
  );
  const idempotencyRecordId = sha256(`${a.ownerUid}|${a.credentialId}|${a.idempotencyKey}`);

  const job: JobRecord = {
    jobId: newId("smsreq"),
    ownerUid: a.ownerUid,
    apiKeyId: a.credentialId,
    mode,
    destination: body.to,
    destinationMasked: maskDestination(body.to),
    messagePayload: body.message,
    status: mode === "demo" ? "demo_completed" : "queued",
    idempotencyRecordId,
    quotaUnitsReserved: units,
    attempts: 0,
    claimVersion: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + config.jobExpirySeconds * 1000),
    ...(body.clientReference ? { clientReference: body.clientReference } : {}),
    ...(mode === "demo" ? { completedAt: now } : {}),
  };

  // An administrator's per-account limits replace the key's own limits.
  const limits = {
    requestsPerMinute: user.limits?.requestsPerMinute ?? a.baseLimits.requestsPerMinute,
    dailyUnits: user.limits?.dailyUnits ?? a.baseLimits.dailyUnits,
  };

  const result = await store.createJob({
    job,
    normalizedPayloadHash,
    idempotencyExpiresAt: new Date(now.getTime() + config.idempotencyTtlSeconds * 1000),
    limits,
    now,
  });

  switch (result.kind) {
    case "conflict":
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used with a different request.");
    case "rate_limited":
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Retry shortly.", true);
    case "quota_exceeded":
      throw new ApiError(429, "QUOTA_EXCEEDED", "The account has reached its configured SMS limit.");
    case "replayed":
      return { status: 202, body: jobResponse(result.job), headers: { "Idempotent-Replay": "true" } };
    case "created":
      return { status: 202, body: jobResponse(result.job) };
  }
}
