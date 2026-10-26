import { z } from "zod";
import { parseApiKey, verifySecret } from "../security/apiKey.js";
import { generateDeviceCredential } from "../security/deviceCredential.js";
import type { DeviceRecord } from "../management/types.js";
import { deviceMeta } from "./devices.js";
import { effectiveLimits, platformLiveEnabled } from "./limits.js";
import { authenticateDevice } from "../auth/deviceAuth.js";
import { ApiError, type HttpResult } from "../errors.js";
import type { TransitionArgs } from "../management/types.js";
import type { JobRecord } from "../sms/store.js";
import { canTransition, isConfirmedDelivery, isStale, type JobStatus } from "../../shared/status-machine/index.js";
import { parseBody } from "../validation/parse.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

const heartbeatSchema = z
  .object({
    connectorRunning: z.boolean(),
    smsPermissionGranted: z.boolean(),
    telephonyAvailable: z.boolean(),
    appVersion: z.string().trim().min(1).max(32).optional(),
    selectedSubscriptionId: z.number().int().min(0).optional(),
    simDisplayLabel: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const resultSchema = z
  .object({
    claimVersion: z.number().int().min(1),
    event: z.enum(["sending", "send_result", "delivery_report"]),
    sendCallback: z.enum(["success", "failure", "unknown"]).optional(),
    deliveryReport: z.enum(["confirmed", "failed", "pending", "unsupported"]).optional(),
    telephonyErrorCode: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.event === "send_result" && !v.sendCallback) {
      ctx.addIssue({ code: "custom", path: ["sendCallback"], message: "required for send_result" });
    }
    if (v.event === "delivery_report" && !v.deliveryReport) {
      ctx.addIssue({ code: "custom", path: ["deliveryReport"], message: "required for delivery_report" });
    }
  });

const connectorRegisterSchema = z
  .object({
    nickname: z.string().trim().min(1).max(40),
    appVersion: z.string().trim().min(1).max(32),
    installId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  })
  .strict();

/**
 * The only thing the Android app is configured with is a base URL and a connector key. The app calls
 * this once; it receives a device credential (shown once) that it keeps in private storage.
 * Re-registering the same install replaces its old credential, so a reinstall never strands the user.
 */
export async function registerWithConnectorKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const m = /^Bearer (.+)$/.exec(input.authorization ?? "");
  const parsedKey = m ? parseApiKey(m[1]!) : null;
  const invalid = () => new ApiError(401, "INVALID_API_KEY", "The connector key is missing or invalid.");
  if (!parsedKey) throw invalid();

  const key = await deps.store.getApiKey(parsedKey.keyId);
  if (!key || key.environment !== parsedKey.environment || !verifySecret(parsedKey.secret, key.secretHash, deps.config.apiKeyPepper)) {
    throw invalid();
  }
  if (key.status !== "active" || (key.expiresAt && key.expiresAt.getTime() <= now.getTime())) {
    throw new ApiError(401, "API_KEY_INACTIVE", "The connector key has been revoked or has expired.");
  }
  // SMS-sending keys must never double as phone-enrollment keys, and vice versa.
  if (!key.scopes.includes("connector")) {
    throw new ApiError(403, "INSUFFICIENT_SCOPE", "This is not a connector key. Create a connector key in the dashboard.");
  }
  const user = await deps.store.getUser(key.ownerUid);
  if (!user || user.status !== "active") throw new ApiError(403, "ACCOUNT_SUSPENDED", "The account is not active.");

  const body = parseBody(input.rawBody, connectorRegisterSchema, deps.config.maxRequestBodyBytes);

  for (const d of await deps.store.listDevices(key.ownerUid)) {
    if (d.status === "active" && d.installId === body.installId) await deps.store.revokeDevice(key.ownerUid, d.deviceId, now);
  }

  const cred = generateDeviceCredential(deps.config.deviceTokenPepper);
  const device: DeviceRecord = {
    deviceId: cred.deviceId,
    ownerUid: key.ownerUid,
    nickname: body.nickname,
    platform: "android",
    appVersion: body.appVersion,
    connectorKeyId: key.keyId,
    installId: body.installId,
    deviceCredentialHash: cred.secretHash,
    credentialVersion: 1,
    status: "active",
    connectorRunning: false,
    smsPermissionGranted: false,
    telephonyAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  const maxDevices = effectiveLimits(user, deps.config).maxDevices;
  if ((await deps.store.insertDevice(device, maxDevices)) === "limit") {
    throw new ApiError(409, "DEVICE_LIMIT_REACHED", `At most ${maxDevices} connected device(s) are allowed. Remove one in the dashboard first.`);
  }
  return {
    status: 201,
    body: { ...deviceMeta(device, now, deps.config.deviceOnlineWindowSeconds), credential: cred.raw, credentialShownOnce: true },
  };
}

export async function heartbeat(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const { device, user } = await authenticateDevice(input.authorization, deps.store, deps.config, nowOf(deps));
  const body = parseBody(input.rawBody, heartbeatSchema, deps.config.maxRequestBodyBytes);
  await deps.store.updateHeartbeat(device.deviceId, body, now);
  const platformEnabled = platformLiveEnabled(await deps.store.getPlatformSettings(), deps.config);
  const accountEnabled = user.liveSendingEnabled;
  return {
    status: 200,
    body: {
      ok: true,
      serverTime: now.toISOString(),
      liveSendingAllowed: platformEnabled && accountEnabled,
      // Says which switch is off, so a user (or the Android app) can show an actionable message.
      liveBlockedBy: [
        ...(platformEnabled ? [] : ["platform_setting"]),
        ...(accountEnabled ? [] : ["account_flag"]),
      ],
    },
  };
}

function leaseView(job: JobRecord) {
  return {
    id: job.jobId,
    claimVersion: job.claimVersion,
    leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
    expiresAt: job.expiresAt.toISOString(),
    to: job.destination,
    message: job.messagePayload,
  };
}

export async function claim(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const { device, user } = await authenticateDevice(input.authorization, deps.store, deps.config, nowOf(deps));

  // The device itself must be ready; the backend never hands work to a paused or unpermitted connector.
  const ready =
    platformLiveEnabled(await deps.store.getPlatformSettings(), deps.config) &&
    user.liveSendingEnabled &&
    device.connectorRunning &&
    device.smsPermissionGranted &&
    device.telephonyAvailable;
  if (!ready) return { status: 200, body: { job: null } };

  const job = await deps.store.claimNextJob({ device, now, leaseSeconds: deps.config.jobLeaseSeconds });
  return { status: 200, body: { job: job ? leaseView(job) : null } };
}

/** A device may fetch only a job currently assigned to it, and only while it is still unsent. */
export async function fetchJob(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const { device } = await authenticateDevice(input.authorization, deps.store, deps.config, nowOf(deps));
  const job = await deps.store.getJob(input.params.id ?? "");
  if (!job || job.ownerUid !== device.ownerUid || job.deviceId !== device.deviceId || job.status !== "assigned") {
    throw new ApiError(404, "NOT_FOUND", "Job not found.");
  }
  return { status: 200, body: { job: leaseView(job) } };
}

function plan(
  job: JobRecord,
  body: z.infer<typeof resultSchema>,
  now: Date,
): { to: JobStatus; patch: Partial<JobRecord>; releaseQuota?: boolean } {
  const errorCode =
    body.telephonyErrorCode !== undefined ? `TELEPHONY_${body.telephonyErrorCode}` : "SEND_FAILED";
  switch (body.event) {
    case "sending":
      return { to: "sending", patch: { startedAt: now, attempts: job.attempts + 1 } };
    case "send_result":
      if (body.sendCallback === "success") {
        return { to: "sent", patch: { sentAt: now, quotaUnitsConsumed: job.quotaUnitsReserved } };
      }
      if (body.sendCallback === "failure") {
        return {
          to: "failed",
          patch: { errorCode, safeErrorMessage: "The device could not send the message.", completedAt: now },
          releaseQuota: true,
        };
      }
      return { to: "unknown", patch: { errorCode: "OUTCOME_UNKNOWN", safeErrorMessage: "The send outcome could not be confirmed." } };
    case "delivery_report":
      if (body.deliveryReport === "confirmed") {
        return { to: "delivered", patch: { deliveredAt: now, completedAt: now, deliveryReceiptAvailable: true } };
      }
      if (body.deliveryReport === "pending") {
        return { to: "delivery_pending", patch: { deliveryReceiptAvailable: true } };
      }
      if (body.deliveryReport === "failed") {
        return {
          to: "failed",
          patch: { errorCode: "DELIVERY_FAILED", safeErrorMessage: "The carrier reported the message was not delivered.", completedAt: now, deliveryReceiptAvailable: true },
        };
      }
      // "unsupported": no state change, only record that no receipt will arrive.
      return { to: job.status, patch: { deliveryReceiptAvailable: false } };
  }
}

function resultBody(job: JobRecord) {
  return { id: job.jobId, status: job.status, deliveryConfirmed: isConfirmedDelivery(job.status) };
}

/**
 * Callbacks are idempotent and monotonic: duplicates and out-of-order reports return the current
 * state unchanged. A device can never move a job it does not hold, or one from a stale claim.
 */
export async function submitResult(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const { device } = await authenticateDevice(input.authorization, deps.store, deps.config, nowOf(deps));
  const body = parseBody(input.rawBody, resultSchema, deps.config.maxRequestBodyBytes);

  const job = await deps.store.getJob(input.params.id ?? "");
  if (!job || job.ownerUid !== device.ownerUid || job.deviceId !== device.deviceId || job.mode !== "live") {
    throw new ApiError(404, "NOT_FOUND", "Job not found.");
  }
  if (job.claimVersion !== body.claimVersion) {
    throw new ApiError(409, "STALE_CLAIM", "This job is no longer assigned to this claim.");
  }

  const step = plan(job, body, now);
  const patchOnly = step.to === job.status;

  if (!patchOnly) {
    if (isStale(job.status, step.to)) return { status: 200, body: resultBody(job) };
    if (!canTransition(job.status, step.to)) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot move a job from ${job.status} to ${step.to}.`);
    }
  } else if (job.status !== "sent" && job.status !== "delivery_pending") {
    throw new ApiError(409, "INVALID_TRANSITION", "No delivery report applies in the current state.");
  }

  if (body.event === "sending" && job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new ApiError(409, "LEASE_EXPIRED", "The lease expired before sending started. Claim the job again.");
  }

  const args: TransitionArgs = {
    jobId: job.jobId,
    from: job.status,
    to: step.to,
    now,
    source: "connector",
    claimVersion: body.claimVersion,
    deviceId: device.deviceId,
    patch: step.patch,
    ...(step.releaseQuota ? { releaseQuota: true } : {}),
  };
  const applied = await deps.store.applyTransition(args);
  if (applied.ok) return { status: 200, body: resultBody(applied.job) };

  // Lost a race (e.g. a duplicate callback): report current state if it is already at/after ours.
  const latest = await deps.store.getJob(job.jobId);
  if (latest && (patchOnly || isStale(latest.status, step.to))) return { status: 200, body: resultBody(latest) };
  throw new ApiError(409, "CONFLICT", "The job changed concurrently. Re-read its state.", true);
}
