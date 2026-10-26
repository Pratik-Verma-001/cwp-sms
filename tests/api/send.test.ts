import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../backend/config";
import { generateApiKey } from "../../backend/security/apiKey";
import { hashValue } from "../../backend/security/apiKey";
import { MemoryStore } from "../../backend/sms/memoryStore";
import { handleSend, type Deps } from "../../backend/sms/sendService";
import { handleStatus } from "../../backend/sms/statusService";

const ENV = {
  CWP_API_KEY_HASH_PEPPER: "test-api-pepper-0123456789",
  CWP_DEVICE_TOKEN_HASH_PEPPER: "test-device-pepper-0123456789",
  CWP_LIVE_SENDING_ENABLED: "true",
};
const NOW = new Date("2026-10-17T06:00:00.000Z");

interface World {
  store: MemoryStore;
  config: Config;
  deps: Deps;
  rawKey: string;
  testKey: string;
}

function makeWorld(overrides: Record<string, string> = {}): World {
  const config = loadConfig({ ...ENV, ...overrides });
  const store = new MemoryStore();
  let n = 0;
  const deps: Deps = {
    store,
    config,
    now: () => NOW,
    // Deterministic IDs that still match the production ID shape.
    newId: (p) => `${p}_${(++n).toString(16).padStart(24, "0")}`,
  };
  const live = generateApiKey("live", config.apiKeyPepper);
  const test = generateApiKey("test", config.apiKeyPepper);
  for (const [k, env] of [[live, "live"], [test, "test"]] as const) {
    store.keys.set(k.keyId, {
      keyId: k.keyId,
      ownerUid: "user-a",
      secretHash: k.secretHash,
      environment: env,
      scopes: ["sms:send", "sms:read"],
      status: "active",
      limits: { requestsPerMinute: 5, dailyUnits: 50 },
    });
  }
  store.users.set("user-a", { uid: "user-a", status: "active", demoModeEnabled: true, liveSendingEnabled: true });
  store.devices.push({
    ownerUid: "user-a",
    status: "active",
    connectorRunning: true,
    smsPermissionGranted: true,
    lastSeenAt: new Date(NOW.getTime() - 10_000),
  });
  return { store, config, deps, rawKey: live.raw, testKey: test.raw };
}

