import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HASH_VERSION = 1;

export interface GeneratedApiKey {
  /** Shown to the user exactly once. Never persist. */
  raw: string;
  keyId: string;
  prefix: string;
  secretHash: string;
  hashVersion: number;
}

export interface ParsedApiKey {
  environment: "test" | "live";
  keyId: string;
  secret: string;
}

const KEY_RE = /^cwp_(test|live)_([0-9a-f]{16})_([0-9a-f]{64})$/;

function assertPepper(pepper: string): void {
  if (pepper.length < 16) throw new Error("Pepper must be at least 16 characters.");
}

export function hashValue(pepper: string, label: string, value: string): string {
  assertPepper(pepper);
  return createHmac("sha256", pepper).update(`${label}:${value}`).digest("hex");
}

export function hashSecret(secret: string, pepper: string): string {
  return hashValue(pepper, `apikey:v${HASH_VERSION}`, secret);
}

export function generateApiKey(environment: "test" | "live", pepper: string): GeneratedApiKey {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return {
    raw: `cwp_${environment}_${keyId}_${secret}`,
    keyId,
    prefix: `cwp_${environment}_${keyId}`,
    secretHash: hashSecret(secret, pepper),
    hashVersion: HASH_VERSION,
  };
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { environment: m[1] as "test" | "live", keyId: m[2]!, secret: m[3]! };
}

export function verifySecret(secret: string, expectedHash: string, pepper: string): boolean {
  const actual = Buffer.from(hashSecret(secret, pepper), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
