import { authenticateApiKey } from "../auth/apiKeyAuth.js";
import { ApiError, toErrorResult, type HttpResult } from "../errors.js";
import { isConfirmedDelivery } from "../../shared/status-machine/index.js";
import type { Deps } from "./sendService.js";

export async function handleStatus(
  input: { authorization?: string; jobId: string },
  deps: Deps,
  requestId: string,
): Promise<HttpResult> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const { key } = await authenticateApiKey(input.authorization, deps.store, deps.config, now, [
      "sms:read",
      "sms:send",
    ]);

    const job = /^smsreq_[0-9a-f]{24}$/.test(input.jobId) ? await deps.store.getJob(input.jobId) : null;
    // Same 404 for "missing" and "belongs to another account" so IDs cannot be probed.
    if (!job || job.ownerUid !== key.ownerUid) {
      throw new ApiError(404, "NOT_FOUND", "Request not found.");
    }

    return {
      status: 200,
      body: {
        id: job.jobId,
        status: job.status,
        mode: job.mode,
        simulated: job.mode === "demo",
        deliveryConfirmed: isConfirmedDelivery(job.status),
        clientReference: job.clientReference ?? null,
        destination: job.destinationMasked,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
        expiresAt: job.expiresAt.toISOString(),
      },
    };
  } catch (err) {
    return toErrorResult(err, requestId);
  }
}
