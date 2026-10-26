import { z } from "zod";
import { authenticateDevice } from "../auth/deviceAuth.js";
import { authenticateUser } from "../auth/userAuth.js";
import { toErrorResult, type HttpResult } from "../errors.js";
import { idempotencyKeySchema, sendRequestSchema } from "../../shared/schemas/index.js";
import { parseBody } from "../validation/parse.js";
import { submitJob, type Deps } from "../sms/sendService.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

const dashboardSendSchema = sendRequestSchema.extend({ idempotencyKey: idempotencyKeySchema });

/**
 * The signed-in owner sends an SMS from the dashboard (no API key needed). It goes through the same
 * validation, idempotency, rate limit, quota, demo/live and device checks as the public API.
 */
export async function dashboardSend(
  input: RouteInput,
  mdeps: ManagementDeps,
  sdeps: Deps,
  requestId: string,
): Promise<HttpResult> {
  try {
    const now = nowOf(mdeps);
    const user = await authenticateUser(input.authorization, mdeps.verifier, mdeps.store, now);
    const body = parseBody(input.rawBody, dashboardSendSchema as z.ZodTypeAny, mdeps.config.maxRequestBodyBytes) as z.infer<typeof dashboardSendSchema>;
    const { idempotencyKey, ...sms } = body;
    return await submitJob(
      {
        ownerUid: user.uid,
        user,
        credentialId: `dash_${user.uid}`,
        credentialAllowsLive: true, // account and platform switches still apply inside submitJob
        baseLimits: { requestsPerMinute: mdeps.config.defaultRequestsPerMinute, dailyUnits: mdeps.config.defaultDailyUnits },
        body: sms,
        idempotencyKey,
      },
      { ...sdeps, now: mdeps.now ?? sdeps.now },
    );
  } catch (err) {
    return toErrorResult(err, requestId);
  }
}

/**
 * The owner's own paired phone creates a request from inside the Android app. Same rules as every other
 * path (idempotency, rate limit, quota, demo/live switches, online-phone check); counted per device.
 */
export async function connectorSend(
  input: RouteInput,
  mdeps: ManagementDeps,
  sdeps: Deps,
  requestId: string,
): Promise<HttpResult> {
  try {
    const now = nowOf(mdeps);
    const { device, user } = await authenticateDevice(input.authorization, mdeps.store, mdeps.config, now);
    const body = parseBody(input.rawBody, dashboardSendSchema as z.ZodTypeAny, mdeps.config.maxRequestBodyBytes) as z.infer<typeof dashboardSendSchema>;
    const { idempotencyKey, ...sms } = body;
    return await submitJob(
      {
        ownerUid: device.ownerUid,
        user,
        credentialId: `dev_${device.deviceId}`,
        credentialAllowsLive: true,
        baseLimits: { requestsPerMinute: mdeps.config.defaultRequestsPerMinute, dailyUnits: mdeps.config.defaultDailyUnits },
        body: sms,
        idempotencyKey,
      },
      { ...sdeps, now: mdeps.now ?? sdeps.now },
    );
  } catch (err) {
    return toErrorResult(err, requestId);
  }
}