function send(w: World, body: unknown, opts: { key?: string; idem?: string | null; ct?: string } = {}) {
  return handleSend(
    {
      authorization: `Bearer ${opts.key ?? w.rawKey}`,
      ...(opts.idem === null ? {} : { idempotencyKey: opts.idem ?? "idem-1" }),
      contentType: opts.ct ?? "application/json",
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    w.deps,
    "req_test",
  );
}

const live = { to: "+15551234567", message: "Your order has been updated.", mode: "live" };
const demo = { ...live, mode: "demo" };
const code = (r: { body?: unknown }) => (r.body as { error: { code: string } }).error.code;

describe("POST /sms/send", () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });

  it("queues a live job and returns 202 without claiming delivery", async () => {
    const r = await send(w, live);
    expect(r.status).toBe(202);
    const b = r.body as { id: string; status: string; simulated: boolean };
    expect(b.status).toBe("queued");
    expect(b.simulated).toBe(false);
    expect(w.store.jobs.get(b.id)?.status).toBe("queued");
  });

  it("demo mode completes as simulated and is never queued for a device", async () => {
    const r = await send(w, demo);
    expect(r.status).toBe(202);
    const b = r.body as { id: string; status: string; simulated: boolean };
    expect(b.status).toBe("demo_completed");
    expect(b.simulated).toBe(true);
    const job = w.store.jobs.get(b.id)!;
    expect(job.mode).toBe("demo");
    expect(job.status).not.toBe("queued");
    expect(job.quotaUnitsReserved).toBe(0);
  });

  it("defaults to demo when mode is omitted", async () => {
    const r = await send(w, { to: live.to, message: live.message });
    expect((r.body as { mode: string }).mode).toBe("demo");
  });

  it("blocks live sending when disabled globally", async () => {
    const off = makeWorld({ CWP_LIVE_SENDING_ENABLED: "false" });
    const r = await send(off, live);
    expect(r.status).toBe(403);
    expect(code(r)).toBe("LIVE_SENDING_DISABLED");
    expect(off.store.jobs.size).toBe(0);
  });

  it("blocks live sending with a test-environment key", async () => {
    const r = await send(w, live, { key: w.testKey });
    expect(code(r)).toBe("LIVE_SENDING_DISABLED");
  });

  it("replays the same idempotent request without a second job or double quota", async () => {
    const a = await send(w, live);
    const b = await send(w, live);
    expect(b.status).toBe(202);
    expect((b.body as { id: string }).id).toBe((a.body as { id: string }).id);
    expect(b.headers?.["Idempotent-Replay"]).toBe("true");
    expect(w.store.jobs.size).toBe(1);
    // 50 units/day: 50 distinct single-unit requests would still fit, proving only 1 unit was spent.
    w.store.keys.forEach((k) => (k.limits.requestsPerMinute = 1000));
    for (let i = 0; i < 49; i++) {
      const r = await send(w, { ...live, message: `msg ${i}` }, { idem: `k-${i}` });
      expect(r.status).toBe(202);
    }
    const over = await send(w, { ...live, message: "one too many" }, { idem: "k-over" });
    expect(code(over)).toBe("QUOTA_EXCEEDED");
  });

  it("returns 409 when an idempotency key is reused with a different payload", async () => {
    await send(w, live);
    const r = await send(w, { ...live, message: "Something else entirely" });
    expect(r.status).toBe(409);
    expect(code(r)).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("requires a valid Idempotency-Key", async () => {
    expect(code(await send(w, live, { idem: null }))).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(code(await send(w, live, { idem: "has spaces!" }))).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("enforces the per-minute rate limit", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await send(w, demo, { idem: `r-${i}` })).status).toBe(202);
    }
    const r = await send(w, demo, { idem: "r-6" });
    expect(r.status).toBe(429);
    expect(code(r)).toBe("RATE_LIMITED");
  });

  it("rejects when no eligible device is online", async () => {
    w.store.devices[0]!.lastSeenAt = new Date(NOW.getTime() - 10 * 60_000);
    const r = await send(w, live);
    expect(r.status).toBe(409);
    expect(code(r)).toBe("NO_ELIGIBLE_DEVICE");
    w.store.devices[0]!.lastSeenAt = NOW;
    w.store.devices[0]!.smsPermissionGranted = false;
    expect(code(await send(w, live, { idem: "again" }))).toBe("NO_ELIGIBLE_DEVICE");
  });

  it("rejects suppressed recipients", async () => {
    const h = hashValue(w.config.apiKeyPepper, "dest", live.to);
    w.store.suppressions.add(`user-a_${h}`);
    const r = await send(w, live);
    expect(r.status).toBe(422);
    expect(code(r)).toBe("RECIPIENT_SUPPRESSED");
  });

  it("rejects missing, malformed, wrong-secret, and revoked keys with safe errors", async () => {
    expect(code(await send(w, live, { key: "nonsense" }))).toBe("INVALID_API_KEY");
    const wrong = w.rawKey.slice(0, -4) + "0000";
    expect(code(await send(w, live, { key: wrong }))).toBe("INVALID_API_KEY");
    const keyId = [...w.store.keys.values()].find((k) => k.environment === "live")!.keyId;
    w.store.keys.get(keyId)!.status = "revoked";
    const r = await send(w, live);
    expect(r.status).toBe(401);
    expect(code(r)).toBe("API_KEY_INACTIVE");
    expect(JSON.stringify(r.body)).not.toContain(w.rawKey);
  });

  it("rejects expired keys, missing scope, and suspended accounts", async () => {
    const keyId = [...w.store.keys.values()].find((k) => k.environment === "live")!.keyId;
    const rec = w.store.keys.get(keyId)!;
    rec.expiresAt = new Date(NOW.getTime() - 1);
    expect(code(await send(w, live))).toBe("API_KEY_INACTIVE");
    delete rec.expiresAt;
    rec.scopes = ["sms:read"];
    expect((await send(w, live)).status).toBe(403);
    rec.scopes = ["sms:send"];
    w.store.users.get("user-a")!.status = "suspended";
    expect(code(await send(w, live))).toBe("ACCOUNT_SUSPENDED");
  });

  it("validates the body: format, size, content type, unknown fields", async () => {
    expect(code(await send(w, { ...live, to: "5551234567" }))).toBe("VALIDATION_ERROR");
    expect(code(await send(w, { ...live, message: "   " }))).toBe("VALIDATION_ERROR");
    expect(code(await send(w, { ...live, message: "a".repeat(1601) }))).toBe("VALIDATION_ERROR");
    expect(code(await send(w, { ...live, extra: 1 }))).toBe("VALIDATION_ERROR");
    expect(code(await send(w, { to: ["+15551234567"], message: "bulk" }))).toBe("VALIDATION_ERROR");
    expect(code(await send(w, "{not json"))).toBe("INVALID_JSON");
    expect(code(await send(w, live, { ct: "text/plain" }))).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect((await send(w, "x".repeat(20_000))).status).toBe(413);
  });

  it("never echoes the message body or full destination in error output", async () => {
    const r = await send(w, { ...live, mode: "bogus" });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(live.message);
    expect(text).not.toContain(live.to);
  });
});

