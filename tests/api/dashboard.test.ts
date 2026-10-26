import { beforeEach, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../../backend/auth/userAuth";
import { loadConfig } from "../../backend/config";
import type { HttpResult } from "../../backend/errors";
import { toErrorResult } from "../../backend/errors";
import { MemoryManagementStore } from "../../backend/management/memoryManagementStore";
import { claim, heartbeat, registerWithConnectorKey, submitResult } from "../../backend/services/connector";
import { dashboard, deleteRequest, getRequest, listRequests, publicConfig } from "../../backend/services/dashboard";
import type { ManagementDeps, RouteInput } from "../../backend/services/deps";
import { createKey, revokeKey } from "../../backend/services/keys";
import { handleSend } from "../../backend/sms/sendService";

const ENV = {
  CWP_API_KEY_HASH_PEPPER: "test-api-pepper-0123456789",
  CWP_DEVICE_TOKEN_HASH_PEPPER: "test-device-pepper-0123456789",
  CWP_LIVE_SENDING_ENABLED: "true",
  FIREBASE_WEB_API_KEY: "web-key-public",
};
const verifier: TokenVerifier = {
  async verify(t) {
    const m = /^tok:([a-z0-9-]+)$/.exec(t);
    if (!m) throw new Error("bad");
    return { uid: m[1]!, email: `${m[1]}@example.com`, emailVerified: true };
  },
};
const clock = new Date("2026-10-17T06:00:00.000Z");
let w: { store: MemoryManagementStore; deps: ManagementDeps };
const user = (u: string) => `Bearer tok:${u}`;
const inp = (authorization: string | undefined, body: unknown = "", params: Record<string, string> = {}, query: Record<string, string> = {}): RouteInput => ({
  ...(authorization ? { authorization } : {}),
  rawBody: typeof body === "string" ? body : JSON.stringify(body),
  params,
  query,
});
const run = async (f: () => Promise<HttpResult>) => {
  try {
    return await f();
  } catch (e) {
    return toErrorResult(e, "r");
  }
};
const code = (r: HttpResult) => (r.body as { error: { code: string } }).error.code;
const reg = (auth: string | undefined, over: Record<string, unknown> = {}) =>
  run(() => registerWithConnectorKey(inp(auth, { nickname: "Pixel", appVersion: "1.0", installId: "install-0001", ...over }), w.deps));

async function mkKey(kind: "connector" | "api", uid = "alice") {
  const body = kind === "connector" ? { name: "phone", environment: "live", scopes: ["connector"] } : { name: "srv", environment: "live" };
  return (await createKey(inp(user(uid), body), w.deps)).body as { keyId: string; secret: string; kind: string };
}

const fresh = () => {
  const config = loadConfig({ ...ENV });
  const store = new MemoryManagementStore();
  w = { store, deps: { store, verifier, config, now: () => clock } };
};

describe("connector keys", () => {
  beforeEach(fresh);
  it("scope connector is exclusive and reported as kind", async () => {
    const bad = await run(() => createKey(inp(user("alice"), { name: "x", environment: "live", scopes: ["connector", "sms:send"] }), w.deps));
    expect(bad.status).toBe(400);
    expect((await mkKey("connector")).kind).toBe("connector");
    expect((await mkKey("api")).kind).toBe("api");
  });

  it("a connector key cannot send SMS", async () => {
    const k = await mkKey("connector");
    w.store.users.get("alice")!.liveSendingEnabled = true;
    const r = await handleSend(
      { authorization: `Bearer ${k.secret}`, idempotencyKey: "i1", contentType: "application/json", rawBody: JSON.stringify({ to: "+15551234567", message: "hi", mode: "demo" }) },
      { store: w.store, config: w.deps.config, now: () => clock },
      "r",
    );
    expect(r.status).toBe(403);
  });

  it("an SMS key cannot register a phone", async () => {
    const k = await mkKey("api");
    expect(code(await reg(`Bearer ${k.secret}`))).toBe("INSUFFICIENT_SCOPE");
  });

  it("registers with only the key, returns the credential once, and the phone works", async () => {
    const k = await mkKey("connector");
    const r = await reg(`Bearer ${k.secret}`);
    expect(r.status).toBe(201);
    const b = r.body as { deviceId: string; credential: string };
    expect(b.credential).toMatch(/^cwpd_/);
    expect(JSON.stringify(w.store.deviceMap.get(b.deviceId))).not.toContain(b.credential.split("_")[2]!);
    const hb = await heartbeat(inp(`Bearer ${b.credential}`, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps);
    expect(hb.status).toBe(200);
  });

  it("rejects missing, malformed and unknown keys uniformly", async () => {
    expect(code(await reg(undefined))).toBe("INVALID_API_KEY");
    expect(code(await reg("Bearer nope"))).toBe("INVALID_API_KEY");
    const k = await mkKey("connector");
    const forged = k.secret.slice(0, -4) + "0000";
    expect(code(await reg(`Bearer ${forged}`))).toBe("INVALID_API_KEY");
  });

  it("re-registering the same install replaces the old credential (reinstall is safe)", async () => {
    const k = await mkKey("connector");
    const a = (await reg(`Bearer ${k.secret}`)).body as { credential: string };
    const b = (await reg(`Bearer ${k.secret}`)).body as { credential: string };
    const hb = (c: string) => run(() => heartbeat(inp(`Bearer ${c}`, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps));
    expect(code(await hb(a.credential))).toBe("DEVICE_REVOKED");
    expect((await hb(b.credential)).status).toBe(200);
  });

  it("a different install is refused once the device limit is reached", async () => {
    const k = await mkKey("connector");
    await reg(`Bearer ${k.secret}`);
    expect(code(await reg(`Bearer ${k.secret}`, { installId: "install-0002" }))).toBe("DEVICE_LIMIT_REACHED");
  });

  it("revoking the connector key disables the registered phone immediately", async () => {
    const k = await mkKey("connector");
    const d = (await reg(`Bearer ${k.secret}`)).body as { credential: string };
    const auth = `Bearer ${d.credential}`;
    expect((await heartbeat(inp(auth, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps)).status).toBe(200);
    await revokeKey(inp(user("alice"), "", { keyId: k.keyId }), w.deps);
    expect(code(await run(() => claim(inp(auth), w.deps)))).toBe("CONNECTOR_KEY_INACTIVE");
    expect(code(await reg(`Bearer ${k.secret}`))).toBe("API_KEY_INACTIVE");
  });
});

describe("dashboard data", () => {
  beforeEach(fresh);
  it("public config exposes only the web key and needs no sign-in", async () => {
    const r = (await publicConfig(inp(undefined), w.deps)).body as Record<string, unknown>;
    expect(r.firebaseApiKey).toBe("web-key-public");
    expect(JSON.stringify(r)).not.toContain("pepper");
  });

  async function seed() {
    const conn = await mkKey("connector");
    const api = await mkKey("api");
    w.store.users.get("alice")!.liveSendingEnabled = true;
    const dev = (await reg(`Bearer ${conn.secret}`)).body as { credential: string };
    const auth = `Bearer ${dev.credential}`;
    await heartbeat(inp(auth, { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true }), w.deps);
    const send = (mode: "demo" | "live", i: string) =>
      handleSend(
        { authorization: `Bearer ${api.secret}`, idempotencyKey: i, contentType: "application/json", rawBody: JSON.stringify({ to: "+15551234567", message: "secret body text", mode }) },
        { store: w.store, config: w.deps.config, now: () => clock },
        "r",
      );
    const live1 = (await send("live", "a1")).body as { id: string };
    await send("live", "a2");
    await send("demo", "a3");
    return { auth, live1: live1.id };
  }

  it("counts pending, demo, quota, keys and devices, without leaking message bodies", async () => {
    await seed();
    const r = await dashboard(inp(user("alice")), w.deps);
    const b = r.body as any;
    expect(b.counts.pending).toBe(2);
    expect(b.counts.demo).toBe(1);
    expect(b.quota.usedUnits).toBe(2);
    expect(b.keys.apiKeys).toBe(1);
    expect(b.keys.connectorKeys).toBe(1);
    expect(b.devices.online).toBe(1);
    expect(b.account.liveSendingAllowed).toBe(true);
    const text = JSON.stringify(b);
    expect(text).not.toContain("secret body text");
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain("secretHash");
  });

  it("lists with a pending filter and rejects an unknown filter", async () => {
    await seed();
    const pend = (await listRequests(inp(user("alice"), "", {}, { status: "pending" }), w.deps)).body as { requests: unknown[] };
    expect(pend.requests).toHaveLength(2);
    const demo = (await listRequests(inp(user("alice"), "", {}, { status: "demo_completed" }), w.deps)).body as { requests: unknown[] };
    expect(demo.requests).toHaveLength(1);
    expect((await run(() => listRequests(inp(user("alice"), "", {}, { status: "bogus" }), w.deps))).status).toBe(400);
  });

  it("detail shows a timeline that follows the job, and hides other accounts' jobs", async () => {
    const { auth, live1 } = await seed();
    const c = (await claim(inp(auth), w.deps)).body as { job: { id: string; claimVersion: number } };
    await submitResult(inp(auth, { claimVersion: c.job.claimVersion, event: "sending" }, { id: c.job.id }), w.deps);
    const d = (await getRequest(inp(user("alice"), "", { id: c.job.id }), w.deps)).body as any;
    expect(d.request.status).toBe("sending");
    expect(d.timeline.map((e: any) => e.to)).toEqual(["assigned", "sending"]);
    expect(code(await run(() => getRequest(inp(user("bob"), "", { id: live1 }), w.deps)))).toBe("NOT_FOUND");
    expect(code(await run(() => getRequest(inp(user("alice"), "", { id: "nope" }), w.deps)))).toBe("NOT_FOUND");
  });

  it("deletes finished requests only, owner-only, with the timeline", async () => {
    const { live1 } = await seed();
    const list = (await listRequests(inp(user("alice")), w.deps)).body as any;
    const demo = list.requests.find((r: any) => r.mode === "demo");
    // a queued live request is in flight: refused
    expect(code(await run(() => deleteRequest(inp(user("alice"), "", { id: live1 }), w.deps)))).toBe("REQUEST_IN_PROGRESS");
    expect(code(await run(() => deleteRequest(inp(user("bob"), "", { id: demo.id }), w.deps)))).toBe("NOT_FOUND");
    expect((await deleteRequest(inp(user("alice"), "", { id: demo.id }), w.deps)).status).toBe(204);
    expect(code(await run(() => getRequest(inp(user("alice"), "", { id: demo.id }), w.deps)))).toBe("NOT_FOUND");
    expect(await w.store.listJobEvents(demo.id)).toHaveLength(0);
    expect(code(await run(() => deleteRequest(inp(user("alice"), "", { id: demo.id }), w.deps)))).toBe("NOT_FOUND");
  });

  it("requires sign-in", async () => {
    expect(code(await run(() => dashboard(inp(undefined), w.deps)))).toBe("INVALID_TOKEN");
  });
});
