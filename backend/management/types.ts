import type { JobStatus } from "../../shared/status-machine/index.js";
import type { ApiKeyRecord, JobRecord, PlatformSettings, UserLimits, UserRecord } from "../sms/store.js";

export interface StoredKey extends ApiKeyRecord {
  name: string;
  prefix: string;
  hashVersion: number;
  createdAt: Date;
  revokedAt?: Date;
  lastUsedAt?: Date;
}

/**
 * `paused` from the PRD is represented by `connectorRunning: false` on an `active` device,
 * so there are only two stored states.
 */
export interface DeviceRecord {
  deviceId: string;
  ownerUid: string;
  nickname: string;
  platform: "android";
  appVersion: string;
  /** The connector key this phone enrolled with; revoking that key disables the device. */
  connectorKeyId?: string;
  installId?: string;
  deviceCredentialHash: string;
  credentialVersion: number;
  status: "active" | "revoked";
  connectorRunning: boolean;
  smsPermissionGranted: boolean;
  telephonyAvailable: boolean;
  selectedSubscriptionId?: number;
  simDisplayLabel?: string;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
}

export interface HeartbeatPatch {
  connectorRunning: boolean;
  smsPermissionGranted: boolean;
  telephonyAvailable: boolean;
  appVersion?: string;
  selectedSubscriptionId?: number;
  simDisplayLabel?: string;
}

export interface TransitionArgs {
  jobId: string;
  from: JobStatus;
  to: JobStatus;
  now: Date;
  source: "connector" | "recovery" | "admin";
  claimVersion?: number;
  deviceId?: string;
  patch?: Partial<JobRecord>;
  /** Give reserved quota back (definitive failure before any send, or expiry). */
  releaseQuota?: boolean;
}

export interface JobEventRecord {
  jobId: string;
  from: string;
  to: string;
  source: string;
  at: Date;
}

export type AdminUser = UserRecord;

/** `null` in `limits` clears that override. */
export interface UserPatch {
  status?: "active" | "suspended";
  liveSendingEnabled?: boolean;
  demoModeEnabled?: boolean;
  limits?: { [K in keyof UserLimits]?: number | null };
}

export interface AuditEntry {
  at: Date;
  actorUid: string;
  actorEmail: string | null;
  action: string;
  targetUid?: string;
  /** Short, non-sensitive description. Never a secret, message text or phone number. */
  detail?: string;
}

export interface OtpRecord {
  phoneHash: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  /** Send times within the last hour (for the hourly cap). */
  sends: number[];
}

export type TransitionResult = { ok: true; job: JobRecord } | { ok: false };

export interface ManagementStore {
  ensureUser(input: {
    uid: string;
    email: string | null;
    emailVerified: boolean;
    now: Date;
  }): Promise<UserRecord>;

  insertKey(key: StoredKey, maxActive: number): Promise<"ok" | "limit">;
  listKeys(ownerUid: string): Promise<StoredKey[]>;
  revokeKey(ownerUid: string, keyId: string, now: Date): Promise<"revoked" | "not_found">;
  /** Permanently removes a key. Only a revoked key can be deleted. */
  deleteKey(ownerUid: string, keyId: string): Promise<"deleted" | "not_found" | "still_active">;

  saveChallenge(c: { hash: string; ownerUid: string; createdAt: Date; expiresAt: Date }): Promise<void>;
  /** Atomic and single-use: returns true at most once per challenge. */
  consumeChallenge(hash: string, ownerUid: string, now: Date): Promise<boolean>;

  insertDevice(device: DeviceRecord, maxActive: number): Promise<"ok" | "limit">;
  listDevices(ownerUid: string): Promise<DeviceRecord[]>;
  revokeDevice(ownerUid: string, deviceId: string, now: Date): Promise<"revoked" | "not_found">;
  /** Permanently removes a device. Only a revoked device can be deleted. */
  deleteDevice(ownerUid: string, deviceId: string): Promise<"deleted" | "not_found" | "still_active">;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  updateHeartbeat(deviceId: string, patch: HeartbeatPatch, now: Date): Promise<void>;

  /** One pending OTP per device. */
  getOtp(deviceId: string): Promise<OtpRecord | null>;
  saveOtp(deviceId: string, otp: OtpRecord): Promise<void>;
  deleteOtp(deviceId: string): Promise<void>;

  getUser(uid: string): Promise<UserRecord | null>;
  getApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  getPlatformSettings(): Promise<PlatformSettings>;

  // ---- administrator operations ----
  setPlatformSettings(patch: { liveSendingEnabled: boolean | null }, now: Date, byUid: string): Promise<void>;
  /** Newest first. */
  listUsers(limit: number): Promise<AdminUser[]>;
  updateUser(uid: string, patch: UserPatch, now: Date): Promise<AdminUser | null>;
  /** Active keys / devices across all accounts (bounded), for admin counts. */
  listAllActiveKeys(limit: number): Promise<StoredKey[]>;
  listAllActiveDevices(limit: number): Promise<DeviceRecord[]>;
  addAudit(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  listAudit(limit: number): Promise<AuditEntry[]>;
  /** Newest first. */
  listJobs(ownerUid: string, limit: number): Promise<JobRecord[]>;
  /** Oldest first. The caller must already have verified ownership of the job. */
  listJobEvents(jobId: string): Promise<JobEventRecord[]>;
  /** Reserved SMS units for one UTC day (YYYY-MM-DD). */
  getDayUsage(ownerUid: string, day: string): Promise<number>;
  getJob(jobId: string): Promise<JobRecord | null>;
  /** Deletes a finished request and its timeline. In-flight requests are refused ("active"). */
  deleteJob(ownerUid: string, jobId: string): Promise<"deleted" | "not_found" | "active">;
  /**
   * Atomically: recover jobs whose lease expired before sending began, expire jobs past their TTL
   * (releasing quota), then lease the oldest queued job to this device (claimVersion + 1).
   * Never re-queues a job that is `sending` or `unknown`.
   */
  claimNextJob(input: { device: DeviceRecord; now: Date; leaseSeconds: number }): Promise<JobRecord | null>;
  /** Compare-and-set on status (and claimVersion/deviceId when given). */
  applyTransition(args: TransitionArgs): Promise<TransitionResult>;
}
