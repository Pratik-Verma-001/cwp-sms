import { authenticateUser } from "../auth/userAuth.js";
import { ApiError, type HttpResult } from "../errors.js";
import type { JobRecord } from "../sms/store.js";
import { countSmsUnits } from "../../shared/schemas/index.js";
import type { JobStatus } from "../../shared/status-machine/index.js";
import { deviceMeta } from "./devices.js";
import { keyMeta } from "./keys.js";
import { effectiveLimits, platformLiveEnabled } from "./limits.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

/** Not finished: still waiting for, or in the middle of, being handled by a phone. */
const PENDING: readonly JobStatus[] = ["accepted", "queued", "assigned", "sending"];
const DONE_OK: readonly JobStatus[] = ["sent", "delivery_pending", "delivered"];
const RECENT_WINDOW = 200;

/** Never includes the message body or the full destination number. */
export function requestView(j: JobRecord) {
  return {
    id: j.jobId,
    status: j.status,
    mode: j.mode,
    to: j.destinationMasked,
    messageChars: j.messagePayload.length,
    units: countSmsUnits(j.messagePayload),
    clientReference: j.clientReference ?? null,
    apiKeyId: j.apiKeyId,
    deviceId: j.deviceId ?? null,
    attempts: j.attempts,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    expiresAt: j.expiresAt.toISOString(),
    sentAt: j.sentAt?.toISOString() ?? null,
    deliveredAt: j.deliveredAt?.toISOString() ?? null,
    deliveryConfirmed: j.status === "delivered",
    errorCode: j.errorCode ?? null,
    errorMessage: j.safeErrorMessage ?? null,
  };
}

/** Public: what the dashboard needs before anyone is signed in. Contains no secrets. */
export async function publicConfig(_input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  return {
    status: 200,
    body: {
      service: "cwp-sms",
      apiVersion: "v1",
      firebaseApiKey: deps.config.firebaseWebApiKey,
      signInConfigured: deps.config.firebaseWebApiKey !== null,
    },
  };
}

export async function dashboard(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const [jobs, keys, devices, usedUnits, settings] = await Promise.all([
    deps.store.listJobs(user.uid, RECENT_WINDOW),
    deps.store.listKeys(user.uid),
    deps.store.listDevices(user.uid),
    deps.store.getDayUsage(user.uid, now.toISOString().slice(0, 10)),
    deps.store.getPlatformSettings(),
  ]);
  const limits = effectiveLimits(user, deps.config);
  const platformLive = platformLiveEnabled(settings, deps.config);

  const byStatus: Record<string, number> = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
  const count = (set: readonly JobStatus[]) => jobs.filter((j) => set.includes(j.status)).length;

  const deviceViews = devices
    .filter((d) => d.status === "active")
    .map((d) => deviceMeta(d, now, deps.config.deviceOnlineWindowSeconds));
  const activeKeys = keys.filter((k) => k.status === "active");

  return {
    status: 200,
    body: {
      account: {
        uid: user.uid,
        liveSendingEnabledForAccount: user.liveSendingEnabled,
        liveSendingEnabledOnPlatform: platformLive,
        liveSendingAllowed: user.liveSendingEnabled && platformLive,
      },
      counts: {
        window: jobs.length,
        windowNote: `Based on your latest ${RECENT_WINDOW} requests.`,
        pending: count(PENDING),
        sent: count(DONE_OK),
        delivered: byStatus.delivered ?? 0,
        failed: (byStatus.failed ?? 0) + (byStatus.expired ?? 0),
        unknown: byStatus.unknown ?? 0,
        demo: byStatus.demo_completed ?? 0,
        byStatus,
      },
      quota: { day: now.toISOString().slice(0, 10), usedUnits, dailyUnits: limits.dailyUnits, requestsPerMinute: limits.requestsPerMinute },
      keys: {
        active: activeKeys.length,
        limit: limits.maxActiveKeys,
        apiKeys: activeKeys.filter((k) => !k.scopes.includes("connector")).length,
        connectorKeys: activeKeys.filter((k) => k.scopes.includes("connector")).length,
      },
      devices: { limit: limits.maxDevices, items: deviceViews, online: deviceViews.filter((d) => d.online).length },
      recent: jobs.slice(0, 8).map(requestView),
      keyList: keys.slice(0, 5).map(keyMeta),
    },
  };
}

const LISTABLE = new Set<string>([
  "accepted", "queued", "assigned", "sending", "sent", "delivery_pending", "delivered",
  "failed", "unknown", "expired", "cancelled", "demo_completed",
]);

export async function listRequests(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const status = input.query?.status;
  if (status && status !== "pending" && !LISTABLE.has(status)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Unknown status filter.");
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(input.query?.limit ?? "50", 10) || 50));
  const jobs = await deps.store.listJobs(user.uid, RECENT_WINDOW);
  const filtered = jobs.filter((j) => !status || (status === "pending" ? PENDING.includes(j.status) : j.status === status));
  return { status: 200, body: { requests: filtered.slice(0, limit).map(requestView), scanned: jobs.length } };
}

export async function deleteRequest(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const id = input.params.id ?? "";
  const r = /^[A-Za-z0-9_-]{6,80}$/.test(id) ? await deps.store.deleteJob(user.uid, id) : "not_found";
  if (r === "not_found") throw new ApiError(404, "NOT_FOUND", "Request not found.");
  if (r === "active") throw new ApiError(409, "REQUEST_IN_PROGRESS", "This request is still in progress. Wait until it finishes.");
  return { status: 204 };
}

export async function getRequest(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const job = await deps.store.getJob(input.params.id ?? "");
  // Foreign and unknown IDs are indistinguishable.
  if (!job || job.ownerUid !== user.uid) throw new ApiError(404, "NOT_FOUND", "Request not found.");
  const events = await deps.store.listJobEvents(job.jobId);
  return {
    status: 200,
    body: {
      request: requestView(job),
      timeline: events.map((e) => ({ from: e.from, to: e.to, source: e.source, at: e.at.toISOString() })),
    },
  };
}
