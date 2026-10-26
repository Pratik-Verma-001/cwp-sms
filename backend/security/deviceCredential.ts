import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashValue } from "./apiKey.js";

export const DEVICE_HASH_VERSION = 1;
const CRED_RE = /^cwpd_([0-9a-f]{16})_([0-9a-f]{64})$/;

export function hashDeviceSecret(secret: string, pepper: string): string {
  return hashValue(pepper, `device:v${DEVICE_HASH_VERSION}`, secret);
}

export function generateDeviceCredential(pepper: string) {
  const deviceId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { deviceId, raw: `cwpd_${deviceId}_${secret}`, secretHash: hashDeviceSecret(secret, pepper) };
}

export function parseDeviceCredential(raw: string): { deviceId: string; secret: string } | null {
  const m = CRED_RE.exec(raw);
  return m ? { deviceId: m[1]!, secret: m[2]! } : null;
}

export function verifyDeviceSecret(secret: string, expectedHash: string, pepper: string): boolean {
  const a = Buffer.from(hashDeviceSecret(secret, pepper), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One-time pairing challenge shown in the dashboard and typed/scanned into the Android app. */
export function generateChallenge(): string {
  return `cwpc_${randomBytes(16).toString("hex")}`;
}

export function hashChallenge(challenge: string, pepper: string): string {
  return hashValue(pepper, "pairing", challenge);
}