describe("GET /sms/status/:id", () => {
  it("returns canonical status and never reports `queued` or `sent` as delivered", async () => {
    const w = makeWorld();
    const created = (await send(w, live)).body as { id: string };
    const r = await handleStatus({ authorization: `Bearer ${w.rawKey}`, jobId: created.id }, w.deps, "req_s");
    expect(r.status).toBe(200);
    const b = r.body as { status: string; deliveryConfirmed: boolean; destination: string };
    expect(b.status).toBe("queued");
    expect(b.deliveryConfirmed).toBe(false);
    expect(b.destination).toContain("*");

    w.store.jobs.get(created.id)!.status = "sent";
    const sent = await handleStatus({ authorization: `Bearer ${w.rawKey}`, jobId: created.id }, w.deps, "req_s");
    expect((sent.body as { deliveryConfirmed: boolean }).deliveryConfirmed).toBe(false);
  });

  it("labels demo results as simulated", async () => {
    const w = makeWorld();
    const created = (await send(w, demo)).body as { id: string };
    const r = await handleStatus({ authorization: `Bearer ${w.rawKey}`, jobId: created.id }, w.deps, "req_s");
    const b = r.body as { simulated: boolean; deliveryConfirmed: boolean };
    expect(b.simulated).toBe(true);
    expect(b.deliveryConfirmed).toBe(false);
  });

  it("returns 404 for another account's job and for unknown ids", async () => {
    const w = makeWorld();
    const created = (await send(w, live)).body as { id: string };

    // Second account with its own key.
    const other = generateApiKey("live", w.config.apiKeyPepper);
    w.store.keys.set(other.keyId, {
      keyId: other.keyId,
      ownerUid: "user-b",
      secretHash: other.secretHash,
      environment: "live",
      scopes: ["sms:read"],
      status: "active",
      limits: { requestsPerMinute: 5, dailyUnits: 50 },
    });
    w.store.users.set("user-b", { uid: "user-b", status: "active", demoModeEnabled: true, liveSendingEnabled: true });

    const cross = await handleStatus({ authorization: `Bearer ${other.raw}`, jobId: created.id }, w.deps, "req_s");
    expect(cross.status).toBe(404);
    const missing = await handleStatus(
      { authorization: `Bearer ${w.rawKey}`, jobId: "smsreq_" + "f".repeat(24) },
      w.deps,
      "req_s",
    );
    expect(missing.status).toBe(404);
    expect(JSON.stringify(cross.body)).toBe(JSON.stringify(missing.body).replace("req_s", "req_s"));
  });

  it("requires authentication", async () => {
    const w = makeWorld();
    const r = await handleStatus({ jobId: "smsreq_" + "a".repeat(24) }, w.deps, "req_s");
    expect(r.status).toBe(401);
  });
});
