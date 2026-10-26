export const JOB_STATUSES = [
  "accepted",
  "queued",
  "assigned",
  "sending",
  "sent",
  "delivery_pending",
  "delivered",
  "failed",
  "unknown",
  "expired",
  "cancelled",
  "demo_completed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  accepted: ["queued", "failed", "demo_completed"],
  queued: ["assigned", "expired", "cancelled"],
  assigned: ["sending", "expired", "cancelled", "queued"],
  sending: ["sent", "failed", "unknown"],
  sent: ["delivery_pending", "delivered", "failed"],
  delivery_pending: ["delivered", "failed"],
  unknown: ["sent", "failed", "delivered"],
  delivered: [],
  failed: [],
  expired: [],
  cancelled: [],
  demo_completed: [],
};

/** Rank used to ignore duplicate / out-of-order callbacks. */
const RANK: Record<JobStatus, number> = {
  accepted: 0,
  queued: 1,
  assigned: 2,
  sending: 3,
  unknown: 4,
  sent: 5,
  delivery_pending: 6,
  delivered: 7,
  failed: 7,
  expired: 7,
  cancelled: 7,
  demo_completed: 7,
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True when an incoming status would move a job backwards (stale callback). */
export function isStale(current: JobStatus, incoming: JobStatus): boolean {
  return RANK[incoming] <= RANK[current];
}

/** Only `delivered` may ever be presented as confirmed delivery. */
export function isConfirmedDelivery(status: JobStatus): boolean {
  return status === "delivered";
}

/** Statuses where the message may already have left the device: never auto-retry. */
export function isDuplicateRisk(status: JobStatus): boolean {
  return status === "sending" || status === "unknown";
}

export function isSimulated(status: JobStatus): boolean {
  return status === "demo_completed";
}
