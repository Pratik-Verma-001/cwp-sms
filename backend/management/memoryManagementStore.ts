import { MemoryStore } from "../sms/memoryStore.js";
import type { JobRecord, UserRecord } from "../sms/store.js";
import type {
  AdminUser,
  AuditEntry,
  DeviceRecord,
  HeartbeatPatch,
  JobEventRecord,
  ManagementStore,
  StoredKey,
  TransitionArgs,
  TransitionResult,
  UserPatch,
  OtpRecord,
} from "./types.js";

/** In-memory implementation of both store interfaces, for tests. Methods are synchronous inside, so atomic. */
/** Requests that have reached an end state; in-flight ones cannot be deleted. */
const DELETABLE = new Set(["sent", "delivered", "failed", "unknown", "expired", "cancelled", "demo_completed"]);

export class MemoryManagementStore extends MemoryStore implements ManagementStore {
  deviceMap = new Map<string, DeviceRecord>();
  challenges = new Map<string, { ownerUid: string; expiresAt: Date; used: boolean }>();
  events: JobEventRecord[] = [];

  async ensureUser(i: { uid: string; email: string | null; emailVerified: boolean; now: Date }): Promise<UserRecord> {
    let u = this.users.get(i.uid);
    if (!u) {
      u = { uid: i.uid, email: i.email, status: "active", demoModeEnabled: true, liveSendingEnabled: false };
      this.users.set(i.uid, u);
      this.userTimes.set(i.uid, { createdAt: i.now, lastLoginAt: i.now });
    } else {
      this.userTimes.set(i.uid, { createdAt: this.userTimes.get(i.uid)?.createdAt ?? i.now, lastLoginAt: i.now });
    }
    return u;
  }

  userTimes = new Map<string, { createdAt: Date; lastLoginAt: Date }>();
  audit: AuditEntry[] = [];

