import { z } from "zod";
import { ApiError, type HttpResult } from "../errors.js";
import type { AdminUser } from "../management/types.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";
import { deviceMeta } from "./devices.js";
import { requestView } from "./dashboard.js";
import { keyMeta } from "./keys.js";
import { effectiveLimits, platformLiveEnabled } from "./limits.js";
import { parseBody } from "../validation/parse.js";

const UID = /^[A-Za-z0-9_-]{3,128}$/;
const BOUND = 500;

interface Admin {
  uid: string;
  email: string;
}

/**
 * Admin access = a verified Firebase sign-in whose email is on the CWP_ADMIN_EMAILS allow-list.
 * Passwords are never handled here; Firebase owns them. Anyone else gets the same 403.
 */
export async function authenticateAdmin(authorization: string | undefined, deps: ManagementDeps): Promise<Admin> {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  if (!m) throw new ApiError(401, "INVALID_TOKEN", "A valid sign-in token is required.");
  let token;
  try {
    token = await deps.verifier.verify(m[1]!);
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "A valid sign-in token is required.");
  }
  const email = (token.email ?? "").toLowerCase();
  if (!token.emailVerified || !email || !deps.config.adminEmails.includes(email)) {
    throw new ApiError(403, "NOT_ADMIN", "This account is not an administrator.");
  }
  await deps.store.ensureUser({ uid: token.uid, email: token.email, emailVerified: true, now: nowOf(deps) });
  return { uid: token.uid, email };
}

const audit = (deps: ManagementDeps, a: Admin, action: string, targetUid?: string, detail?: string) =>
  deps.store.addAudit({ at: nowOf(deps), actorUid: a.uid, actorEmail: a.email, action, ...(targetUid ? { targetUid } : {}), ...(detail ? { detail } : {}) });

function userView(u: AdminUser, deps: ManagementDeps) {
  const t = u;
  return {
    uid: u.uid,
    email: u.email ?? null,
    status: u.status,
    liveSendingEnabled: u.liveSendingEnabled,
    demoModeEnabled: u.demoModeEnabled,
    limitOverrides: u.limits ?? {},
    effectiveLimits: effectiveLimits(u, deps.config),
    createdAt: t.createdAt?.toISOString() ?? null,
    lastLoginAt: t.lastLoginAt?.toISOString() ?? null,
  };
}

async function platformView(deps: ManagementDeps) {
  const s = await deps.store.getPlatformSettings();
  return {
    envDefault: deps.config.liveSendingEnabled,
    override: s.liveSendingEnabled ?? null,
    effective: platformLiveEnabled(s, deps.config),
  };
}

export async function adminOverview(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const admin = await authenticateAdmin(input.authorization, deps);
  const now = nowOf(deps);
  const [users, keys, devices] = await Promise.all([
    deps.store.listUsers(BOUND), deps.store.listAllActiveKeys(BOUND), deps.store.listAllActiveDevices(BOUND),
  ]);
  const window = deps.config.deviceOnlineWindowSeconds * 1000;
  return {
    status: 200,
    body: {
      platform: await platformView(deps),
      totals: {
        users: users.length,
        suspendedUsers: users.filter((u) => u.status !== "active").length,
        liveEnabledUsers: users.filter((u) => u.liveSendingEnabled).length,
        activeApiKeys: keys.filter((k) => !k.scopes.includes("connector")).length,
        activeConnectorKeys: keys.filter((k) => k.scopes.includes("connector")).length,
        activeDevices: devices.length,
        onlineDevices: devices.filter((d) => d.connectorRunning && d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() <= window).length,
      },
      truncated: users.length >= BOUND || keys.length >= BOUND || devices.length >= BOUND,
      adminEmail: admin.email,
    },
  };
}

const platformSchema = z.object({ liveSendingEnabled: z.boolean().nullable() }).strict();

export async function setPlatform(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const body = parseBody(input.rawBody, platformSchema, deps.config.maxRequestBodyBytes);
  await deps.store.setPlatformSettings({ liveSendingEnabled: body.liveSendingEnabled }, nowOf(deps), a.uid);
  await audit(deps, a, "platform.live", undefined, body.liveSendingEnabled === null ? "reset to environment default" : body.liveSendingEnabled ? "on" : "off");
  return { status: 200, body: { platform: await platformView(deps), note: "Phones and API calls pick this up within about 15 seconds." } };
}

export async function adminUsers(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  await authenticateAdmin(input.authorization, deps);
  const now = nowOf(deps);
  const [users, keys, devices] = await Promise.all([
    deps.store.listUsers(BOUND), deps.store.listAllActiveKeys(BOUND), deps.store.listAllActiveDevices(BOUND),
  ]);
  const window = deps.config.deviceOnlineWindowSeconds * 1000;
  return {
    status: 200,
    body: {
      users: users.map((u) => ({
        ...userView(u, deps),
        activeKeys: keys.filter((k) => k.ownerUid === u.uid).length,
        devices: devices.filter((d) => d.ownerUid === u.uid).length,
        onlineDevices: devices.filter((d) => d.ownerUid === u.uid && d.connectorRunning && d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() <= window).length,
      })),
      truncated: users.length >= BOUND,
    },
  };
}

