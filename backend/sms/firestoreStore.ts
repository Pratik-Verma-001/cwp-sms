import {
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import type {
  ApiKeyRecord,
  CreateJobInput,
  CreateJobResult,
  JobRecord,
  PlatformSettings,
  SendStore,
  UserRecord,
} from "./store.js";

const ts = (d: Date) => Timestamp.fromDate(d);

/** Converts every Date to a Firestore Timestamp (undefined values are dropped by the client setting). */
export function toDoc(obj: object): DocumentData {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v instanceof Date ? ts(v) : v]));
}

/** Converts every Timestamp back to a Date. */
export function fromDoc<T>(d: DocumentData): T {
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v instanceof Timestamp ? (v as Timestamp).toDate() : v])) as T;
}

export const jobToDoc = (job: JobRecord): DocumentData => toDoc(job);
export const docToJob = (d: DocumentData): JobRecord => fromDoc<JobRecord>(d);

/** Shared by both Firestore stores so every read of a user sees the same shape. */
export function docToUser(d: DocumentData): UserRecord {
  return {
    uid: d.uid,
    email: d.email ?? null,
    status: d.status,
    demoModeEnabled: Boolean(d.demoModeEnabled),
    liveSendingEnabled: Boolean(d.liveSendingEnabled),
    ...(d.limits && typeof d.limits === "object" ? { limits: d.limits } : {}),
    ...(d.createdAt?.toDate ? { createdAt: d.createdAt.toDate() } : {}),
    ...(d.lastLoginAt?.toDate ? { lastLoginAt: d.lastLoginAt.toDate() } : {}),
  };
}

export class FirestoreStore implements SendStore {
  constructor(private readonly db: Firestore) {}

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

  async getUser(uid: string): Promise<UserRecord | null> {
    const snap = await this.db.collection("users").doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return docToUser(d);
  }

  private platformCache?: { at: number; value: PlatformSettings };
  /** Cached for 15 s per warm instance so polling phones do not read it on every request. */
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

  async isSuppressed(ownerUid: string, destinationHash: string): Promise<boolean> {
    const snap = await this.db.collection("suppressions").doc(`${ownerUid}_${destinationHash}`).get();
    return snap.exists;
  }

  async hasEligibleDevice(ownerUid: string, now: Date, onlineWindowSeconds: number): Promise<boolean> {
    // Equality-only query (no composite index); recency is filtered in code.
    const snap = await this.db
      .collection("devices")
      .where("ownerUid", "==", ownerUid)
      .where("status", "==", "active")
      .limit(20)
      .get();
    return snap.docs.some((doc: QueryDocumentSnapshot) => {
      const d = doc.data();
      const last: Date | undefined = d.lastSeenAt?.toDate();
      return (
        d.connectorRunning === true &&
        d.smsPermissionGranted === true &&
        d.telephonyAvailable === true &&
        last !== undefined &&
        now.getTime() - last.getTime() <= onlineWindowSeconds * 1000
      );
    });
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const snap = await this.db.collection("smsJobs").doc(jobId).get();
    return snap.exists ? docToJob(snap.data()!) : null;
  }

  /**
   * Single transaction: idempotency check -> rate limit -> quota reservation -> job + idempotency record.
   * All reads happen before any write, as Firestore requires.
   */
  async createJob(input: CreateJobInput): Promise<CreateJobResult> {
    const { job, now, limits } = input;
    const db = this.db;
    const minute = Math.floor(now.getTime() / 60000);
    const day = now.toISOString().slice(0, 10);

    const idemRef = db.collection("idempotencyRecords").doc(job.idempotencyRecordId);
    const rateRef = db.collection("usageCounters").doc(`rl_${job.apiKeyId}_${minute}`);
    const dayRef = db.collection("usageCounters").doc(`day_${job.ownerUid}_${day}`);
    const jobRef = db.collection("smsJobs").doc(job.jobId);
    const eventRef = db.collection("smsJobEvents").doc();

    return db.runTransaction(async (tx: Transaction): Promise<CreateJobResult> => {
      const [idemSnap, rateSnap, daySnap] = await Promise.all([
        tx.get(idemRef),
        tx.get(rateRef),
        tx.get(dayRef),
      ]);

      if (idemSnap.exists) {
        const idem = idemSnap.data()!;
        if (idem.normalizedPayloadHash !== input.normalizedPayloadHash) return { kind: "conflict" };
        const original = await tx.get(db.collection("smsJobs").doc(idem.jobId));
        if (!original.exists) return { kind: "conflict" };
        return { kind: "replayed", job: docToJob(original.data()!) };
      }

      const count: number = rateSnap.exists ? rateSnap.data()!.count : 0;
      if (count >= limits.requestsPerMinute) return { kind: "rate_limited" };

      const reserved: number = daySnap.exists ? daySnap.data()!.reservedUnits : 0;
      if (reserved + job.quotaUnitsReserved > limits.dailyUnits) return { kind: "quota_exceeded" };

      tx.set(jobRef, jobToDoc(job));
      tx.set(idemRef, {
        ownerUid: job.ownerUid,
        apiKeyId: job.apiKeyId,
        normalizedPayloadHash: input.normalizedPayloadHash,
        jobId: job.jobId,
        createdAt: ts(now),
        expiresAt: ts(input.idempotencyExpiresAt),
      });
      tx.set(rateRef, { count: count + 1, expiresAt: ts(new Date(now.getTime() + 10 * 60000)) });
      tx.set(
        dayRef,
        { ownerUid: job.ownerUid, day, reservedUnits: reserved + job.quotaUnitsReserved, updatedAt: ts(now) },
        { merge: true },
      );
      tx.set(eventRef, {
        jobId: job.jobId,
        ownerUid: job.ownerUid,
        previousStatus: "accepted",
        newStatus: job.status,
        source: "api",
        createdAt: ts(now),
      });
      return { kind: "created", job };
    });
  }
}
