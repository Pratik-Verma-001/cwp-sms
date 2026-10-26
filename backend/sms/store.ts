import type { JobStatus } from "../../shared/status-machine/index.js";

export interface ApiKeyRecord {
  keyId: string;
  ownerUid: string;
  secretHash: string;
  environment: "test" | "live";
  scopes: string[];
  status: "active" | "revoked" | "expired";
  expiresAt?: Date;
  limits: { requestsPerMinute: number; dailyUnits: number };
}

/** Admin-set per-account overrides. Absent field = platform default. */
export interface UserLimits {
  dailyUnits?: number;
  requestsPerMinute?: number;
  maxDevices?: number;
  maxActiveKeys?: number;
}

export interface UserRecord {
  uid: string;
  email?: string | null;
  status: "active" | "suspended" | "closed";
  demoModeEnabled: boolean;
  liveSendingEnabled: boolean;
  limits?: UserLimits;
  createdAt?: Date;
  lastLoginAt?: Date;
}

/** Runtime platform switches set by an administrator (stored in Firestore `platform/settings`). */
export interface PlatformSettings {
  /** When set, replaces the CWP_LIVE_SENDING_ENABLED environment default. */
  liveSendingEnabled?: boolean;
}

export interface JobRecord {
  jobId: string;
  ownerUid: string;
  apiKeyId: string;
  mode: "demo" | "live";
  destination: string;
  destinationMasked: string;
  messagePayload: string;
  status: JobStatus;
  idempotencyRecordId: string;
  clientReference?: string;
  quotaUnitsReserved: number;
  attempts: number;
  claimVersion: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt?: Date;
  deviceId?: string;
  leaseExpiresAt?: Date;
  startedAt?: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  quotaUnitsConsumed?: number;
  errorCode?: string;
  safeErrorMessage?: string;
  deliveryReceiptAvailable?: boolean;
}

export interface CreateJobInput {
  job: JobRecord;
  normalizedPayloadHash: string;
  idempotencyExpiresAt: Date;
  limits: { requestsPerMinute: number; dailyUnits: number };
  now: Date;
}

export type CreateJobResult =
  | { kind: "created"; job: JobRecord }
  | { kind: "replayed"; job: JobRecord }
  | { kind: "conflict" }
  | { kind: "rate_limited" }
  | { kind: "quota_exceeded" };

/**
 * Persistence boundary for the send path.
 * `createJob` MUST atomically: check idempotency, enforce the per-minute rate limit,
 * reserve quota, and persist the job. Implementations: Firestore (production), memory (tests).
 */
export interface SendStore {
  getApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  getUser(uid: string): Promise<UserRecord | null>;
  getPlatformSettings(): Promise<PlatformSettings>;
  isSuppressed(ownerUid: string, destinationHash: string): Promise<boolean>;
  hasEligibleDevice(ownerUid: string, now: Date, onlineWindowSeconds: number): Promise<boolean>;
  createJob(input: CreateJobInput): Promise<CreateJobResult>;
  getJob(jobId: string): Promise<JobRecord | null>;
}
