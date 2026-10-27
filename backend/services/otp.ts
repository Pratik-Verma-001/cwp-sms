import { randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authenticateDevice } from "../auth/deviceAuth.js";
import { ApiError, toErrorResult, type HttpResult } from "../errors.js";
import { E164 } from "../../shared/schemas/index.js";
import { hashValue } from "../security/apiKey.js";
import { parseBody } from "../validation/parse.js";
import { submitJob, type Deps } from "../sms/sendService.js";
import { nowOf, type ManagementDeps, type RouteInput } from "./deps.js";

const OTP_TTL_S = 300;
const RESEND_AFTER_S = 30;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const sendSchema = z.object({ phone: z.string().regex(E164, "phone must be in international format, e.g. +919876543210") }).strict();
const verifySchema = z.object({ phone: z.string().regex(E164), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }).strict();

const h = (pepper: string, label: string, v: string) => hashValue(pepper, label, v);

/**
 * "Real test" step 1: the signed-in phone sends a 6-digit code by real SMS (through its own SIM and the normal job pipeline,
 * so quota, limits and the online-phone check all apply). Only a keyed hash of the code is stored.
 */
export async function otpSend(input: RouteInput, mdeps: ManagementDeps, sdeps: Deps, requestId: string): Promise<HttpResult> {
  try {
    const now = nowOf(mdeps);
    const { device, user } = await authenticateDevice(input.authorization, mdeps.store, mdeps.config, now);
    const { phone } = parseBody(input.rawBody, sendSchema, mdeps.config.maxRequestBodyBytes);
    const pepper = mdeps.config.deviceTokenPepper;
    const prev = await mdeps.store.getOtp(device.deviceId);
    const sends = (prev?.sends ?? []).filter((t) => now.getTime() - t < 3600_000);
    const last = sends.length ? Math.max(...sends) : 0;
    const wait = Math.ceil((last + RESEND_AFTER_S * 1000 - now.getTime()) / 1000);
    if (wait > 0) throw new ApiError(429, "OTP_TOO_SOON", `Please wait ${wait}s before asking for another code.`);
    if (sends.length >= MAX_SENDS_PER_HOUR) throw new ApiError(429, "OTP_LIMIT", "Too many codes requested. Try again in an hour.");

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const res = await submitJob(
      {
        ownerUid: device.ownerUid,
        user,
        credentialId: `dev_${device.deviceId}`,
        credentialAllowsLive: true,
        baseLimits: { requestsPerMinute: mdeps.config.defaultRequestsPerMinute, dailyUnits: mdeps.config.defaultDailyUnits },
        body: { to: phone, message: `${code} is your CWP SMS verification code. It expires in 5 minutes. Do not share it.`, clientReference: "otp", mode: "live" },
        idempotencyKey: `otp_${randomBytes(12).toString("hex")}`,
      },
      { ...sdeps, now: mdeps.now ?? sdeps.now },
    );
    if (res.status >= 400) return res; // not stored: nothing was sent
    const jobId = (res.body as { id?: string } | undefined)?.id;
    await mdeps.store.saveOtp(device.deviceId, {
      ...(jobId ? { jobId } : {}),
      phoneHash: h(pepper, "otp-phone", phone),
      codeHash: h(pepper, `otp-code:${phone}`, code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + OTP_TTL_S * 1000),
      attempts: 0,
      sends: [...sends, now.getTime()],
    });
    return { status: 202, body: { sent: true, requestId: jobId ?? null, expiresInSeconds: OTP_TTL_S, resendAfterSeconds: RESEND_AFTER_S } };
  } catch (err) {
    return toErrorResult(err, requestId);
  }
}

/** Step 2: check the code. Single-use, expires, and locks after too many wrong tries. */
export async function otpVerify(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const { device } = await authenticateDevice(input.authorization, deps.store, deps.config, now);
  const { phone, code } = parseBody(input.rawBody, verifySchema, deps.config.maxRequestBodyBytes);
  const pepper = deps.config.deviceTokenPepper;
  const otp = await deps.store.getOtp(device.deviceId);
  if (!otp || otp.phoneHash !== h(pepper, "otp-phone", phone)) throw new ApiError(400, "OTP_NOT_FOUND", "No code was requested for this number. Tap Send OTP first.");
  if (otp.expiresAt.getTime() <= now.getTime()) {
    await deps.store.deleteOtp(device.deviceId);
    throw new ApiError(400, "OTP_EXPIRED", "This code has expired. Request a new one.");
  }
  // The code only counts if its SMS really left the phone (a copy in the Sent folder proves nothing).
  const failure = await sendFailure(deps, otp.jobId);
  if (failure) {
    await deps.store.deleteOtp(device.deviceId);
    throw new ApiError(409, "OTP_SEND_FAILED", failure);
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    await deps.store.deleteOtp(device.deviceId);
    throw new ApiError(429, "OTP_LOCKED", "Too many wrong tries. Request a new code.");
  }
  const a = Buffer.from(h(pepper, `otp-code:${phone}`, code), "hex");
  const b = Buffer.from(otp.codeHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await deps.store.saveOtp(device.deviceId, { ...otp, attempts: otp.attempts + 1 });
    throw new ApiError(400, "OTP_INVALID", `That code is not correct. ${MAX_ATTEMPTS - otp.attempts - 1} tries left.`);
  }
  await deps.store.deleteOtp(device.deviceId); // single use
  return { status: 200, body: { verified: true } };
}

const FAILED = new Set(["failed", "expired", "cancelled"]);

async function sendFailure(deps: ManagementDeps, jobId: string | undefined): Promise<string | null> {
  if (!jobId) return null;
  const job = await deps.store.getJob(jobId);
  if (!job || !FAILED.has(job.status)) return null;
  return job.status === "expired"
    ? "The SMS was not sent in time (the connector was not running). Start the connector and request a new code."
    : "The SMS could not be sent, so this code is not valid. Request a new code.";
}

/** Lets the app show what really happened to the SMS: sending, sent, or failed (with the phone's error code). */
export async function otpStatus(input: RouteInput, deps: ManagementDeps): Promise<HttpResult> {
  const now = nowOf(deps);
  const { device } = await authenticateDevice(input.authorization, deps.store, deps.config, now);
  const otp = await deps.store.getOtp(device.deviceId);
  if (!otp?.jobId) return { status: 200, body: { state: "none" } };
  const job = await deps.store.getJob(otp.jobId);
  if (!job || job.ownerUid !== device.ownerUid) return { status: 200, body: { state: "none" } };
  const state = FAILED.has(job.status) ? "failed" : ["sent", "delivery_pending", "delivered"].includes(job.status) ? "sent" : "sending";
  return { status: 200, body: { state, status: job.status, errorCode: job.errorCode ?? null } };
}
