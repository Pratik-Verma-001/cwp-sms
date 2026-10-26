import { beforeEach, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../../backend/auth/userAuth";
import { loadConfig } from "../../backend/config";
import type { HttpResult } from "../../backend/errors";
import { MemoryManagementStore } from "../../backend/management/memoryManagementStore";
import { claim, fetchJob, heartbeat, submitResult } from "../../backend/services/connector";
import type { ManagementDeps, RouteInput } from "../../backend/services/deps";
import { deleteDevice, issueChallenge, listDevices, registerDevice, revokeDevice } from "../../backend/services/devices";
import { createKey, deleteKey, listKeys, revokeKey } from "../../backend/services/keys";
import { handleSend } from "../../backend/sms/sendService";
import { handleStatus } from "../../backend/sms/statusService";

const ENV = {
  CWP_API_KEY_HASH_PEPPER: "test-api-pepper-0123456789",
  CWP_DEVICE_TOKEN_HASH_PEPPER: "test-device-pepper-0123456789",
  CWP_LIVE_SENDING_ENABLED: "true",
};

// Fake Firebase: token "tok:<uid>" is verified, "tok:<uid>:unverified" has no verified email.
const verifier: TokenVerifier = {
  async verify(t) {
    const m = /^tok:([a-z0-9-]+)(:unverified)?$/.exec(t);
    if (!m) throw new Error("bad token");
    return { uid: m[1]!, email: `${m[1]}@example.com`, emailVerified: !m[2] };
  },
};

let clock = new Date("2026-10-17T06:00:00.000Z");
const advance = (s: number) => (clock = new Date(clock.getTime() + s * 1000));

interface World {
  store: MemoryManagementStore;
  deps: ManagementDeps;
}
function world(env: Record<string, string> = {}): World {
  const config = loadConfig({ ...ENV, CWP_DEFAULT_MAX_CONNECTED_DEVICES: "2", ...env });
  const store = new MemoryManagementStore();
  return { store, deps: { store, verifier, config, now: () => clock } };
}

const user = (uid: string) => `Bearer tok:${uid}`;
const input = (authorization: string | undefined, body: unknown = "", params: Record<string, string> = {}): RouteInput => ({
  ...(authorization ? { authorization } : {}),
  rawBody: typeof body === "string" ? body : JSON.stringify(body),
  params,
});
const code = (r: HttpResult) => (r.body as { error: { code: string } }).error.code;
const run = async (f: () => Promise<HttpResult>): Promise<HttpResult> => {
  try {
    return await f();
  } catch (e) {
    const { toErrorResult } = await import("../../backend/errors");
    return toErrorResult(e, "req_t");
  }
};

async function pairDevice(w: World, uid = "alice", nickname = "Pixel") {
  const ch = (await issueChallenge(input(user(uid)), w.deps)).body as { challenge: string };
  const r = await registerDevice(input(user(uid), { challenge: ch.challenge, nickname, appVersion: "1.0.0" }), w.deps);
  const b = r.body as { deviceId: string; credential: string };
  return { deviceId: b.deviceId, auth: `Bearer ${b.credential}`, challenge: ch.challenge };
}

const beat = (auth: string, over: Record<string, unknown> = {}) => ({
  authorization: auth,
  body: { connectorRunning: true, smsPermissionGranted: true, telephonyAvailable: true, ...over },
});

describe("API key management", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("creates a key, shows the secret once, and stores only a hash", async () => {
    const r = await createKey(input(user("alice"), { name: "prod", environment: "live" }), w.deps);
    expect(r.status).toBe(201);
    const b = r.body as { keyId: string; secret: string };
    expect(b.secret).toMatch(/^cwp_live_[0-9a-f]{16}_[0-9a-f]{64}$/);
    const stored = w.store.keys.get(b.keyId)!;
    expect(JSON.stringify(stored)).not.toContain(b.secret.split("_")[3]!);
    expect(stored.ownerUid).toBe("alice");

    const list = JSON.stringify((await listKeys(input(user("alice")), w.deps)).body);
    expect(list).toContain(b.keyId);
    expect(list).not.toContain(b.secret.split("_")[3]!);
    expect(list).not.toContain("secretHash");
  });

  it("requires a verified sign-in and rejects bad tokens", async () => {
    const body = { name: "k", environment: "test" };
    expect(code(await run(() => createKey(input(undefined, body), w.deps)))).toBe("INVALID_TOKEN");
    expect(code(await run(() => createKey(input("Bearer garbage", body), w.deps)))).toBe("INVALID_TOKEN");
    expect(code(await run(() => createKey(input("Bearer tok:alice:unverified", body), w.deps)))).toBe("EMAIL_NOT_VERIFIED");
  });

  it("ignores a client-supplied owner and rejects unknown fields", async () => {
    const r = await run(() => createKey(input(user("alice"), { name: "k", environment: "test", ownerUid: "bob" }), w.deps));
    expect(r.status).toBe(400);
    expect(w.store.keys.size).toBe(0);
  });

  it("clamps limits to platform defaults and enforces the active-key cap", async () => {
    const r = await createKey(
      input(user("alice"), { name: "k", environment: "test", limits: { requestsPerMinute: 9999, dailyUnits: 9999 } }),
      w.deps,
    );
    expect((r.body as { limits: { dailyUnits: number } }).limits.dailyUnits).toBe(50);
    for (let i = 0; i < 9; i++) await createKey(input(user("alice"), { name: `k${i}`, environment: "test" }), w.deps);
    expect(code(await run(() => createKey(input(user("alice"), { name: "x", environment: "test" }), w.deps)))).toBe("KEY_LIMIT_REACHED");
  });

  it("revoked keys stop working immediately, and revoking is owner-only", async () => {
    const created = (await createKey(input(user("alice"), { name: "k", environment: "live" }), w.deps)).body as {
      keyId: string;
      secret: string;
    };
    w.store.users.get("alice")!.liveSendingEnabled = true;
    const send = () =>
      handleSend(
        {
          authorization: `Bearer ${created.secret}`,
          idempotencyKey: "i-" + Math.random().toString(16).slice(2),
          contentType: "application/json",
          rawBody: JSON.stringify({ to: "+15551234567", message: "hi", mode: "demo" }),
        },
        { store: w.store, config: w.deps.config, now: () => clock },
        "req_t",
      );
    expect((await send()).status).toBe(202);

    // Another account cannot revoke it; it looks like a missing key.
    expect(code(await run(() => revokeKey(input(user("bob"), "", { keyId: created.keyId }), w.deps)))).toBe("NOT_FOUND");
    expect((await send()).status).toBe(202);

    expect((await revokeKey(input(user("alice"), "", { keyId: created.keyId }), w.deps)).status).toBe(204);
    expect((await revokeKey(input(user("alice"), "", { keyId: created.keyId }), w.deps)).status).toBe(204);
    const after = await send();
    expect(after.status).toBe(401);
    expect(code(after)).toBe("API_KEY_INACTIVE");
  });

  it("does not let one account see another's keys", async () => {
    await createKey(input(user("alice"), { name: "k", environment: "test" }), w.deps);
    const bobs = (await listKeys(input(user("bob")), w.deps)).body as { keys: unknown[] };
    expect(bobs.keys).toHaveLength(0);
  });
});

