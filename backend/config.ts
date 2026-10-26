export interface Config {
  apiKeyPepper: string;
  deviceTokenPepper: string;
  defaultMode: "demo" | "live";
  liveSendingEnabled: boolean;
  maxRequestBodyBytes: number;
  defaultRequestsPerMinute: number;
  defaultDailyUnits: number;
  jobExpirySeconds: number;
  deviceOnlineWindowSeconds: number;
  idempotencyTtlSeconds: number;
  maxActiveKeys: number;
  maxConnectedDevices: number;
  jobLeaseSeconds: number;
  pairingChallengeSeconds: number;
  /** Firebase *web* API key: public by design, lets the dashboard sign users in. */
  firebaseWebApiKey: string | null;
  /** Lower-cased emails allowed to open /admin (CWP_ADMIN_EMAILS, comma separated). */
  adminEmails: string[];
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid numeric config value: ${value}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const apiKeyPepper = env.CWP_API_KEY_HASH_PEPPER ?? "";
  const deviceTokenPepper = env.CWP_DEVICE_TOKEN_HASH_PEPPER ?? "";
  if (apiKeyPepper.length < 16 || deviceTokenPepper.length < 16) {
    throw new Error("CWP_API_KEY_HASH_PEPPER and CWP_DEVICE_TOKEN_HASH_PEPPER must be set (16+ chars).");
  }
  if (apiKeyPepper === deviceTokenPepper) {
    throw new Error("The two pepper values must be different.");
  }
  const defaultMode = env.CWP_DEFAULT_MODE === "live" ? "live" : "demo";
  return {
    apiKeyPepper,
    deviceTokenPepper,
    defaultMode,
    liveSendingEnabled: env.CWP_LIVE_SENDING_ENABLED === "true",
    maxRequestBodyBytes: int(env.CWP_MAX_REQUEST_BODY_BYTES, 16384),
    defaultRequestsPerMinute: int(env.CWP_DEFAULT_REQUESTS_PER_MINUTE, 5),
    defaultDailyUnits: int(env.CWP_DEFAULT_DAILY_SMS_UNITS, 50),
    jobExpirySeconds: int(env.CWP_JOB_EXPIRY_SECONDS, 300),
    deviceOnlineWindowSeconds: 90,
    idempotencyTtlSeconds: 24 * 60 * 60,
    maxActiveKeys: 10,
    maxConnectedDevices: int(env.CWP_DEFAULT_MAX_CONNECTED_DEVICES, 1),
    jobLeaseSeconds: int(env.CWP_JOB_LEASE_SECONDS, 60),
    pairingChallengeSeconds: 600,
    firebaseWebApiKey: env.FIREBASE_WEB_API_KEY?.trim() || null,
    adminEmails: (env.CWP_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  };
}
