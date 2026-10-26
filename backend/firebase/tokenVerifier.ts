import { getAuth } from "firebase-admin/auth";
import type { TokenVerifier } from "../auth/userAuth.js";
import { getDb } from "./admin.js";

/** Verifies Firebase ID tokens with the Admin SDK. `checkRevoked` makes revocation take effect. */
export class FirebaseTokenVerifier implements TokenVerifier {
  async verify(idToken: string) {
    getDb(); // ensures the Admin app is initialised
    const decoded = await getAuth().verifyIdToken(idToken, true);
    return { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.email_verified === true };
  }
}