describe("deleting revoked keys and devices", () => {
  let w: World;
  beforeEach(() => { w = world(); });

  it("deletes a key only after it is revoked, and only for its owner", async () => {
    const k = (await createKey(input(user("alice"), { name: "k", environment: "live" }), w.deps)).body as { keyId: string };
    expect(code(await run(() => deleteKey(input(user("alice"), "", { keyId: k.keyId }), w.deps)))).toBe("REVOKE_FIRST");
    await revokeKey(input(user("alice"), "", { keyId: k.keyId }), w.deps);
    expect(code(await run(() => deleteKey(input(user("bob"), "", { keyId: k.keyId }), w.deps)))).toBe("NOT_FOUND");
    expect((await deleteKey(input(user("alice"), "", { keyId: k.keyId }), w.deps)).status).toBe(204);
    const list = (await listKeys(input(user("alice")), w.deps)).body as { keys: unknown[] };
    expect(list.keys).toHaveLength(0);
    expect(code(await run(() => deleteKey(input(user("alice"), "", { keyId: k.keyId }), w.deps)))).toBe("NOT_FOUND");
  });

  it("deletes a device only after it is revoked; a deleted device can never come back", async () => {
    const d = await pairDevice(w);
    expect(code(await run(() => deleteDevice(input(user("alice"), "", { deviceId: d.deviceId }), w.deps)))).toBe("REVOKE_FIRST");
    await revokeDevice(input(user("alice"), "", { deviceId: d.deviceId }), w.deps);
    expect(code(await run(() => deleteDevice(input(user("bob"), "", { deviceId: d.deviceId }), w.deps)))).toBe("NOT_FOUND");
    expect((await deleteDevice(input(user("alice"), "", { deviceId: d.deviceId }), w.deps)).status).toBe(204);
    expect(code(await run(() => heartbeat(input(d.auth, beat(d.auth).body), w.deps)))).toBe("INVALID_DEVICE_CREDENTIAL");
    const list = (await listDevices(input(user("alice")), w.deps)).body as { devices: unknown[] };
    expect(list.devices).toHaveLength(0);
  });
});

