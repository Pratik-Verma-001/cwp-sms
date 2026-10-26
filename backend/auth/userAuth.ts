import { ApiError } from "../errors.js";
import type { ManagementStore } from "../management/types.js";
import type { UserRecord } from "../sms/store.js";

export interface VerifiedToken {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

/** Production: Firebase Admin verifyIdToken. Tests: a fake. */
export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

/**
 * Dashboard auth: verifies the Firebase ID token server-side, provisions the profile on first
 * sight (server-assigned defaults only), and re-checks account status on every call.
 */
export async function authenticateUser(
  authorization: string | undefined,
  verifier: TokenVerifier,
  store: ManagementStore,
  now: Date,
): Promise<UserRecord> {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  if (!m) throw new ApiError(401, "INVALID_TOKEN", "A valid sign-in token is required.");

  let token: VerifiedToken;
  try {
    token = await verifier.verify(m[1]!);
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "A valid sign-in token is required.");
  }
  if (!token.emailVerified) {
    throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before using this endpoint.");
  }

  const user = await store.ensureUser({ uid: token.uid, email: token.email, emailVerified: true, now });
  if (user.status !== "active") throw new ApiError(403, "ACCOUNT_SUSPENDED", "The account is not active.");
  return user;
}
