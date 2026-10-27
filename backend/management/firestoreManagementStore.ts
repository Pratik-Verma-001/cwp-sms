import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { docToJob, docToUser, fromDoc, jobToDoc, toDoc } from "../sms/firestoreStore.js";
import type { ApiKeyRecord, JobRecord, PlatformSettings, UserRecord } from "../sms/store.js";
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

const ts = (d: Date) => Timestamp.fromDate(d);

/** Requests that have reached an end state; in-flight ones cannot be deleted. */
const DELETABLE = new Set(["sent", "delivered", "failed", "unknown", "expired", "cancelled", "demo_completed"]);

export class FirestoreManagementStore implements ManagementStore {
  constructor(private readonly db: Firestore) {}

  private dayCounter(job: JobRecord): DocumentReference {
    return this.db.collection("usageCounters").doc(`day_${job.ownerUid}_${job.createdAt.toISOString().slice(0, 10)}`);
  }

  private eventDoc(job: JobRecord, from: string, to: string, source: string, now: Date): DocumentData {
    return { jobId: job.jobId, ownerUid: job.ownerUid, previousStatus: from, newStatus: to, source, deviceId: job.deviceId, createdAt: ts(now) };
  }

  async getUser(uid: string): Promise<UserRecord | null> {
    const snap = await this.db.collection("users").doc(uid).get();
    if (!snap.exists) return null;
    return docToUser(snap.data()!);
  }

  private platformCache?: { at: number; value: PlatformSettings };
  async getPlatformSettings(): Promise<PlatformSettings> {
    const c = this.platformCache;
    if (c && Date.now() - c.at < 15_000) return c.value;
    const snap = await this.db.collection("platform").doc("settings").get();
    const value: PlatformSettings = snap.exists && typeof snap.data()!.liveSendingEnabled === "boolean"
      ? { liveSendingEnabled: snap.data()!.liveSendingEnabled }
      : {};
    this.platformCache = { at: Date.now(), value };
    return value;
  }

  async setPlatformSettings(patch: { liveSendingEnabled: boolean | null }, now: Date, byUid: string): Promise<void> {
    await this.db.collection("platform").doc("settings").set(
      { liveSendingEnabled: patch.liveSendingEnabled === null ? FieldValue.delete() : patch.liveSendingEnabled, updatedAt: ts(now), updatedBy: byUid },
      { merge: true },
    );
    this.platformCache = undefined;
  }