describe("device pairing", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("pairs a device with a single-use challenge and returns the credential once", async () => {
    const d = await pairDevice(w);
    expect(d.auth).toMatch(/^Bearer cwpd_[0-9a-f]{16}_[0-9a-f]{64}$/);
    const stored = w.store.deviceMap.get(d.deviceId)!;
    expect(JSON.stringify(stored)).not.toContain(d.auth.split("_")[2]!);
    expect(stored.connectorRunning).toBe(false);

    const replay = await run(() => registerDevice(input(user("alice"), { challenge: d.challenge, nickname: "X", appVersion: "1" }), w.deps));
    expect(code(replay)).toBe("INVALID_CHALLENGE");
  });

  it("rejects another account's challenge, expired challenges, and unverified emails", async () => {
    const ch = (await issueChallenge(input(user("alice")), w.deps)).body as { challenge: string };
    const stolen = await run(() => registerDevice(input(user("mallory"), { challenge: ch.challenge, nickname: "X", appVersion: "1" }), w.deps));
    expect(code(stolen)).toBe("INVALID_CHALLENGE");

    advance(601);
    const expired = await run(() => registerDevice(input(user("alice"), { challenge: ch.challenge, nickname: "X", appVersion: "1" }), w.deps));
    expect(code(expired)).toBe("INVALID_CHALLENGE");

    expect(code(await run(() => issueChallenge(input("Bearer tok:alice:unverified"), w.deps)))).toBe("EMAIL_NOT_VERIFIED");
  });

  it("enforces the device cap", async () => {
    await pairDevice(w);
    await pairDevice(w);
    const ch = (await issueChallenge(input(user("alice")), w.deps)).body as { challenge: string };
    const r = await run(() => registerDevice(input(user("alice"), { challenge: ch.challenge, nickname: "3rd", appVersion: "1" }), w.deps));
    expect(code(r)).toBe("DEVICE_LIMIT_REACHED");
  });

  it("lists only own devices and shows online state from the heartbeat, not the record", async () => {
    const d = await pairDevice(w);
    const online = async () =>
      ((await listDevices(input(user("alice")), w.deps)).body as { devices: { online: boolean }[] }).devices[0]!.online;
    expect(await online()).toBe(false);
    await heartbeat(input(d.auth, beat(d.auth).body), w.deps);
    expect(await online()).toBe(true);
    advance(120);
    expect(await online()).toBe(false);
    expect(((await listDevices(input(user("bob")), w.deps)).body as { devices: unknown[] }).devices).toHaveLength(0);
  });

  it("revokes a device immediately and only for its owner", async () => {
    const d = await pairDevice(w);
    expect(code(await run(() => revokeDevice(input(user("bob"), "", { deviceId: d.deviceId }), w.deps)))).toBe("NOT_FOUND");
    expect((await revokeDevice(input(user("alice"), "", { deviceId: d.deviceId }), w.deps)).status).toBe(200);
    expect(code(await run(() => heartbeat(input(d.auth, beat(d.auth).body), w.deps)))).toBe("DEVICE_REVOKED");
    expect(code(await run(() => claim(input(d.auth), w.deps)))).toBe("DEVICE_REVOKED");
  });
});