function targetUid(input: RouteInput): string {
  const uid = input.params.uid ?? "";
  if (!UID.test(uid)) throw new ApiError(404, "NOT_FOUND", "User not found.");
  return uid;
}

export async function adminUserDetail(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const now = nowOf(deps);
  const user = await deps.store.getUser(uid);
  if (!user) throw new ApiError(404, "NOT_FOUND", "User not found.");
  const [keys, devices, jobs, used] = await Promise.all([
    deps.store.listKeys(uid), deps.store.listDevices(uid), deps.store.listJobs(uid, 200),
    deps.store.getDayUsage(uid, now.toISOString().slice(0, 10)),
  ]);
  const byStatus: Record<string, number> = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
  return {
    status: 200,
    body: {
      user: userView(user, deps),
      usage: { day: now.toISOString().slice(0, 10), usedUnits: used, dailyUnits: effectiveLimits(user, deps.config).dailyUnits },
      counts: { window: jobs.length, byStatus },
      keys: keys.map(keyMeta),
      devices: devices.map((d) => deviceMeta(d, now, deps.config.deviceOnlineWindowSeconds)),
      recent: jobs.slice(0, 30).map(requestView),
    },
  };
}

const limit = (max: number) => z.number().int().min(1).max(max).nullable().optional();
const patchSchema = z
  .object({
    status: z.enum(["active", "suspended"]).optional(),
    liveSendingEnabled: z.boolean().optional(),
    demoModeEnabled: z.boolean().optional(),
    limits: z
      .object({ dailyUnits: limit(100_000), requestsPerMinute: limit(600), maxDevices: limit(20), maxActiveKeys: limit(100) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });

export async function adminUpdateUser(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const patch = parseBody(input.rawBody, patchSchema, deps.config.maxRequestBodyBytes);
  if (uid === a.uid && patch.status === "suspended") {
    throw new ApiError(400, "VALIDATION_ERROR", "You cannot suspend your own administrator account.");
  }
  const updated = await deps.store.updateUser(uid, patch, nowOf(deps));
  if (!updated) throw new ApiError(404, "NOT_FOUND", "User not found.");
  await audit(deps, a, "user.update", uid, Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ").slice(0, 300));
  return { status: 200, body: { user: userView(updated, deps) } };
}

export async function adminRevokeKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const keyId = input.params.keyId ?? "";
  if (!/^[0-9a-f]{16}$/.test(keyId) || (await deps.store.revokeKey(uid, keyId, nowOf(deps))) === "not_found") {
    throw new ApiError(404, "NOT_FOUND", "API key not found.");
  }
  await audit(deps, a, "key.revoke", uid, keyId);
  return { status: 200, body: { ok: true } };
}

export async function adminRevokeDevice(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const deviceId = input.params.deviceId ?? "";
  if (!/^[0-9a-f]{16}$/.test(deviceId) || (await deps.store.revokeDevice(uid, deviceId, nowOf(deps))) === "not_found") {
    throw new ApiError(404, "NOT_FOUND", "Device not found.");
  }
  await audit(deps, a, "device.revoke", uid, deviceId);
  return { status: 200, body: { ok: true } };
}

export async function adminDeleteKey(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const keyId = input.params.keyId ?? "";
  const r = /^[0-9a-f]{16}$/.test(keyId) ? await deps.store.deleteKey(uid, keyId) : "not_found";
  if (r === "not_found") throw new ApiError(404, "NOT_FOUND", "API key not found.");
  if (r === "still_active") throw new ApiError(409, "REVOKE_FIRST", "Revoke the key before deleting it.");
  await audit(deps, a, "key.delete", uid, keyId);
  return { status: 200, body: { ok: true } };
}

export async function adminDeleteDevice(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const a = await authenticateAdmin(input.authorization, deps);
  const uid = targetUid(input);
  const deviceId = input.params.deviceId ?? "";
  const r = /^[0-9a-f]{16}$/.test(deviceId) ? await deps.store.deleteDevice(uid, deviceId) : "not_found";
  if (r === "not_found") throw new ApiError(404, "NOT_FOUND", "Device not found.");
  if (r === "still_active") throw new ApiError(409, "REVOKE_FIRST", "Revoke the device before deleting it.");
  await audit(deps, a, "device.delete", uid, deviceId);
  return { status: 200, body: { ok: true } };
}

export async function adminAudit(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  await authenticateAdmin(input.authorization, deps);
  const rows = await deps.store.listAudit(100);
  return {
    status: 200,
    body: { entries: rows.map((r) => ({ at: r.at.toISOString(), admin: r.actorEmail, action: r.action, targetUid: r.targetUid ?? null, detail: r.detail ?? null })) },
  };
}
