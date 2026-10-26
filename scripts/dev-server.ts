// Local preview: serves public/ and the real API handlers on an in-memory store with a fake sign-in.
import { otpSend, otpVerify } from "../backend/services/otp.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { loadConfig } from "../backend/config.js";
import { deleteKey } from "../backend/services/keys.js";
import { deleteDevice } from "../backend/services/devices.js";
import { deleteRequest } from "../backend/services/dashboard.js";
import { adminDeleteKey, adminDeleteDevice } from "../backend/services/admin.js";
import { MemoryManagementStore } from "../backend/management/memoryManagementStore.js";
import { matchRoute, resolveApiPath } from "../backend/routes.js";
import { dashboard, getRequest, listRequests, publicConfig } from "../backend/services/dashboard.js";
import { createKey, listKeys, revokeKey } from "../backend/services/keys.js";
import { claim, heartbeat, registerWithConnectorKey } from "../backend/services/connector.js";
import { listDevices, revokeDevice } from "../backend/services/devices.js";
import { adminAudit, adminOverview, adminRevokeDevice, adminRevokeKey, adminUpdateUser, adminUserDetail, adminUsers, setPlatform } from "../backend/services/admin.js";
import { dashboardSend } from "../backend/services/dashboardSend.js";
import { handleSend } from "../backend/sms/sendService.js";
import { toErrorResult } from "../backend/errors.js";
import { readRawBody } from "../backend/http.js";

const config = loadConfig({ CWP_API_KEY_HASH_PEPPER: "dev-api-pepper-0123456789", CWP_DEVICE_TOKEN_HASH_PEPPER: "dev-dev-pepper-0123456789", CWP_LIVE_SENDING_ENABLED: "true", FIREBASE_WEB_API_KEY: "fake", CWP_ADMIN_EMAILS: "admin@example.com" });
const store = new MemoryManagementStore();
store.platformSettings.liveSendingEnabled = true; // preview only
const verifier = { async verify(t: string) { if (!t.startsWith("tok:")) throw new Error("x"); const uid = t.slice(4); return { uid, email: `${uid}@example.com`, emailVerified: true }; } };
const deps = { store, verifier, config };
const svc: Record<string, any> = { "keys.create": createKey, "keys.list": listKeys, "keys.revoke": revokeKey, "devices.list": listDevices, "devices.revoke": revokeDevice, dashboard, "requests.list": listRequests, "requests.get": getRequest, config: publicConfig, "connector.register": registerWithConnectorKey, "connector.heartbeat": heartbeat, "connector.claim": claim, "admin.overview": adminOverview, "admin.platform": setPlatform, "admin.users": adminUsers, "admin.user": adminUserDetail, "admin.user.update": adminUpdateUser, "admin.key.revoke": adminRevokeKey, "admin.device.revoke": adminRevokeDevice, "admin.audit": adminAudit, "keys.delete": deleteKey, "devices.delete": deleteDevice, "requests.delete": deleteRequest, "admin.key.delete": adminDeleteKey, "admin.device.delete": adminDeleteDevice, "connector.otp.verify": otpVerify };
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".zip": "application/zip" };

createServer(async (req, res) => {
  const url = req.url ?? "/";
  try {
    if (url.startsWith("/api/v1/identity/")) { // fake Firebase REST, used only by this preview
      res.setHeader("content-type", "application/json"); res.end("{}"); return;
    }
    if (url.startsWith("/api/v1")) {
      const m = matchRoute(req.method ?? "GET", resolveApiPath(url, undefined));
      if (m.kind !== "ok") { res.statusCode = 404; res.end("{}"); return; }
      const raw = req.method === "POST" ? await readRawBody(req, 16384) : "";
      const q = Object.fromEntries(new URL(url, "http://x").searchParams);
      let out;
      if (m.id === "health") out = { status: 200, body: { status: "ok" } };
      else if (m.id === "dashboard.send") out = await dashboardSend({ rawBody: raw, params: {}, authorization: req.headers.authorization }, deps, deps, "r");
      else if (m.id === "connector.otp.send") try { out = await otpSend({ rawBody: raw, params: {}, authorization: req.headers.authorization }, deps, deps, "r"); } catch (e) { out = toErrorResult(e, "r"); }
      else if (m.id === "sms.send") out = await handleSend({ rawBody: raw, authorization: req.headers.authorization, idempotencyKey: req.headers["idempotency-key"] as string, contentType: "application/json" }, deps, "r");
      else try { out = await svc[m.id]({ rawBody: raw, params: m.params, query: q, authorization: req.headers.authorization }, deps); } catch (e) { out = toErrorResult(e, "r"); }
      res.statusCode = out.status; res.setHeader("content-type", "application/json");
      res.end(out.body === undefined ? "" : JSON.stringify(out.body)); return;
    }
    const p0 = url.split("?")[0]!;
    const path = p0 === "/" ? "/index.html" : p0 === "/admin" ? "/admin.html" : p0;
    const buf = await readFile(join(process.cwd(), "public", path));
    res.setHeader("content-type", types[extname(path)] ?? "application/octet-stream"); res.end(buf);
  } catch { res.statusCode = 404; res.end("not found"); }
}).listen(4173, () => console.log("dev on 4173"));