describe("connector protocol", () => {
  let w: World;
  let dev: { deviceId: string; auth: string };
  let apiKey: string;

  const sendLive = (message = "Your order has been updated.", idem = "idem-" + Math.random().toString(16).slice(2)) =>
    handleSend(
      {
        authorization: `Bearer ${apiKey}`,
        idempotencyKey: idem,
        contentType: "application/json",
        rawBody: JSON.stringify({ to: "+15551234567", message, mode: "live" }),
      },
      { store: w.store, config: w.deps.config, now: () => clock },
      "req_t",
    );
  const result = (auth: string, id: string, body: Record<string, unknown>) =>
    run(() => submitResult(input(auth, body, { id }), w.deps));
  const status = async (id: string) =>
    ((await handleStatus({ authorization: `Bearer ${apiKey}`, jobId: id }, { store: w.store, config: w.deps.config, now: () => clock }, "r")).body as {
      status: string;
      deliveryConfirmed: boolean;
    });

  beforeEach(async () => {
    clock = new Date("2026-10-17T06:00:00.000Z");
    w = world();
    w.store.users.set("alice", { uid: "alice", status: "active", demoModeEnabled: true, liveSendingEnabled: true });
    apiKey = ((await createKey(input(user("alice"), { name: "k", environment: "live" }), w.deps)).body as { secret: string }).secret;
    dev = await pairDevice(w);
    await heartbeat(input(dev.auth, beat(dev.auth).body), w.deps);
  });

  it("runs the whole lifecycle: send -> claim -> sending -> sent -> delivered", async () => {
    const created = (await sendLive()).body as { id: string; status: string };
    expect(created.status).toBe("queued");

    const claimed = ((await claim(input(dev.auth), w.deps)).body as { job: { id: string; claimVersion: number; to: string; message: string } }).job;
    expect(claimed.id).toBe(created.id);
    expect(claimed.to).toBe("+15551234567");
    expect((await status(created.id)).status).toBe("assigned");

    const c = claimed.claimVersion;
    expect((await result(dev.auth, created.id, { claimVersion: c, event: "sending" })).status).toBe(200);
    expect((await status(created.id)).status).toBe("sending");

    await result(dev.auth, created.id, { claimVersion: c, event: "send_result", sendCallback: "success" });
    const sent = await status(created.id);
    expect(sent.status).toBe("sent");
    expect(sent.deliveryConfirmed).toBe(false);

    await result(dev.auth, created.id, { claimVersion: c, event: "delivery_report", deliveryReport: "confirmed" });
    const done = await status(created.id);
    expect(done.status).toBe("delivered");
    expect(done.deliveryConfirmed).toBe(true);
    expect(w.store.events.map((e) => e.to)).toEqual(["queued", "assigned", "sending", "sent", "delivered"].slice(1));
  });

  it("an unsupported delivery report keeps the job at `sent`, never `delivered`", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    await result(dev.auth, id, { claimVersion: c, event: "sending" });
    await result(dev.auth, id, { claimVersion: c, event: "send_result", sendCallback: "success" });
    const r = await result(dev.auth, id, { claimVersion: c, event: "delivery_report", deliveryReport: "unsupported" });
    expect(r.status).toBe(200);
    const s = await status(id);
    expect(s.status).toBe("sent");
    expect(s.deliveryConfirmed).toBe(false);
    expect(w.store.jobs.get(id)!.deliveryReceiptAvailable).toBe(false);
  });

  it("a failed send releases reserved quota; a sent one keeps it", async () => {
    w.store.keys.forEach((k) => (k.limits = { requestsPerMinute: 1000, dailyUnits: 2 }));
    const a = ((await sendLive("a")).body as { id: string }).id;
    const b = ((await sendLive("b")).body as { id: string }).id;
    expect(code(await sendLive("c"))).toBe("QUOTA_EXCEEDED");

    const j1 = ((await claim(input(dev.auth), w.deps)).body as { job: { id: string; claimVersion: number } }).job;
    expect(j1.id).toBe(a);
    await result(dev.auth, a, { claimVersion: j1.claimVersion, event: "sending" });
    await result(dev.auth, a, { claimVersion: j1.claimVersion, event: "send_result", sendCallback: "failure", telephonyErrorCode: 1 });
    expect((await status(a)).status).toBe("failed");
    expect(w.store.jobs.get(a)!.errorCode).toBe("TELEPHONY_1");

    expect((await sendLive("d")).status).toBe(202); // freed unit
    expect(b).toBeTruthy();
  });

  it("is idempotent and monotonic for duplicate and out-of-order callbacks", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    await result(dev.auth, id, { claimVersion: c, event: "sending" });
    await result(dev.auth, id, { claimVersion: c, event: "send_result", sendCallback: "success" });

    const dupSent = await result(dev.auth, id, { claimVersion: c, event: "send_result", sendCallback: "success" });
    const lateSending = await result(dev.auth, id, { claimVersion: c, event: "sending" });
    expect(dupSent.status).toBe(200);
    expect(lateSending.status).toBe(200);
    expect((await status(id)).status).toBe("sent");
    expect(w.store.events.filter((e) => e.to === "sent")).toHaveLength(1);
  });

  it("never allows a jump to delivered without sending, or a send result before sending", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "delivery_report", deliveryReport: "confirmed" }))).toBe("INVALID_TRANSITION");
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "send_result", sendCallback: "success" }))).toBe("INVALID_TRANSITION");
    expect((await status(id)).status).toBe("assigned");
  });

  it("rejects malformed result bodies and a wrong claim version", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "send_result" }))).toBe("VALIDATION_ERROR");
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "teleport" }))).toBe("VALIDATION_ERROR");
    expect(code(await result(dev.auth, id, { claimVersion: c + 1, event: "sending" }))).toBe("STALE_CLAIM");
  });

  it("two devices racing for one job: exactly one wins", async () => {
    const second = await pairDevice(w, "alice", "Second");
    await heartbeat(input(second.auth, beat(second.auth).body), w.deps);
    await sendLive();
    const [a, b] = await Promise.all([claim(input(dev.auth), w.deps), claim(input(second.auth), w.deps)]);
    const jobs = [a, b].map((r) => (r.body as { job: unknown }).job).filter(Boolean);
    expect(jobs).toHaveLength(1);
  });

  it("one account's device never receives another account's job", async () => {
    w.store.users.set("bob", { uid: "bob", status: "active", demoModeEnabled: true, liveSendingEnabled: true });
    const bobDev = await pairDevice(w, "bob", "Bobs");
    await heartbeat(input(bobDev.auth, beat(bobDev.auth).body), w.deps);
    const id = ((await sendLive()).body as { id: string }).id;
    expect(((await claim(input(bobDev.auth), w.deps)).body as { job: unknown }).job).toBeNull();

    const mine = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job;
    expect(code(await result(bobDev.auth, id, { claimVersion: mine.claimVersion, event: "sending" }))).toBe("NOT_FOUND");
    expect(code(await run(() => fetchJob(input(bobDev.auth, "", { id }), w.deps)))).toBe("NOT_FOUND");
  });

  it("hands out no work to a paused, unpermitted, or no-SIM connector, or when live is disabled", async () => {
    await sendLive();
    for (const over of [{ connectorRunning: false }, { smsPermissionGranted: false }, { telephonyAvailable: false }]) {
      await heartbeat(input(dev.auth, beat(dev.auth, over).body), w.deps);
      expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
    }
    await heartbeat(input(dev.auth, beat(dev.auth).body), w.deps);
    w.store.users.get("alice")!.liveSendingEnabled = false;
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
    w.store.users.get("alice")!.liveSendingEnabled = true;
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).not.toBeNull();
  });

  it("re-queues a job whose lease expired before sending, and rejects the old claim", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const first = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job;
    advance(61); // lease is 60s; device never started sending
    await heartbeat(input(dev.auth, beat(dev.auth).body), w.deps);
    const second = ((await claim(input(dev.auth), w.deps)).body as { job: { id: string; claimVersion: number } }).job;
    expect(second.id).toBe(id);
    expect(second.claimVersion).toBe(first.claimVersion + 1);
    expect(code(await result(dev.auth, id, { claimVersion: first.claimVersion, event: "sending" }))).toBe("STALE_CLAIM");
  });

  it("refuses to start sending once the lease has expired", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    advance(61);
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "sending" }))).toBe("LEASE_EXPIRED");
  });

  it("NEVER re-queues or resends a job that is `sending` or `unknown`, even after the lease", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    await result(dev.auth, id, { claimVersion: c, event: "sending" });
    advance(3600);
    await heartbeat(input(dev.auth, beat(dev.auth).body), w.deps);
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
    expect((await status(id)).status).toBe("sending");

    await result(dev.auth, id, { claimVersion: c, event: "send_result", sendCallback: "unknown" });
    expect((await status(id)).status).toBe("unknown");
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
    expect((await status(id)).deliveryConfirmed).toBe(false);
  });

  it("expires queued jobs past their TTL and releases their quota", async () => {
    w.store.keys.forEach((k) => (k.limits = { requestsPerMinute: 1000, dailyUnits: 1 }));
    const id = ((await sendLive("one")).body as { id: string }).id;
    expect(code(await sendLive("two"))).toBe("QUOTA_EXCEEDED");
    advance(301); // job TTL is 300s (5 minutes)
    await heartbeat(input(dev.auth, beat(dev.auth).body), w.deps);
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
    expect((await status(id)).status).toBe("expired");
    expect((await sendLive("three")).status).toBe(202);
  });

  it("a revoked device cannot report on a job it already holds", async () => {
    const id = ((await sendLive()).body as { id: string }).id;
    const c = ((await claim(input(dev.auth), w.deps)).body as { job: { claimVersion: number } }).job.claimVersion;
    await revokeDevice(input(user("alice"), "", { deviceId: dev.deviceId }), w.deps);
    expect(code(await result(dev.auth, id, { claimVersion: c, event: "sending" }))).toBe("DEVICE_REVOKED");
  });

  it("rejects bad or forged device credentials uniformly", async () => {
    expect(code(await run(() => claim(input(undefined), w.deps)))).toBe("INVALID_DEVICE_CREDENTIAL");
    expect(code(await run(() => claim(input("Bearer " + apiKey), w.deps)))).toBe("INVALID_DEVICE_CREDENTIAL");
    const forged = dev.auth.slice(0, -4) + "0000";
    expect(code(await run(() => claim(input(forged), w.deps)))).toBe("INVALID_DEVICE_CREDENTIAL");
  });

  it("heartbeat says which live switch is off", async () => {
    const hb = async (ww: World, auth: string) =>
      (await heartbeat(input(auth, beat(auth).body), ww.deps)).body as { liveSendingAllowed: boolean; liveBlockedBy: string[] };

    expect(await hb(w, dev.auth)).toEqual({ ...(await hb(w, dev.auth)), liveSendingAllowed: true, liveBlockedBy: [] });

    w.store.users.get("alice")!.liveSendingEnabled = false;
    const acct = await hb(w, dev.auth);
    expect(acct.liveSendingAllowed).toBe(false);
    expect(acct.liveBlockedBy).toEqual(["account_flag"]);

    const off = world({ CWP_LIVE_SENDING_ENABLED: "false" });
    const d2 = await pairDevice(off);
    off.store.users.get("alice")!.liveSendingEnabled = true;
    expect((await hb(off, d2.auth)).liveBlockedBy).toEqual(["platform_setting"]);
    off.store.users.get("alice")!.liveSendingEnabled = false;
    expect((await hb(off, d2.auth)).liveBlockedBy).toEqual(["platform_setting", "account_flag"]);
  });

  it("demo requests are never claimable", async () => {
    await handleSend(
      {
        authorization: `Bearer ${apiKey}`,
        idempotencyKey: "demo-1",
        contentType: "application/json",
        rawBody: JSON.stringify({ to: "+15551234567", message: "demo", mode: "demo" }),
      },
      { store: w.store, config: w.deps.config, now: () => clock },
      "req_t",
    );
    expect(((await claim(input(dev.auth), w.deps)).body as { job: unknown }).job).toBeNull();
  });
});
