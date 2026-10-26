import type {
  ApiKeyRecord,
  CreateJobInput,
  CreateJobResult,
  JobRecord,
  PlatformSettings,
  SendStore,
  UserRecord,
} from "./store.js";

export interface MemoryDevice {
  ownerUid: string;
  status: "pending" | "active" | "paused" | "revoked";
  connectorRunning: boolean;
  smsPermissionGranted: boolean;
  lastSeenAt: Date;
}

/** In-memory SendStore for tests. Single-threaded, so each method is trivially atomic. */
export class MemoryStore implements SendStore {
  keys = new Map<string, ApiKeyRecord>();
  users = new Map<string, UserRecord>();
  suppressions = new Set<string>();
  devices: MemoryDevice[] = [];
  jobs = new Map<string, JobRecord>();
  private idem = new Map<string, { payloadHash: string; jobId: string }>();
  private rate = new Map<string, number>();
  protected usage = new Map<string, number>();

  async getApiKey(keyId: string) {
    return this.keys.get(keyId) ?? null;
  }
  platformSettings: PlatformSettings = {};
  async getPlatformSettings() {
    return { ...this.platformSettings };
  }
  async getUser(uid: string) {
    return this.users.get(uid) ?? null;
  }
  async isSuppressed(ownerUid: string, destinationHash: string) {
    return this.suppressions.has(`${ownerUid}_${destinationHash}`);
  }
  async hasEligibleDevice(ownerUid: string, now: Date, windowSeconds: number) {
    return this.devices.some(
      (d) =>
        d.ownerUid === ownerUid &&
        d.status === "active" &&
        d.connectorRunning &&
        d.smsPermissionGranted &&
        now.getTime() - d.lastSeenAt.getTime() <= windowSeconds * 1000,
    );
  }
  async getJob(jobId: string) {
    const j = this.jobs.get(jobId);
    return j ? { ...j } : null;
  }

  protected releaseUsage(usageKey: string, units: number) {
    this.usage.set(usageKey, Math.max(0, (this.usage.get(usageKey) ?? 0) - units));
  }

  async createJob(input: CreateJobInput): Promise<CreateJobResult> {
    const { job, now, limits } = input;
    const existing = this.idem.get(job.idempotencyRecordId);
    if (existing) {
      if (existing.payloadHash !== input.normalizedPayloadHash) return { kind: "conflict" };
      return { kind: "replayed", job: this.jobs.get(existing.jobId)! };
    }

    const rateKey = `${job.apiKeyId}:${Math.floor(now.getTime() / 60000)}`;
    const count = this.rate.get(rateKey) ?? 0;
    if (count >= limits.requestsPerMinute) return { kind: "rate_limited" };

    const usageKey = `${job.ownerUid}:${now.toISOString().slice(0, 10)}`;
    const used = this.usage.get(usageKey) ?? 0;
    if (used + job.quotaUnitsReserved > limits.dailyUnits) return { kind: "quota_exceeded" };

    this.rate.set(rateKey, count + 1);
    this.usage.set(usageKey, used + job.quotaUnitsReserved);
    this.jobs.set(job.jobId, job);
    this.idem.set(job.idempotencyRecordId, { payloadHash: input.normalizedPayloadHash, jobId: job.jobId });
    return { kind: "created", job };
  }
}
