import { describe, expect, it } from "vitest";
import { matchRoute, resolveApiPath, ROUTES } from "../../backend/routes";

describe("route table", () => {
  it("matches every documented endpoint with its params", () => {
    const cases: [string, string, string, Record<string, string>][] = [
      ["GET", "/api/v1/health", "health", {}],
      ["POST", "/api/v1/keys", "keys.create", {}],
      ["GET", "/api/v1/keys", "keys.list", {}],
      ["DELETE", "/api/v1/keys/0123456789abcdef", "keys.revoke", { keyId: "0123456789abcdef" }],
      ["GET", "/api/v1/devices", "devices.list", {}],
      ["POST", "/api/v1/devices/challenge", "devices.challenge", {}],
      ["POST", "/api/v1/devices/register", "devices.register", {}],
      ["POST", "/api/v1/devices/abc123/revoke", "devices.revoke", { deviceId: "abc123" }],
      ["POST", "/api/v1/connector/heartbeat", "connector.heartbeat", {}],
      ["POST", "/api/v1/connector/jobs/claim", "connector.claim", {}],
      ["GET", "/api/v1/connector/jobs/smsreq_1", "connector.fetch", { id: "smsreq_1" }],
      ["POST", "/api/v1/connector/jobs/smsreq_1/result", "connector.result", { id: "smsreq_1" }],
      ["POST", "/api/v1/connector/register", "connector.register", {}],
      ["GET", "/api/v1/config", "config", {}],
      ["GET", "/api/v1/dashboard", "dashboard", {}],
      ["GET", "/api/v1/sms/requests?status=pending", "requests.list", {}],
      ["GET", "/api/v1/sms/requests/smsreq_5", "requests.get", { id: "smsreq_5" }],
      ["POST", "/api/v1/dashboard/send", "dashboard.send", {}],
      ["POST", "/api/v1/connector/send", "connector.send", {}],
      ["POST", "/api/v1/connector/otp/send", "connector.otp.send", {}],
      ["POST", "/api/v1/connector/otp/verify", "connector.otp.verify", {}],
      ["GET", "/api/v1/connector/otp/status", "connector.otp.status", {}],
      ["GET", "/api/v1/admin/overview", "admin.overview", {}],
      ["POST", "/api/v1/admin/platform", "admin.platform", {}],
      ["GET", "/api/v1/admin/users", "admin.users", {}],
      ["GET", "/api/v1/admin/users/u1", "admin.user", { uid: "u1" }],
      ["POST", "/api/v1/admin/users/u1", "admin.user.update", { uid: "u1" }],
      ["POST", "/api/v1/admin/users/u1/keys/k1/revoke", "admin.key.revoke", { uid: "u1", keyId: "k1" }],
      ["POST", "/api/v1/admin/users/u1/devices/d1/revoke", "admin.device.revoke", { uid: "u1", deviceId: "d1" }],
      ["POST", "/api/v1/admin/users/u1/keys/k1/delete", "admin.key.delete", { uid: "u1", keyId: "k1" }],
      ["POST", "/api/v1/admin/users/u1/devices/d1/delete", "admin.device.delete", { uid: "u1", deviceId: "d1" }],
      ["POST", "/api/v1/keys/k1/delete", "keys.delete", { keyId: "k1" }],
      ["POST", "/api/v1/devices/d1/delete", "devices.delete", { deviceId: "d1" }],
      ["POST", "/api/v1/sms/requests/r1/delete", "requests.delete", { id: "r1" }],
      ["GET", "/api/v1/admin/audit", "admin.audit", {}],
      ["POST", "/api/v1/sms/send", "sms.send", {}],
      ["GET", "/api/v1/sms/status/smsreq_9", "sms.status", { id: "smsreq_9" }],
    ];
    expect(cases.length).toBe(ROUTES.length);
    for (const [method, url, id, params] of cases) {
      const m = matchRoute(method, url);
      expect(m.kind).toBe("ok");
      if (m.kind === "ok") {
        expect(m.id).toBe(id);
        expect(m.params).toEqual(params);
      }
    }
  });

  it("ignores query strings and trailing slashes", () => {
    expect(matchRoute("GET", "/api/v1/keys/?page=2").kind).toBe("ok");
  });

  it("claim is not mistaken for a job id, and the right method wins", () => {
    const claim = matchRoute("POST", "/api/v1/connector/jobs/claim");
    expect(claim.kind === "ok" && claim.id).toBe("connector.claim");
    expect(matchRoute("GET", "/api/v1/connector/jobs/claim").kind === "ok" && "fetch").toBe("fetch");
  });

  it("returns 404 for unknown paths and 405 with the allowed methods otherwise", () => {
    expect(matchRoute("GET", "/api/v1/nope").kind).toBe("not_found");
    expect(matchRoute("GET", "/api/v1/sms/send/extra").kind).toBe("not_found");
    const m = matchRoute("GET", "/api/v1/sms/send");
    expect(m.kind).toBe("method_not_allowed");
    if (m.kind === "method_not_allowed") expect(m.allow).toEqual(["POST"]);
    const k = matchRoute("PUT", "/api/v1/keys");
    expect(k.kind === "method_not_allowed" && k.allow.sort().join(",")).toBe("GET,POST");
  });

  it("rebuilds the public path when the platform hides the original URL", () => {
    expect(resolveApiPath("/api/v1/sms/send", undefined)).toBe("/api/v1/sms/send");
    expect(resolveApiPath("/api?__path=sms%2Fsend", "sms/send")).toBe("/api/v1/sms/send");
    expect(resolveApiPath("/api", ["connector", "jobs", "claim"])).toBe("/api/v1/connector/jobs/claim");
    expect(resolveApiPath("/api", undefined)).toBe("/api/v1/");
    const m = matchRoute("POST", resolveApiPath("/api", "sms/send"));
    expect(m.kind === "ok" && m.id).toBe("sms.send");
  });
});
