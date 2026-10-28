export type RouteId =
  | "health"
  | "keys.create" | "keys.list" | "keys.revoke" | "keys.delete"
  | "devices.list" | "devices.challenge" | "devices.register" | "devices.revoke" | "devices.delete"
  | "connector.heartbeat" | "connector.claim" | "connector.fetch" | "connector.result"
  | "connector.register" | "connector.otp.send" | "connector.otp.verify" | "connector.otp.status" | "otp.send" | "otp.verify" | "otp.status"
  | "config" | "dashboard" | "requests.list" | "requests.get" | "requests.delete"
  | "dashboard.send" | "connector.send"
  | "admin.overview" | "admin.platform" | "admin.users" | "admin.user" | "admin.user.update"
  | "admin.key.revoke" | "admin.device.revoke" | "admin.key.delete" | "admin.device.delete" | "admin.audit"
  | "sms.send" | "sms.status";

type Method = "GET" | "POST" | "DELETE";

/** Single source of truth for the public API surface. `:name` segments become params. */
export const ROUTES: readonly { method: Method; path: string; id: RouteId }[] = [
  { method: "GET", path: "/health", id: "health" },
  { method: "POST", path: "/keys", id: "keys.create" },
  { method: "GET", path: "/keys", id: "keys.list" },
  { method: "DELETE", path: "/keys/:keyId", id: "keys.revoke" },
  { method: "POST", path: "/keys/:keyId/delete", id: "keys.delete" },
  { method: "GET", path: "/devices", id: "devices.list" },
  { method: "POST", path: "/devices/:deviceId/delete", id: "devices.delete" },
  { method: "POST", path: "/devices/challenge", id: "devices.challenge" },
  { method: "POST", path: "/devices/register", id: "devices.register" },
  { method: "POST", path: "/devices/:deviceId/revoke", id: "devices.revoke" },
  { method: "POST", path: "/connector/heartbeat", id: "connector.heartbeat" },
  { method: "POST", path: "/connector/jobs/claim", id: "connector.claim" },
  { method: "GET", path: "/connector/jobs/:id", id: "connector.fetch" },
  { method: "POST", path: "/connector/jobs/:id/result", id: "connector.result" },
  { method: "POST", path: "/connector/register", id: "connector.register" },
  { method: "POST", path: "/connector/otp/send", id: "connector.otp.send" },
  { method: "POST", path: "/connector/otp/verify", id: "connector.otp.verify" },
  { method: "GET", path: "/connector/otp/status", id: "connector.otp.status" },
  { method: "POST", path: "/otp/send", id: "otp.send" },
  { method: "POST", path: "/otp/verify", id: "otp.verify" },
  { method: "GET", path: "/otp/:otpId", id: "otp.status" },
  { method: "GET", path: "/config", id: "config" },
  { method: "GET", path: "/dashboard", id: "dashboard" },
  { method: "GET", path: "/sms/requests", id: "requests.list" },
  { method: "GET", path: "/sms/requests/:id", id: "requests.get" },
  { method: "POST", path: "/sms/requests/:id/delete", id: "requests.delete" },
  { method: "POST", path: "/dashboard/send", id: "dashboard.send" },
  { method: "POST", path: "/connector/send", id: "connector.send" },
  { method: "GET", path: "/admin/overview", id: "admin.overview" },
  { method: "POST", path: "/admin/platform", id: "admin.platform" },
  { method: "GET", path: "/admin/users", id: "admin.users" },
  { method: "GET", path: "/admin/users/:uid", id: "admin.user" },
  { method: "POST", path: "/admin/users/:uid", id: "admin.user.update" },
  { method: "POST", path: "/admin/users/:uid/keys/:keyId/revoke", id: "admin.key.revoke" },
  { method: "POST", path: "/admin/users/:uid/devices/:deviceId/revoke", id: "admin.device.revoke" },
  { method: "POST", path: "/admin/users/:uid/keys/:keyId/delete", id: "admin.key.delete" },
  { method: "POST", path: "/admin/users/:uid/devices/:deviceId/delete", id: "admin.device.delete" },
  { method: "GET", path: "/admin/audit", id: "admin.audit" },
  { method: "POST", path: "/sms/send", id: "sms.send" },
  { method: "GET", path: "/sms/status/:id", id: "sms.status" },
];

export type Match =
  | { kind: "ok"; id: RouteId; params: Record<string, string> }
  | { kind: "not_found" }
  | { kind: "method_not_allowed"; allow: string[] };

/** `rawUrl` is the request URL, e.g. "/api/v1/keys/abc?x=1". */
export function matchRoute(method: string, rawUrl: string): Match {
  const pathname = (rawUrl.split("?")[0] ?? "").replace(/^\/api\/v1/, "").replace(/\/+$/, "") || "/";
  const segs = pathname.split("/").filter(Boolean);
  const allow = new Set<string>();

  for (const r of ROUTES) {
    const pat = r.path.split("/").filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    const fits = pat.every((p, i) => {
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(segs[i]!);
        return true;
      }
      return p === segs[i];
    });
    if (!fits) continue;
    if (r.method === method) return { kind: "ok", id: r.id, params };
    allow.add(r.method);
  }
  return allow.size > 0 ? { kind: "method_not_allowed", allow: [...allow] } : { kind: "not_found" };
}

/**
 * Works out the public path (/api/v1/...) for a request. vercel.json rewrites /api/v1/* to the single
 * function and also passes the original path as `?__path=`, so routing keeps working whether or not
 * the platform preserves the original URL.
 */
export function resolveApiPath(rawUrl: string, queryPath: string | string[] | undefined): string {
  if (rawUrl.startsWith("/api/v1")) return rawUrl;
  const joined = Array.isArray(queryPath) ? queryPath.join("/") : (queryPath ?? "");
  return `/api/v1/${joined}`;
}
