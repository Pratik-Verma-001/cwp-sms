import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ApiError, toErrorResult, type HttpResult } from "./errors.js";
import { header, newRequestId, readRawBody, sendResult } from "./http.js";
import { matchRoute, resolveApiPath, type RouteId } from "./routes.js";
import { getDeps, getManagementDeps } from "./runtime.js";
import { adminAudit, adminDeleteDevice, adminDeleteKey, adminOverview, adminRevokeDevice, adminRevokeKey, adminUpdateUser, adminUserDetail, adminUsers, setPlatform } from "./services/admin.js";
import { otpSend, otpStatus, otpVerify } from "./services/otp.js";
import { connectorSend, dashboardSend } from "./services/dashboardSend.js";
import { dashboard, deleteRequest, getRequest, listRequests, publicConfig } from "./services/dashboard.js";
import { claim, fetchJob, heartbeat, registerWithConnectorKey, submitResult } from "./services/connector.js";
import type { ManagementDeps, RouteInput } from "./services/deps.js";
import { deleteDevice, issueChallenge, listDevices, registerDevice, revokeDevice } from "./services/devices.js";
import { createKey, deleteKey, listKeys, revokeKey } from "./services/keys.js";
import { handleSend } from "./sms/sendService.js";
import { handleStatus } from "./sms/statusService.js";

type Service = (input: RouteInput, deps: ManagementDeps) => Promise<HttpResult>;

const MANAGEMENT: Partial<Record<RouteId, Service>> = {
  "keys.create": createKey,
  "keys.list": listKeys,
  "keys.revoke": revokeKey,
  "keys.delete": deleteKey,
  "devices.list": listDevices,
  "devices.challenge": issueChallenge,
  "devices.register": registerDevice,
  "devices.revoke": revokeDevice,
  "devices.delete": deleteDevice,
  "connector.register": registerWithConnectorKey,
  "connector.otp.verify": otpVerify,
  "connector.otp.status": otpStatus,
  config: publicConfig,
  "admin.overview": adminOverview,
  "admin.platform": setPlatform,
  "admin.users": adminUsers,
  "admin.user": adminUserDetail,
  "admin.user.update": adminUpdateUser,
  "admin.key.revoke": adminRevokeKey,
  "admin.device.revoke": adminRevokeDevice,
  "admin.key.delete": adminDeleteKey,
  "admin.device.delete": adminDeleteDevice,
  "admin.audit": adminAudit,
  dashboard,
  "requests.list": listRequests,
  "requests.get": getRequest,
  "requests.delete": deleteRequest,
  "connector.heartbeat": heartbeat,
  "connector.claim": claim,
  "connector.fetch": fetchJob,
  "connector.result": submitResult,
};

/**
 * One serverless function serves the whole API (Vercel Hobby allows at most 12 functions).
 * The route table in routes.ts decides what each path does.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const requestId = newRequestId();
  try {
    const m = matchRoute(req.method ?? "GET", resolveApiPath(req.url ?? "/", req.query?.__path));
    if (m.kind === "not_found") throw new ApiError(404, "NOT_FOUND", "Unknown endpoint.");
    if (m.kind === "method_not_allowed") {
      res.setHeader("Allow", m.allow.join(", "));
      throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${m.allow.join(" or ")}.`);
    }

    if (m.id === "health") {
      sendResult(res, { status: 200, body: { status: "ok", service: "cwp-sms", apiVersion: "v1" } }, requestId);
      return;
    }

    const authorization = header(req, "authorization");
    const auth = authorization ? { authorization } : {};

    if (m.id === "sms.send") {
      const deps = getDeps();
      const rawBody = await readRawBody(req, deps.config.maxRequestBodyBytes);
      const idempotencyKey = header(req, "idempotency-key");
      const contentType = header(req, "content-type");
      sendResult(
        res,
        await handleSend(
          { rawBody, ...auth, ...(idempotencyKey ? { idempotencyKey } : {}), ...(contentType ? { contentType } : {}) },
          deps,
          requestId,
        ),
        requestId,
      );
      return;
    }

    if (m.id === "dashboard.send") {
      const mdeps = getManagementDeps();
      const rawBody = await readRawBody(req, mdeps.config.maxRequestBodyBytes);
      sendResult(res, await dashboardSend({ rawBody, params: {}, ...auth }, mdeps, getDeps(), requestId), requestId);
      return;
    }

    if (m.id === "connector.send") {
      const mdeps = getManagementDeps();
      const rawBody = await readRawBody(req, mdeps.config.maxRequestBodyBytes);
      sendResult(res, await connectorSend({ rawBody, params: {}, ...auth }, mdeps, getDeps(), requestId), requestId);
      return;
    }

    if (m.id === "connector.otp.send") {
      const mdeps = getManagementDeps();
      const rawBody = await readRawBody(req, mdeps.config.maxRequestBodyBytes);
      sendResult(res, await otpSend({ rawBody, params: {}, ...auth }, mdeps, getDeps(), requestId), requestId);
      return;
    }

    if (m.id === "sms.status") {
      sendResult(res, await handleStatus({ jobId: m.params.id ?? "", ...auth }, getDeps(), requestId), requestId);
      return;
    }

    const service = MANAGEMENT[m.id]!;
    const deps = getManagementDeps();
    const rawBody = req.method === "POST" ? await readRawBody(req, deps.config.maxRequestBodyBytes) : "";
    const query = Object.fromEntries(new URL(req.url ?? "/", "http://x").searchParams.entries());
    delete query.__path;
    sendResult(res, await service({ rawBody, params: m.params, query, ...auth }, deps), requestId);
  } catch (err) {
    // Log only the error name and request ID: never bodies, headers, or credentials.
    // `code` is a Firestore/gRPC code such as 9 (missing index), never user data.
    const code = (err as { code?: unknown } | null)?.code;
    console.error("api failure", {
      requestId,
      name: err instanceof Error ? err.name : "unknown",
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    });
    sendResult(res, toErrorResult(err, requestId), requestId);
  }
}