  async setPlatformSettings(patch: { liveSendingEnabled: boolean | null }) {
    if (patch.liveSendingEnabled === null) delete this.platformSettings.liveSendingEnabled;
    else this.platformSettings.liveSendingEnabled = patch.liveSendingEnabled;
  }
  async listUsers(limit: number): Promise<AdminUser[]> {
    return [...this.users.values()]
      .map((u) => ({ ...u, ...this.userTimes.get(u.uid) }))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, limit);
  }
  async updateUser(uid: string, patch: UserPatch): Promise<AdminUser | null> {
    const u = this.users.get(uid);
    if (!u) return null;
    if (patch.status) u.status = patch.status;
    if (patch.liveSendingEnabled !== undefined) u.liveSendingEnabled = patch.liveSendingEnabled;
    if (patch.demoModeEnabled !== undefined) u.demoModeEnabled = patch.demoModeEnabled;
    if (patch.limits) {
      const next = { ...(u.limits ?? {}) } as Record<string, number>;
      for (const [k, v] of Object.entries(patch.limits)) {
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = v;
      }
      if (Object.keys(next).length) u.limits = next;
      else delete u.limits;
    }
    return { ...u, ...this.userTimes.get(uid) };
  }
  async listAllActiveKeys(limit: number) {
    return ([...this.keys.values()] as StoredKey[]).filter((k) => k.status === "active").slice(0, limit);
  }
  async listAllActiveDevices(limit: number) {
    return [...this.deviceMap.values()].filter((d) => d.status === "active").slice(0, limit);
  }
  async addAudit(e: AuditEntry) {
    this.audit.push(e);
  }
  async listAudit(limit: number) {
    return [...this.audit].reverse().sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }

  async insertKey(key: StoredKey, maxActive: number) {
    const active = [...this.keys.values()].filter((k) => k.ownerUid === key.ownerUid && k.status === "active");
    if (active.length >= maxActive) return "limit" as const;
    this.keys.set(key.keyId, key);
    return "ok" as const;
  }
  async listKeys(ownerUid: string) {
    return ([...this.keys.values()] as StoredKey[])
      .filter((k) => k.ownerUid === ownerUid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async revokeKey(ownerUid: string, keyId: string, now: Date) {
    const k = this.keys.get(keyId) as StoredKey | undefined;
    if (!k || k.ownerUid !== ownerUid) return "not_found" as const;
    if (k.status === "active") {
      k.status = "revoked";
      k.revokedAt = now;
    }
    return "revoked" as const;
  }

  async deleteKey(ownerUid: string, keyId: string) {
    const k = this.keys.get(keyId) as StoredKey | undefined;
    if (!k || k.ownerUid !== ownerUid) return "not_found" as const;
    if (k.status === "active") return "still_active" as const;
    this.keys.delete(keyId);
    return "deleted" as const;
  }

  otps = new Map<string, OtpRecord>();
  async getOtp(deviceId: string) { return this.otps.get(deviceId) ?? null; }
  async saveOtp(deviceId: string, otp: OtpRecord) { this.otps.set(deviceId, otp); }
  async deleteOtp(deviceId: string) { this.otps.delete(deviceId); }

  async saveChallenge(c: { hash: string; ownerUid: string; createdAt: Date; expiresAt: Date }) {
    this.challenges.set(c.hash, { ownerUid: c.ownerUid, expiresAt: c.expiresAt, used: false });
  }
  async consumeChallenge(hash: string, ownerUid: string, now: Date) {
    const c = this.challenges.get(hash);
    if (!c || c.used || c.ownerUid !== ownerUid || c.expiresAt.getTime() <= now.getTime()) return false;
    c.used = true;
    return true;
  }

  async insertDevice(device: DeviceRecord, maxActive: number) {
    const active = [...this.deviceMap.values()].filter((d) => d.ownerUid === device.ownerUid && d.status === "active");
    if (active.length >= maxActive) return "limit" as const;
    this.deviceMap.set(device.deviceId, device);
    return "ok" as const;
  }
  async listDevices(ownerUid: string) {
    return [...this.deviceMap.values()].filter((d) => d.ownerUid === ownerUid);
  }
  async revokeDevice(ownerUid: string, deviceId: string, now: Date) {
    const d = this.deviceMap.get(deviceId);
    if (!d || d.ownerUid !== ownerUid) return "not_found" as const;
    if (d.status === "active") {
      d.status = "revoked";
      d.connectorRunning = false;
      d.revokedAt = now;
      d.updatedAt = now;
    }
    return "revoked" as const;
  }
  async deleteDevice(ownerUid: string, deviceId: string) {
    const d = this.deviceMap.get(deviceId);
    if (!d || d.ownerUid !== ownerUid) return "not_found" as const;
    if (d.status === "active") return "still_active" as const;
    this.deviceMap.delete(deviceId);
    return "deleted" as const;
  }
  async getDevice(deviceId: string) {
    return this.deviceMap.get(deviceId) ?? null;
  }
  async updateHeartbeat(deviceId: string, p: HeartbeatPatch, now: Date) {
    const d = this.deviceMap.get(deviceId);
    if (!d || d.status !== "active") return;
    Object.assign(d, p, { lastSeenAt: now, updatedAt: now });
  }

  // Overrides the simpler test-only device list so eligibility reflects real device records.
  override async hasEligibleDevice(ownerUid: string, now: Date, windowSeconds: number) {
    return [...this.deviceMap.values()].some(
      (d) =>
        d.ownerUid === ownerUid &&
        d.status === "active" &&
        d.connectorRunning &&
        d.smsPermissionGranted &&
        d.telephonyAvailable &&
        d.lastSeenAt !== undefined &&
        now.getTime() - d.lastSeenAt.getTime() <= windowSeconds * 1000,
    );
  }

  private release(job: JobRecord) {
    const key = `${job.ownerUid}:${job.createdAt.toISOString().slice(0, 10)}`;
    this.releaseUsage(key, job.quotaUnitsReserved);
  }

  private record(job: JobRecord, from: string, to: string, source: string, at: Date) {
    this.events.push({ jobId: job.jobId, from, to, source, at });
  }

  async listJobs(ownerUid: string, limit: number) {
    return [...this.jobs.values()]
      .filter((j) => j.ownerUid === ownerUid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
  async deleteJob(ownerUid: string, jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerUid !== ownerUid) return "not_found" as const;
    if (!DELETABLE.has(j.status)) return "active" as const;
    this.jobs.delete(jobId);
    this.events = this.events.filter((e) => e.jobId !== jobId);
    return "deleted" as const;
  }
  async listJobEvents(jobId: string) {
    return this.events.filter((e) => e.jobId === jobId).sort((a, b) => a.at.getTime() - b.at.getTime());
  }
  async getDayUsage(ownerUid: string, day: string) {
    return this.usage.get(`${ownerUid}:${day}`) ?? 0;
  }

  async claimNextJob({ device, now, leaseSeconds }: { device: DeviceRecord; now: Date; leaseSeconds: number }) {
    const mine = [...this.jobs.values()].filter((j) => j.ownerUid === device.ownerUid && j.mode === "live");

    for (const j of mine) {
      if (j.status === "assigned" && j.leaseExpiresAt && j.leaseExpiresAt.getTime() <= now.getTime()) {
        this.record(j, "assigned", "queued", "recovery", now);
        j.status = "queued";
        delete j.deviceId;
        delete j.leaseExpiresAt;
        j.updatedAt = now;
      }
    }

    const queued = mine.filter((j) => j.status === "queued").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const j of queued) {
      if (j.expiresAt.getTime() <= now.getTime()) {
        this.record(j, "queued", "expired", "recovery", now);
        j.status = "expired";
        j.completedAt = now;
        j.updatedAt = now;
        this.release(j);
        continue;
      }
      this.record(j, "queued", "assigned", "connector", now);
      j.status = "assigned";
      j.deviceId = device.deviceId;
      j.claimVersion += 1;
      j.leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      j.updatedAt = now;
      return { ...j };
    }
    return null;
  }

  async applyTransition(a: TransitionArgs): Promise<TransitionResult> {
    const job = this.jobs.get(a.jobId);
    if (!job || job.status !== a.from) return { ok: false };
    if (a.claimVersion !== undefined && job.claimVersion !== a.claimVersion) return { ok: false };
    if (a.deviceId !== undefined && job.deviceId !== a.deviceId) return { ok: false };
    Object.assign(job, a.patch ?? {});
    if (a.to !== a.from) {
      job.status = a.to;
      this.record(job, a.from, a.to, a.source, a.now);
    }
    job.updatedAt = a.now;
    if (a.releaseQuota) this.release(job);
    return { ok: true, job: { ...job } };
  }
}
