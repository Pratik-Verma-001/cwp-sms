import { z } from "zod";
import { authenticateUser } from "../auth/userAuth.js";
import { ApiError, type HttpResult } from "../errors.js";
import type { DeviceRecord } from "../management/types.js";
import { generateChallenge, generateDeviceCredential, hashChallenge } from "../security/deviceCredential.js";
import { parseBody } from "../validation/parse.js";
import { effectiveLimits } from "./limits.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

const registerSchema = z
  .object({
    challenge: z.string().regex(/^cwpc_[0-9a-f]{32}$/),
    nickname: z.string().trim().min(1).max(40),
    appVersion: z.string().trim().min(1).max(32),
  })
  .strict();

export function deviceMeta(d: DeviceRecord, now: Date, onlineWindowSeconds: number) {
  const online =
    d.status === "active" &&
    d.connectorRunning &&
    d.lastSeenAt !== undefined &&
    now.getTime() - d.lastSeenAt.getTime() <= onlineWindowSeconds * 1000;
  return {
    deviceId: d.deviceId,
    nickname: d.nickname,
    platform: d.platform,
    appVersion: d.appVersion,
    status: d.status,
    online,
    connectorRunning: d.connectorRunning,
    smsPermissionGranted: d.smsPermissionGranted,
    telephonyAvailable: d.telephonyAvailable,
    simDisplayLabel: d.simDisplayLabel ?? null,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Dashboard step 1: mint a short-lived, single-use pairing challenge. */
export async function issueChallenge(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const challenge = generateChallenge();
  const expiresAt = new Date(now.getTime() + deps.config.pairingChallengeSeconds * 1000);
  await deps.store.saveChallenge({
    hash: hashChallenge(challenge, deps.config.deviceTokenPepper),
    ownerUid: user.uid,
    createdAt: now,
    expiresAt,
  });
  return { status: 201, body: { challenge, expiresAt: expiresAt.toISOString() } };
}

/** Android step 2: signed-in app redeems the challenge and receives its device credential once. */
export async function registerDevice(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const body = parseBody(input.rawBody, registerSchema, deps.config.maxRequestBodyBytes);

  const ok = await deps.store.consumeChallenge(hashChallenge(body.challenge, deps.config.deviceTokenPepper), user.uid, now);
  if (!ok) throw new ApiError(400, "INVALID_CHALLENGE", "The pairing code is invalid, expired, or already used.");

  const cred = generateDeviceCredential(deps.config.deviceTokenPepper);
  const device: DeviceRecord = {
    deviceId: cred.deviceId,
    ownerUid: user.uid,
    nickname: body.nickname,
    platform: "android",
    appVersion: body.appVersion,
    deviceCredentialHash: cred.secretHash,
    credentialVersion: 1,
    status: "active",
    connectorRunning: false, // the user must explicitly start the connector
    smsPermissionGranted: false,
    telephonyAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  const maxDevices = effectiveLimits(user, deps.config).maxDevices;
  if ((await deps.store.insertDevice(device, maxDevices)) === "limit") {
    throw new ApiError(409, "DEVICE_LIMIT_REACHED", `At most ${maxDevices} connected device(s) are allowed. Revoke one first.`);
  }
  return {
    status: 201,
    body: { ...deviceMeta(device, now, deps.config.deviceOnlineWindowSeconds), credential: cred.raw, credentialShownOnce: true },
  };
}

export async function listDevices(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const devices = await deps.store.listDevices(user.uid);
  return { status: 200, body: { devices: devices.map((d) => deviceMeta(d, now, deps.config.deviceOnlineWindowSeconds)) } };
}

export async function deleteDevice(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, nowOf(deps));
  const deviceId = input.params.deviceId ?? "";
  const r = /^[0-9a-f]{16}$/.test(deviceId) ? await deps.store.deleteDevice(user.uid, deviceId) : "not_found";
  if (r === "not_found") throw new ApiError(404, "NOT_FOUND", "Device not found.");
  if (r === "still_active") throw new ApiError(409, "REVOKE_FIRST", "Revoke the device before deleting it.");
  return { status: 204 };
}

export async function revokeDevice(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const user = await authenticateUser(input.authorization, deps.verifier, deps.store, now);
  const deviceId = input.params.deviceId ?? "";
  if (!/^[0-9a-f]{16}$/.test(deviceId) || (await deps.store.revokeDevice(user.uid, deviceId, now)) === "not_found") {
    throw new ApiError(404, "NOT_FOUND", "Device not found.");
  }
  const device = await deps.store.getDevice(deviceId);
  return { status: 200, body: deviceMeta(device!, now, deps.config.deviceOnlineWindowSeconds) };
}
