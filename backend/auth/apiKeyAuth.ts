import { ApiError } from "../errors.js";
import type { Config } from "../config.js";
import { parseApiKey, verifySecret } from "../security/apiKey.js";
import type { ApiKeyRecord, SendStore, UserRecord } from "../sms/store.js";

export interface Authenticated {
  key: ApiKeyRecord;
  user: UserRecord;
}

const INVALID = () => new ApiError(401, "INVALID_API_KEY", "The API key is missing or invalid.");

/**
 * Resolves `Authorization: Bearer <CWP API key>` to an active key and active account.
 * Unknown key, wrong secret, and environment mismatch all return the same error
 * so callers cannot probe which key IDs exist.
 */
export async function authenticateApiKey(
  authorization: string | undefined,
  store: SendStore,
  config: Config,
  now: Date,
  requiredScopes: readonly string[],
): Promise<Authenticated> {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  const parsed = m ? parseApiKey(m[1]!) : null;
  if (!parsed) throw INVALID();

  const key = await store.getApiKey(parsed.keyId);
  if (!key || key.environment !== parsed.environment) throw INVALID();
  if (!verifySecret(parsed.secret, key.secretHash, config.apiKeyPepper)) throw INVALID();

  if (key.status !== "active" || (key.expiresAt && key.expiresAt.getTime() <= now.getTime())) {
    throw new ApiError(401, "API_KEY_INACTIVE", "The API key has been revoked or has expired.");
  }
  if (!requiredScopes.some((s) => key.scopes.includes(s))) {
    throw new ApiError(403, "INSUFFICIENT_SCOPE", "The API key does not have the required scope.");
  }

  const user = await store.getUser(key.ownerUid);
  if (!user || user.status !== "active") {
    throw new ApiError(403, "ACCOUNT_SUSPENDED", "The account is not active.");
  }
  return { key, user };
}