  async listUsers(limit: number): Promise<AdminUser[]> {
    const snap = await this.db.collection("users").orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => {
      const x = d.data();
      return { ...docToUser(x), ...(x.createdAt ? { createdAt: x.createdAt.toDate() } : {}), ...(x.lastLoginAt ? { lastLoginAt: x.lastLoginAt.toDate() } : {}) } as AdminUser;
    });
  }

  async updateUser(uid: string, patch: UserPatch, now: Date): Promise<AdminUser | null> {
    const ref = this.db.collection("users").doc(uid);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = snap.data()!;
      const update: DocumentData = { updatedAt: ts(now) };
      const view: DocumentData = { ...cur };
      if (patch.status) update.status = view.status = patch.status;
      if (patch.liveSendingEnabled !== undefined) update.liveSendingEnabled = view.liveSendingEnabled = patch.liveSendingEnabled;
      if (patch.demoModeEnabled !== undefined) update.demoModeEnabled = view.demoModeEnabled = patch.demoModeEnabled;
      if (patch.limits) {
        const next: Record<string, number> = { ...(cur.limits ?? {}) };
        for (const [k, v] of Object.entries(patch.limits)) {
          if (v === null) delete next[k];
          else if (v !== undefined) next[k] = v;
        }
        const has = Object.keys(next).length > 0;
        update.limits = has ? next : FieldValue.delete();
        if (has) view.limits = next;
        else delete view.limits;
      }
      tx.update(ref, update);
      return {
        ...docToUser(view),
        ...(cur.createdAt ? { createdAt: cur.createdAt.toDate() } : {}),
        ...(cur.lastLoginAt ? { lastLoginAt: cur.lastLoginAt.toDate() } : {}),
      } as AdminUser;
    });
  }

  async listAllActiveKeys(limit: number): Promise<StoredKey[]> {
    const snap = await this.db.collection("apiKeys").where("status", "==", "active").limit(limit).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => fromDoc<StoredKey>(d.data()));
  }

  async listAllActiveDevices(limit: number): Promise<DeviceRecord[]> {
    const snap = await this.db.collection("devices").where("status", "==", "active").limit(limit).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => fromDoc<DeviceRecord>(d.data()));
  }

  async addAudit(e: AuditEntry): Promise<void> {
    await this.db.collection("auditLogs").add({
      at: ts(e.at), actorUid: e.actorUid, actorEmail: e.actorEmail, action: e.action,
      ...(e.targetUid ? { targetUid: e.targetUid } : {}), ...(e.detail ? { detail: e.detail } : {}),
    });
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const snap = await this.db.collection("auditLogs").orderBy("at", "desc").limit(limit).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => {
      const x = d.data();
      return { at: x.at.toDate(), actorUid: x.actorUid, actorEmail: x.actorEmail ?? null, action: x.action, ...(x.targetUid ? { targetUid: x.targetUid } : {}), ...(x.detail ? { detail: x.detail } : {}) } as AuditEntry;
    });
  }

  async ensureUser(i: { uid: string; email: string | null; emailVerified: boolean; now: Date }): Promise<UserRecord> {
    const ref = this.db.collection("users").doc(i.uid);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const d = snap.data()!;
        tx.update(ref, { lastLoginAt: ts(i.now), emailVerified: i.emailVerified });
        return docToUser(d);
      }
      // Server-assigned defaults only: role "user", demo on, live off until an administrator enables it.
      const fresh = {
        uid: i.uid,
        email: i.email,
        role: "user",
        status: "active",
        planId: "free",
        demoModeEnabled: true,
        liveSendingEnabled: false,
        emailVerified: i.emailVerified,
        createdAt: ts(i.now),
        updatedAt: ts(i.now),
        lastLoginAt: ts(i.now),
      };
      tx.set(ref, fresh);
      return { uid: i.uid, email: i.email, status: "active", demoModeEnabled: true, liveSendingEnabled: false } as UserRecord;
    });
  }

  async insertKey(key: StoredKey, maxActive: number): Promise<"ok" | "limit"> {
    const ref = this.db.collection("apiKeys").doc(key.keyId);
    const q = this.db.collection("apiKeys").where("ownerUid", "==", key.ownerUid).where("status", "==", "active");
    return this.db.runTransaction(async (tx: Transaction) => {
      const active = await tx.get(q);
      if (active.size >= maxActive) return "limit" as const;
      tx.create(ref, toDoc(key));
      return "ok" as const;
    });
  }

  async listKeys(ownerUid: string): Promise<StoredKey[]> {
    const snap = await this.db.collection("apiKeys").where("ownerUid", "==", ownerUid).limit(100).get();
    return snap.docs
      .map((d: QueryDocumentSnapshot) => fromDoc<StoredKey>(d.data()))
      .sort((a: StoredKey, b: StoredKey) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revokeKey(ownerUid: string, keyId: string, now: Date): Promise<"revoked" | "not_found"> {
    const ref = this.db.collection("apiKeys").doc(keyId);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.ownerUid !== ownerUid) return "not_found" as const;
      if (snap.data()!.status === "active") tx.update(ref, { status: "revoked", revokedAt: ts(now) });
      return "revoked" as const;
    });
  }

  async deleteKey(ownerUid: string, keyId: string): Promise<"deleted" | "not_found" | "still_active"> {
    const ref = this.db.collection("apiKeys").doc(keyId);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.ownerUid !== ownerUid) return "not_found" as const;
      if (snap.data()!.status === "active") return "still_active" as const;
      tx.delete(ref);
      return "deleted" as const;
    });
  }

  async getOtp(deviceId: string): Promise<OtpRecord | null> {
    const snap = await this.db.collection("deviceOtps").doc(deviceId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return { phoneHash: d.phoneHash, codeHash: d.codeHash, createdAt: d.createdAt.toDate(), expiresAt: d.expiresAt.toDate(), attempts: d.attempts, sends: d.sends ?? [], ...(d.jobId ? { jobId: d.jobId } : {}) };
  }
  async saveOtp(deviceId: string, o: OtpRecord): Promise<void> {
    await this.db.collection("deviceOtps").doc(deviceId).set({ phoneHash: o.phoneHash, codeHash: o.codeHash, createdAt: ts(o.createdAt), expiresAt: ts(o.expiresAt), attempts: o.attempts, sends: o.sends, ...(o.jobId ? { jobId: o.jobId } : {}) });
  }
  async deleteOtp(deviceId: string): Promise<void> {
    await this.db.collection("deviceOtps").doc(deviceId).delete();
  }

  async saveChallenge(c: { hash: string; ownerUid: string; createdAt: Date; expiresAt: Date }): Promise<void> {
    await this.db.collection("devicePairings").doc(c.hash).set({ ownerUid: c.ownerUid, createdAt: ts(c.createdAt), expiresAt: ts(c.expiresAt) });
  }

  async consumeChallenge(hash: string, ownerUid: string, now: Date): Promise<boolean> {
    const ref = this.db.collection("devicePairings").doc(hash);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = snap.data()!;
      if (d.ownerUid !== ownerUid || d.expiresAt.toDate().getTime() <= now.getTime()) return false;
      tx.delete(ref); // deleting inside the transaction is what makes it single-use
      return true;
    });
  }

  async insertDevice(device: DeviceRecord, maxActive: number): Promise<"ok" | "limit"> {
    const ref = this.db.collection("devices").doc(device.deviceId);
    const q = this.db.collection("devices").where("ownerUid", "==", device.ownerUid).where("status", "==", "active");
    return this.db.runTransaction(async (tx: Transaction) => {
      const active = await tx.get(q);
      if (active.size >= maxActive) return "limit" as const;
      tx.create(ref, toDoc(device));
      return "ok" as const;
    });
  }

  async listDevices(ownerUid: string): Promise<DeviceRecord[]> {
    const snap = await this.db.collection("devices").where("ownerUid", "==", ownerUid).limit(50).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => fromDoc<DeviceRecord>(d.data()));
  }

  async revokeDevice(ownerUid: string, deviceId: string, now: Date): Promise<"revoked" | "not_found"> {
    const ref = this.db.collection("devices").doc(deviceId);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.ownerUid !== ownerUid) return "not_found" as const;
      if (snap.data()!.status === "active") {
        tx.update(ref, { status: "revoked", connectorRunning: false, revokedAt: ts(now), updatedAt: ts(now) });
      }
      return "revoked" as const;
    });
  }

  async deleteDevice(ownerUid: string, deviceId: string): Promise<"deleted" | "not_found" | "still_active"> {
    const ref = this.db.collection("devices").doc(deviceId);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.ownerUid !== ownerUid) return "not_found" as const;
      if (snap.data()!.status === "active") return "still_active" as const;
      tx.delete(ref);
      return "deleted" as const;
    });
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const snap = await this.db.collection("devices").doc(deviceId).get();
    return snap.exists ? fromDoc<DeviceRecord>(snap.data()!) : null;
  }

  async updateHeartbeat(deviceId: string, p: HeartbeatPatch, now: Date): Promise<void> {
    const ref = this.db.collection("devices").doc(deviceId);
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      // Never revive a revoked device with a late heartbeat.
      if (!snap.exists || snap.data()!.status !== "active") return;
      tx.update(ref, { ...toDoc(p), lastSeenAt: ts(now), updatedAt: ts(now) });
    });
  }

  async getApiKey(keyId: string): Promise<ApiKeyRecord | null> {
    const snap = await this.db.collection("apiKeys").doc(keyId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      keyId: d.keyId,
      ownerUid: d.ownerUid,
      secretHash: d.secretHash,
      environment: d.environment,
      scopes: d.scopes ?? [],
      status: d.status,
      limits: d.limits,
      ...(d.expiresAt ? { expiresAt: d.expiresAt.toDate() } : {}),
    };
  }

  /** Needs the composite index smsJobs(ownerUid ASC, createdAt DESC). */
  async listJobs(ownerUid: string, limit: number): Promise<JobRecord[]> {
    const snap = await this.db.collection("smsJobs").where("ownerUid", "==", ownerUid).orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d: QueryDocumentSnapshot) => docToJob(d.data()));
  }

  async listJobEvents(jobId: string): Promise<JobEventRecord[]> {
    // Equality-only (no composite index); ordering happens in code.
    const snap = await this.db.collection("smsJobEvents").where("jobId", "==", jobId).limit(50).get();
    return snap.docs
      .map((d: QueryDocumentSnapshot) => {
        const e = d.data();
        return { jobId, from: e.previousStatus, to: e.newStatus, source: e.source, at: e.createdAt.toDate() } as JobEventRecord;
      })
      .sort((a: JobEventRecord, b: JobEventRecord) => a.at.getTime() - b.at.getTime());
  }

  async deleteJob(ownerUid: string, jobId: string): Promise<"deleted" | "not_found" | "active"> {
    const ref = this.db.collection("smsJobs").doc(jobId);
    const res = await this.db.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.ownerUid !== ownerUid) return "not_found" as const;
      if (!DELETABLE.has(String(snap.data()!.status))) return "active" as const;
      tx.delete(ref);
      return "deleted" as const;
    });
    if (res === "deleted") {
      const ev = await this.db.collection("smsJobEvents").where("jobId", "==", jobId).limit(50).get();
      await Promise.all(ev.docs.map((d: QueryDocumentSnapshot) => d.ref.delete()));
    }
    return res;
  }

  async getDayUsage(ownerUid: string, day: string): Promise<number> {
    const snap = await this.db.collection("usageCounters").doc(`day_${ownerUid}_${day}`).get();
    return snap.exists ? Number(snap.data()!.reservedUnits ?? 0) : 0;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const snap = await this.db.collection("smsJobs").doc(jobId).get();
    return snap.exists ? docToJob(snap.data()!) : null;
  }

  async claimNextJob({ device, now, leaseSeconds }: { device: DeviceRecord; now: Date; leaseSeconds: number }): Promise<JobRecord | null> {
    const jobs = this.db.collection("smsJobs");
    const queuedQ = jobs.where("ownerUid", "==", device.ownerUid).where("status", "==", "queued").orderBy("createdAt", "asc").limit(10);
    const assignedQ = jobs.where("ownerUid", "==", device.ownerUid).where("status", "==", "assigned").limit(20);

    return this.db.runTransaction(async (tx: Transaction) => {
      // ---- all reads first ----
      const [queuedSnap, assignedSnap] = await Promise.all([tx.get(queuedQ), tx.get(assignedQ)]);

      // Only `assigned` jobs whose lease ran out are recoverable: sending/unknown are never in this query.
      const recovered = assignedSnap.docs
        .map((d: QueryDocumentSnapshot) => docToJob(d.data()))
        .filter((j: JobRecord) => j.mode === "live" && j.leaseExpiresAt !== undefined && j.leaseExpiresAt.getTime() <= now.getTime());

      const candidates = [...queuedSnap.docs.map((d: QueryDocumentSnapshot) => docToJob(d.data())), ...recovered]
        .filter((j: JobRecord) => j.mode === "live")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const expired = candidates.filter((j: JobRecord) => j.expiresAt.getTime() <= now.getTime());
      const chosen = candidates.find((j: JobRecord) => j.expiresAt.getTime() > now.getTime());

      const counterRefs = [...new Map(expired.map((j: JobRecord) => [this.dayCounter(j).path, this.dayCounter(j)])).values()];
      const counterSnaps = await Promise.all(counterRefs.map((r) => tx.get(r)));

      // ---- then all writes ----
      const recoveredIds = new Set(recovered.map((j: JobRecord) => j.jobId));
      for (const j of recovered) {
        if (j.jobId === chosen?.jobId) continue;
        tx.update(jobs.doc(j.jobId), { status: "queued", deviceId: FieldValue.delete(), leaseExpiresAt: FieldValue.delete(), updatedAt: ts(now) });
        tx.set(this.db.collection("smsJobEvents").doc(), this.eventDoc(j, "assigned", "queued", "recovery", now));
      }

      const released = new Map<string, number>();
      for (const j of expired) {
        tx.update(jobs.doc(j.jobId), { status: "expired", completedAt: ts(now), updatedAt: ts(now), leaseExpiresAt: FieldValue.delete() });
        tx.set(this.db.collection("smsJobEvents").doc(), this.eventDoc(j, recoveredIds.has(j.jobId) ? "assigned" : "queued", "expired", "recovery", now));
        const path = this.dayCounter(j).path;
        released.set(path, (released.get(path) ?? 0) + j.quotaUnitsReserved);
      }
      counterRefs.forEach((ref, i) => {
        const cur: number = counterSnaps[i]!.exists ? counterSnaps[i]!.data()!.reservedUnits : 0;
        tx.set(ref, { reservedUnits: Math.max(0, cur - (released.get(ref.path) ?? 0)), updatedAt: ts(now) }, { merge: true });
      });

      if (!chosen) return null;
      const lease = new Date(now.getTime() + leaseSeconds * 1000);
      const claimed: JobRecord = { ...chosen, status: "assigned", deviceId: device.deviceId, claimVersion: chosen.claimVersion + 1, leaseExpiresAt: lease, updatedAt: now };
      tx.set(jobs.doc(chosen.jobId), jobToDoc(claimed));
      tx.set(this.db.collection("smsJobEvents").doc(), this.eventDoc(claimed, recoveredIds.has(chosen.jobId) ? "assigned" : "queued", "assigned", "connector", now));
      return claimed;
    });
  }

  async applyTransition(a: TransitionArgs): Promise<TransitionResult> {
    const ref = this.db.collection("smsJobs").doc(a.jobId);
    return this.db.runTransaction(async (tx: Transaction): Promise<TransitionResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false };
      const job = docToJob(snap.data()!);
      if (job.status !== a.from) return { ok: false };
      if (a.claimVersion !== undefined && job.claimVersion !== a.claimVersion) return { ok: false };
      if (a.deviceId !== undefined && job.deviceId !== a.deviceId) return { ok: false };

      const counterRef = a.releaseQuota ? this.dayCounter(job) : undefined;
      const counterSnap = counterRef ? await tx.get(counterRef) : undefined;

      const next: JobRecord = { ...job, ...(a.patch ?? {}), status: a.to, updatedAt: a.now };
      tx.set(ref, jobToDoc(next));
      if (a.to !== a.from) tx.set(this.db.collection("smsJobEvents").doc(), this.eventDoc(next, a.from, a.to, a.source, a.now));
      if (counterRef && counterSnap) {
        const cur: number = counterSnap.exists ? counterSnap.data()!.reservedUnits : 0;
        tx.set(counterRef, { reservedUnits: Math.max(0, cur - job.quotaUnitsReserved), updatedAt: ts(a.now) }, { merge: true });
      }
      return { ok: true, job: next };
    });
  }
}
