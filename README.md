# CWP SMS

SIM-based SMS gateway: a REST API creates SMS jobs, and (in a later phase) a user-controlled Android app sends them through the user's own SIM.

**Status:** API-key management, the connector protocol, the send/status path (demo and live), a web dashboard (`public/`) and an Android SDK source module (`android-sdk/`, zipped at `public/downloads/`) exist. The SDK has never been compiled or run on a phone. Admin panel and audit logging are not built. Nothing has been deployed to Vercel or run against a real Firebase project; see "What is verified".

## What exists

| Area | Files |
|---|---|
| Status state machine (12 states, stale-callback and duplicate-risk helpers) | `shared/status-machine/` |
| Request schemas, E.164 validation, SMS unit rule, destination masking | `shared/schemas/` |
| API key generation (`cwp_<env>_<keyId>_<secret>`), HMAC-SHA256 hashing with pepper, constant-time verify | `backend/security/apiKey.ts` |
| API key auth (scopes, expiry, revocation, account status, uniform 401) | `backend/auth/apiKeyAuth.ts` |
| Send service: validation, idempotency, rate limit, quota, demo/live separation | `backend/sms/sendService.ts` |
| Status service (owner-scoped, 404 for foreign IDs) | `backend/sms/statusService.ts` |
| Firestore store (single transaction for idempotency + rate limit + quota + job) | `backend/sms/firestoreStore.ts` |
| In-memory store for tests | `backend/sms/memoryStore.ts` |
| Firebase ID-token auth (verified email required, server-assigned defaults) | `backend/auth/userAuth.ts`, `backend/firebase/tokenVerifier.ts` |
| Key management: create (secret shown once), list, revoke | `backend/services/keys.ts` |
| Device pairing (single-use challenge), list, revoke; device credentials hashed | `backend/services/devices.ts`, `backend/security/deviceCredential.ts` |
| Connector protocol: heartbeat, claim with lease, fetch, result callbacks | `backend/services/connector.ts`, `backend/auth/deviceAuth.ts` |
| Firestore stores (transactions for claim, CAS transitions, quota release) | `backend/management/firestoreManagementStore.ts` |
| One serverless function serves the whole API (Vercel Hobby allows max 12 functions); route table in `backend/routes.ts` | `api/index.ts` (+ rewrite in `vercel.json`), `backend/dispatch.ts` |
| Deny-all Firestore rules | `firestore.rules` |
| Web dashboard (no build step; sign-in via Firebase REST; strict CSP in `vercel.json`) | `public/` |
| Dashboard APIs: config, dashboard summary, request list/detail | `backend/services/dashboard.ts` |
| Connector keys (scope `connector`) and `POST /connector/register` | `backend/services/connector.ts`, `backend/services/keys.ts` |
| Android SDK + sample app (Kotlin, no dependencies) | `android-sdk/` → `public/downloads/cwp-sms-android-sdk.zip` |
| Local preview server (memory store, no Firebase) | `scripts/dev-server.ts` |
| Secret scanner | `scripts/check-no-secrets.mjs` |

## Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/v1/keys`, `GET /api/v1/keys`, `DELETE /api/v1/keys/:keyId` | Firebase ID token | Create (secret returned once), list, revoke |
| `POST /api/v1/keys/:keyId/delete`, `POST /api/v1/devices/:deviceId/delete` | Firebase ID token | Permanently delete a key or phone. Only works after it is revoked (409 `REVOKE_FIRST` otherwise) |
| `POST /api/v1/devices/challenge` | Firebase ID token | Dashboard mints a 10-minute, single-use pairing code |
| `POST /api/v1/devices/register` | Firebase ID token + code | Android app redeems the code and receives its credential once |
| `GET /api/v1/devices`, `POST /api/v1/devices/:id/revoke` | Firebase ID token | List, revoke |
| `GET /api/v1/config` | none | Public: Firebase web API key for the dashboard sign-in |
| `GET /api/v1/dashboard`, `GET /api/v1/sms/requests[?status=pending\|sent\|...]`, `GET /api/v1/sms/requests/:id` | Firebase ID token | Counts, quota, devices, history, timeline (no message text, masked numbers) |
| `POST /api/v1/connector/send` | Device credential | The Android app's Send box: creates a demo/live request for the phone's owner (same rules as the dashboard) |
| `POST /api/v1/connector/register` | Connector key | The Android app exchanges base URL + key for a device credential (shown once) |
| `POST /api/v1/sms/send`, `GET /api/v1/sms/status/:id` | SMS API key | Submit, poll |
| `POST /api/v1/connector/heartbeat` | Device credential | Report running state, permission, SIM |
| `POST /api/v1/connector/jobs/claim` | Device credential | Lease the oldest queued live job |
| `GET /api/v1/connector/jobs/:id` | Device credential | Re-read a job this device holds |
| `POST /api/v1/connector/jobs/:id/result` | Device credential | Report `sending`, send result, delivery report |

Connector result body: `{ "claimVersion": 1, "event": "sending" | "send_result" | "delivery_report", "sendCallback"?: "success"|"failure"|"unknown", "deliveryReport"?: "confirmed"|"failed"|"pending"|"unsupported", "telephonyErrorCode"?: number }`.

Pairing flow: the dashboard calls `devices/challenge`; the user enters the code in the Android app; the app, signed in as the same user, calls `devices/register`. A code is bound to the account that minted it and works once.

**Key kinds.** An SMS API key (`sms:send`, `sms:read`) sends messages. A connector key (`connector`, exclusive) can only enroll a phone. Revoking a connector key disables phones enrolled with it on their next request. Re-registering the same install replaces its credential.

## Safety behaviour implemented

- Claims are leased (60 s). An expired lease is re-queued only if the device never began sending; the claim version increments so the old device's callbacks are rejected.
- Jobs in `sending` or `unknown` are never re-queued, however much time passes.
- Callbacks are idempotent and monotonic; `delivered` is reachable only via a `confirmed` delivery report after `sent`. `unsupported` keeps the job at `sent`.
- A definitive send failure or expiry releases the reserved quota; a successful send keeps it.
- A paused, unpermitted, or no-SIM connector is handed no work. Revoking a device or key takes effect on the next request.

- Default mode is **demo**; live sending needs `CWP_LIVE_SENDING_ENABLED=true`, the account flag, **and** a `live` key.
- Demo jobs are stored as `demo_completed`, reserve zero quota, and are never created in the `queued` state, so a connector can never claim them.
- `GET status` returns `deliveryConfirmed: true` only for `delivered`. `queued`, `sent`, and `unknown` are never presented as delivered.
- Raw API keys are never stored or logged; only a peppered hash is persisted.
- Errors never echo message bodies, full destination numbers, or credentials.

## Local setup

```bash
npm install
cp .env.example .env     # then set two different random peppers (never commit .env)
npm run typecheck
npm test
npm run lint:secrets
```

Generate peppers with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## API: send a demo message

```bash
curl -X POST "$BASE/api/v1/sms/send" \
  -H "Authorization: Bearer cwp_test_<key-id>_<secret>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-0001" \
  -d '{"to":"+15551234567","message":"Hello","mode":"demo"}'
```

`202` means the request was recorded. It does **not** mean sent or delivered. Poll `GET /api/v1/sms/status/<id>`.

## Admin panel (`/admin`)

