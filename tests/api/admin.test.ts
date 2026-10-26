import { beforeEach, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../../backend/auth/userAuth";
import { loadConfig } from "../../backend/config";
import { toErrorResult, type HttpResult } from "../../backend/errors";
import { MemoryManagementStore } from "../../backend/management/memoryManagementStore";
import { adminAudit, adminOverview, adminRevokeDevice, adminRevokeKey, adminUpdateUser, adminUserDetail, adminUsers, setPlatform } from "../../backend/services/admin";
import { claim, heartbeat, registerWithConnectorKey } from "../../backend/services/connector";
import { dashboard } from "../../backend/services/dashboard";
import { connectorSend, dashboardSend } from "../../backend/services/dashboardSend";
import type { ManagementDeps, RouteInput } from "../../backend/services/deps";
import { createKey } from "../../backend/services/keys";
import { handleSend } from "../../backend/sms/sendService";

const ENV = {
  CWP_API_KEY_HASH_PEPPER: "test-api-pepper-0123456789",
  CWP_DEVICE_TOKEN_HASH_PEPPER: "test-device-pepper-0123456789",
  CWP_LIVE_SENDING_ENABLED: "false",
  CWP_ADMIN_EMAILS: "Boss@Example.com, other@example.com",
};
// token "tok:<uid>:<email>"
const verifier: TokenVerifier = {
  async verify(t) {
    const m = /^tok:([a-z0-9]+):([^:]+)(:unverified)?$/.exec(t);
    if (!m) throw new Error("bad");
    return { uid: m[1]!, email: m[2]!, emailVerified: !m[3] };
  },
};
const clock = new Date("2026-10-22T06:00:00.000Z");
let w: { store: MemoryManagementStore; deps: ManagementDeps };
const tok = (uid: string, email = `${uid}@x.com`) => `Bearer tok:${uid}:${email}`;
const ADMIN = tok("boss", "boss@example.com");
const inp = (a: string | undefined, body: unknown = "", params: Record<string, string> = {}): RouteInput => ({
  ...(a ? { authorization: a } : {}), rawBody: typeof body === "string" ? body : JSON.stringify(body), params,
});
const run = async (f: () => Promise<HttpResult>) => { try { return await f(); } catch (e) { return toErrorResult(e, "r"); } };
const code = (r: HttpResult) => (r.body as { error: { code: string } }).error.code;
const fresh = () => {
  const config = loadConfig(ENV);
  const store = new MemoryManagementStore();
  w = { store, deps: { store, verifier, config, now: () => clock } };
  for (const uid of ["alice", "bob", "boss"]) void store.ensureUser({ uid, email: `${uid}@x.com`, emailVerified: true, now: clock });
};
const sdeps = () => ({ store: w.store, config: w.deps.config, now: () => clock });
const send = (a: string, over: Record<string, unknown> = {}) =>
  dashboardSend(inp(a, { to: "+919876543210", message: "hi", mode: "demo", idempotencyKey: "k-" + Math.random().toString(16).slice(2), ...over }), w.deps, sdeps(), "r");

describe("admin access", () => {
  beforeEach(fresh);
  it("only allow-listed, verified emails get in (case-insensitive); everyone else is refused", async () => {
    expect((await adminOverview(inp(ADMIN), w.deps)).status).toBe(200);
    expect(code(await run(() => adminOverview(inp(tok("alice")), w.deps)))).toBe("NOT_ADMIN");
    expect(code(await run(() => adminOverview(inp("Bearer tok:boss:boss@example.com:unverified"), w.deps)))).toBe("NOT_ADMIN");
    expect(code(await run(() => adminOverview(inp(undefined), w.deps)))).toBe("INVALID_TOKEN");
    expect(code(await run(() => adminOverview(inp("Bearer junk"), w.deps)))).toBe("INVALID_TOKEN");
    for (const f of [adminUsers, adminAudit]) expect(code(await run(() => f(inp(tok("alice")), w.deps)))).toBe("NOT_ADMIN");
    expect(code(await run(() => setPlatform(inp(tok("alice"), { liveSendingEnabled: true }), w.deps)))).toBe("NOT_ADMIN");
  });
  it("with no admin emails configured nobody is an admin", async () => {
    const config = loadConfig({ ...ENV, CWP_ADMIN_EMAILS: "" });
    expect(code(await run(() => adminOverview(inp(ADMIN), { ...w.deps, config })))).toBe("NOT_ADMIN");
  });
});

describe("platform live switch", () => {
  beforeEach(fresh);
  it("admin can turn live on and off; effective value follows, with an audit trail", async () => {
    const eff = async () => ((await adminOverview(inp(ADMIN), w.deps)).body as any).platform;
    expect((await eff()).effective).toBe(false);
    await setPlatform(inp(ADMIN, { liveSendingEnabled: true }), w.deps);
    expect(await eff()).toMatchObject({ envDefault: false, override: true, effective: true });
    await setPlatform(inp(ADMIN, { liveSendingEnabled: false }), w.deps);
    expect((await eff()).effective).toBe(false);
    await setPlatform(inp(ADMIN, { liveSendingEnabled: null }), w.deps);
    expect((await eff()).override).toBeNull();
    const log = ((await adminAudit(inp(ADMIN), w.deps)).body as any).entries;
    expect(log.map((e: any) => e.detail)).toEqual(["reset to environment default", "off", "on"]);
    expect(log[0].admin).toBe("boss@example.com");
  });

  it("the switch really gates sending, the heartbeat and the claim", async () => {
    await createKey(inp(tok("alice")), w.deps).catch(() => null);
    const conn = (await createKey(inp(tok("alice"), { name: "p", environment: "live", scopes: ["connector"] }), w.deps)).body as { secret: string };
    const dev = (await registerWithConnectorKey(inp(`Bearer ${conn.secret}`, { nickname: "P", appVersion: "1", installId: "install-0001" }), w.deps)).body as { credential: string };
    const dAuth = `Bearer ${dev.credential}`;
    const beat = () => heartbeat(inp(dAuth, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps);
    await updateLive("alice", true);
    expect(((await beat()).body as any).liveSendingAllowed).toBe(false); // platform off
    await setPlatform(inp(ADMIN, { liveSendingEnabled: true }), w.deps);
    expect(((await beat()).body as any).liveSendingAllowed).toBe(true);

    const r = await send(tok("alice"), { mode: "live" });
    expect(r.status).toBe(202);
    expect(((await claim(inp(dAuth), w.deps)).body as any).job).not.toBeNull();

    await setPlatform(inp(ADMIN, { liveSendingEnabled: false }), w.deps);
    expect(code(await send(tok("alice"), { mode: "live" }))).toBe("LIVE_SENDING_DISABLED");
    expect(((await claim(inp(dAuth), w.deps)).body as any).job).toBeNull();
  });
  async function updateLive(uid: string, on: boolean) {
    await adminUpdateUser(inp(ADMIN, { liveSendingEnabled: on }, { uid }), w.deps);
  }
});

describe("users, limits, revoking", () => {
  beforeEach(fresh);
  it("lists users with counts and shows a user's detail without secrets or message text", async () => {
    const k = (await createKey(inp(tok("alice"), { name: "srv", environment: "test" }), w.deps)).body as { keyId: string; secret: string };
    await send(tok("alice"));
    const list = (await adminUsers(inp(ADMIN), w.deps)).body as any;
    expect(list.users.find((u: any) => u.uid === "alice")).toMatchObject({ email: "alice@x.com", activeKeys: 1, status: "active" });
    const d = (await adminUserDetail(inp(ADMIN, "", { uid: "alice" }), w.deps)).body as any;
    expect(d.keys).toHaveLength(1);
    expect(d.recent).toHaveLength(1);
    const text = JSON.stringify(d);
    expect(text).not.toContain(k.secret.split("_")[3]!);
    expect(text).not.toContain("secretHash");
    expect(text).not.toContain("+919876543210");
    expect(code(await run(() => adminUserDetail(inp(ADMIN, "", { uid: "nobody-1" }), w.deps)))).toBe("NOT_FOUND");
  });

  it("limit overrides change what the user is allowed, and null restores the default", async () => {
    await adminUpdateUser(inp(ADMIN, { liveSendingEnabled: true }, { uid: "alice" }), w.deps);
    await adminUpdateUser(inp(ADMIN, { limits: { maxActiveKeys: 1 } }, { uid: "alice" }), w.deps);
    await createKey(inp(tok("alice"), { name: "a", environment: "test" }), w.deps);
    expect(code(await run(() => createKey(inp(tok("alice"), { name: "b", environment: "test" }), w.deps)))).toBe("KEY_LIMIT_REACHED");
    await adminUpdateUser(inp(ADMIN, { limits: { maxActiveKeys: null } }, { uid: "alice" }), w.deps);
    expect((await createKey(inp(tok("alice"), { name: "b", environment: "test" }), w.deps)).status).toBe(201);

    // rate limit override on the dashboard send path
    await adminUpdateUser(inp(ADMIN, { limits: { requestsPerMinute: 2 } }, { uid: "alice" }), w.deps);
    expect((await send(tok("alice"))).status).toBe(202);
    expect((await send(tok("alice"))).status).toBe(202);
    expect(code(await run(() => send(tok("alice"))))).toBe("RATE_LIMITED");
    const dash = (await dashboard(inp(tok("alice")), w.deps)).body as any;
    expect(dash.quota.requestsPerMinute).toBe(2);
  });

  it("rejects bad patches, empty patches, and self-suspension", async () => {
    await send(tok("alice"));
    const bad = (b: unknown, uid = "alice") => run(() => adminUpdateUser(inp(ADMIN, b, { uid }), w.deps));
    expect((await bad({})).status).toBe(400);
    expect((await bad({ role: "admin" })).status).toBe(400);
    expect((await bad({ limits: { dailyUnits: -5 } })).status).toBe(400);
    expect((await bad({ limits: { dailyUnits: 1e9 } })).status).toBe(400);
    expect((await bad({ status: "suspended" }, "boss")).status).toBe(400);
    expect(code(await bad({ status: "suspended" }, "ghost-1"))).toBe("NOT_FOUND");
  });

  it("suspending a user shuts off their dashboard, API keys and phone at once", async () => {
    const api = (await createKey(inp(tok("alice"), { name: "s", environment: "test" }), w.deps)).body as { secret: string };
    const conn = (await createKey(inp(tok("alice"), { name: "p", environment: "live", scopes: ["connector"] }), w.deps)).body as { secret: string };
    const dev = (await registerWithConnectorKey(inp(`Bearer ${conn.secret}`, { nickname: "P", appVersion: "1", installId: "install-0001" }), w.deps)).body as { credential: string };
    const sendApi = () => handleSend({ authorization: `Bearer ${api.secret}`, idempotencyKey: "i" + Math.random(), contentType: "application/json", rawBody: JSON.stringify({ to: "+919876543210", message: "x", mode: "demo" }) }, sdeps(), "r");
    expect((await sendApi()).status).toBe(202);
    await adminUpdateUser(inp(ADMIN, { status: "suspended" }, { uid: "alice" }), w.deps);
    expect((await sendApi()).status).toBe(403);
    expect(code(await run(() => dashboard(inp(tok("alice")), w.deps)))).toBe("ACCOUNT_SUSPENDED");
    expect(code(await run(() => claim(inp(`Bearer ${dev.credential}`), w.deps)))).toBe("ACCOUNT_SUSPENDED");
  });

  it("admin can revoke a user's key and device; foreign ids look missing", async () => {
    const api = (await createKey(inp(tok("alice"), { name: "s", environment: "test" }), w.deps)).body as { keyId: string; secret: string };
    const conn = (await createKey(inp(tok("alice"), { name: "p", environment: "live", scopes: ["connector"] }), w.deps)).body as { secret: string };
    const dev = (await registerWithConnectorKey(inp(`Bearer ${conn.secret}`, { nickname: "P", appVersion: "1", installId: "install-0001" }), w.deps)).body as { deviceId: string; credential: string };
    await send(tok("bob"));
    expect(code(await run(() => adminRevokeKey(inp(ADMIN, "", { uid: "bob", keyId: api.keyId }), w.deps)))).toBe("NOT_FOUND");
    expect((await adminRevokeKey(inp(ADMIN, "", { uid: "alice", keyId: api.keyId }), w.deps)).status).toBe(200);
    expect((await adminRevokeDevice(inp(ADMIN, "", { uid: "alice", deviceId: dev.deviceId }), w.deps)).status).toBe(200);
    expect(code(await run(() => claim(inp(`Bearer ${dev.credential}`), w.deps)))).toBe("DEVICE_REVOKED");
    const log = ((await adminAudit(inp(ADMIN), w.deps)).body as any).entries.map((e: any) => e.action);
    expect(log).toEqual(["device.revoke", "key.revoke"]);
  });
});

describe("dashboard send", () => {
  beforeEach(fresh);
  it("demo works for a signed-in user; needs a key-less sign-in only", async () => {
    const r = await send(tok("alice"));
    expect(r.status).toBe(202);
    expect((r.body as any).mode).toBe("demo");
    expect((await send("Bearer junk")).status).toBe(401);
  });
  it("is idempotent per user, validates input, and cannot use another user's idempotency key", async () => {
    const body = { to: "+919876543210", message: "hi", mode: "demo", idempotencyKey: "same-1" };
    const a = await dashboardSend(inp(tok("alice"), body), w.deps, sdeps(), "r");
    const b = await dashboardSend(inp(tok("alice"), body), w.deps, sdeps(), "r");
    expect((b.body as any).id).toBe((a.body as any).id);
    const c = await dashboardSend(inp(tok("bob"), body), w.deps, sdeps(), "r");
    expect((c.body as any).id).not.toBe((a.body as any).id);
    expect((await send(tok("alice"), { to: "9876543210" })).status).toBe(400);
    expect((await send(tok("alice"), { extra: 1 })).status).toBe(400);
    expect((await send(tok("alice"), { idempotencyKey: "bad key!" })).status).toBe(400);
  });
  it("live is refused until the platform and the account are both on, and needs an online phone", async () => {
    expect(code(await send(tok("alice"), { mode: "live" }))).toBe("LIVE_SENDING_DISABLED");
    await setPlatform(inp(ADMIN, { liveSendingEnabled: true }), w.deps);
    await send(tok("alice")); // creates the account
    expect(code(await send(tok("alice"), { mode: "live" }))).toBe("LIVE_SENDING_DISABLED");
    await adminUpdateUser(inp(ADMIN, { liveSendingEnabled: true }, { uid: "alice" }), w.deps);
    expect(code(await send(tok("alice"), { mode: "live" }))).toBe("NO_ELIGIBLE_DEVICE");
  });
});

describe("send from the Android app (device credential)", () => {
  beforeEach(fresh);
  async function pair() {
    const conn = (await createKey(inp(tok("alice"), { name: "p", environment: "live", scopes: ["connector"] }), w.deps)).body as { secret: string };
    const dev = (await registerWithConnectorKey(inp(`Bearer ${conn.secret}`, { nickname: "P", appVersion: "1", installId: "install-0001" }), w.deps)).body as { credential: string };
    return `Bearer ${dev.credential}`;
  }
  const dsend = (a: string, over: Record<string, unknown> = {}) =>
    connectorSend(inp(a, { to: "+919876543210", message: "hi", mode: "demo", idempotencyKey: "k-" + Math.random().toString(16).slice(2), ...over }), w.deps, sdeps(), "r");

  it("works with a device credential, not with a connector key or a bad credential", async () => {
    const dev = await pair();
    const r = await dsend(dev);
    expect(r.status).toBe(202);
    expect((await dsend("Bearer cwpd_" + "0".repeat(16) + "_" + "0".repeat(64))).status).toBe(401);
    expect((await dsend("Bearer junk")).status).toBe(401);
    const conn = (await createKey(inp(tok("alice"), { name: "p2", environment: "live", scopes: ["connector"] }), w.deps)).body as { secret: string };
    expect((await dsend(`Bearer ${conn.secret}`)).status).toBe(401);
  });
  it("the request belongs to the phone's owner and obeys the live switches", async () => {
    const dev = await pair();
    const r = (await dsend(dev)).body as { id: string };
    const detail = (await adminUserDetail(inp(ADMIN, "", { uid: "alice" }), w.deps)).body as any;
    expect(detail.recent[0].id).toBe(r.id);
    expect(code(await dsend(dev, { mode: "live" }))).toBe("LIVE_SENDING_DISABLED");
    await setPlatform(inp(ADMIN, { liveSendingEnabled: true }), w.deps);
    await adminUpdateUser(inp(ADMIN, { liveSendingEnabled: true }, { uid: "alice" }), w.deps);
    expect(code(await dsend(dev, { mode: "live" }))).toBe("NO_ELIGIBLE_DEVICE");
    await heartbeat(inp(dev, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps);
    const live = await dsend(dev, { mode: "live" });
    expect(live.status).toBe(202);
    expect(((await claim(inp(dev), w.deps)).body as any).job).not.toBeNull();
  });
  it("a removed phone or suspended account cannot send", async () => {
    const dev = await pair();
    await adminUpdateUser(inp(ADMIN, { status: "suspended" }, { uid: "alice" }), w.deps);
    expect((await dsend(dev)).status).toBe(403);
  });
});