- Open `https://<project>.vercel.app/admin`. Access = a verified Firebase sign-in whose email is listed in the Vercel env var `CWP_ADMIN_EMAILS` (comma separated). No password is stored or checked by this app; Firebase owns it. Create the admin account once with the "Create account" tab on that page, verify the email, then sign in.
- Platform live switch (ON / OFF / reset to environment default), stored in Firestore `platform/settings`; applies within ~15 s.
- Users: search, per-account live on/off, demo on/off, suspend, limit overrides (SMS units/day, requests/min, phones, keys), revoke any key or phone, usage and recent requests (masked numbers, no message text).
- Every admin change is written to the `auditLogs` collection and shown on the Audit tab.
- Admin routes: `GET /admin/overview`, `POST /admin/platform`, `GET /admin/users`, `GET|POST /admin/users/:uid`, `POST /admin/users/:uid/keys/:keyId/revoke`, `POST /admin/users/:uid/devices/:deviceId/revoke`, `POST /admin/users/:uid/keys/:keyId/delete`, `POST /admin/users/:uid/devices/:deviceId/delete`, `GET /admin/audit`.
- The dashboard's **Send** page uses `POST /dashboard/send` (sign-in token; same rules as the public API: idempotency, rate limit, quota, demo/live, online phone).

## Dashboard setup

1. Vercel env var `FIREBASE_WEB_API_KEY` = Firebase → Project settings → Web API key (public by design). Redeploy.
2. Create the new Firestore composite index (`smsJobs`: `ownerUid` Asc, `createdAt` Desc) — or `firebase deploy --only firestore:indexes`. The first dashboard load shows an error with a console link until it exists.
3. Firebase Auth → Settings → Authorized domains must include your Vercel domain.
4. Open `https://<project>.vercel.app/`.

Local preview without Firebase: `npx tsx scripts/dev-server.ts` (port 4173; sign-in needs the Firebase REST calls mocked, as in the E2E check).

## Firebase and Vercel setup (not yet exercised)

1. Create separate dev and prod Firebase projects. Enable only email/password auth.
2. Deploy `firestore.rules` and `firestore.indexes.json`.
3. Add a Firestore TTL policy on the `expiresAt` field of `usageCounters` and `idempotencyRecords`.
4. Import the repo into your own Vercel project. Set every variable from `.env.example` in Vercel's environment settings per environment. Leave the `*_EMULATOR_HOST` variables unset. Keep Preview deployments on a non-production Firebase project in demo mode.
5. After deploy, `curl $BASE/api/v1/health` and run the demo request above against the real URL.

## What is verified

- `tsc --noEmit` is clean except for packages that could not be installed in the build sandbox (`firebase-admin`, `@vercel/node`, `vitest`), so Firebase and Vercel types were not checked.
- All 59 tests pass. They ran under a small local stand-in for vitest because the npm registry was unreachable; run `npm test` with real vitest to confirm. Deliberately breaking the `sending -> delivered` rule and the lease-recovery rule made tests fail, so the tests do guard those rules.
- **Not verified:** the Firestore stores (transaction behaviour, the composite index), the Vercel route layout, Firebase token verification, and anything on a real Android device. The tests use an in-memory store; the Firestore implementations mirror it but have never run. Test them against the Firebase emulator before relying on them.

## Known gaps and next steps

- Android SDK is unverified on real devices. Admin panel is bounded to the newest 500 users/keys/phones.
- Cost: a phone that polls every 5 s around the clock may read Firestore tens of thousands of times a day (rough estimate), which can exceed the free tier. Consider a longer poll interval or a billing plan before running phones 24/7.
- Per-device and concurrent-job limits; per-minute counters are per key, daily quota per account.
- Request history reads the latest 200 jobs only; no pagination or date filters. `GET /usage` is not built.
- `lastUsedAt` on keys is not updated yet.
- Retention (30-day message bodies) is configured but no deletion job exists. Add a Firestore TTL policy on `expiresAt` for `usageCounters`, `idempotencyRecords`, and `devicePairings`.
- Lease recovery runs only when a device polls (the PRD's request-triggered option); there is no scheduled sweeper, so an offline account's expired jobs stay `queued` until its device next polls or the status is read after TTL.
- Google Play SMS permission policy must be reviewed before choosing a distribution route.
- Production use needs a telecom, consent, and privacy review for your region.
