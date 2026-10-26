import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let db: Firestore | undefined;

/** Lazily initialises Firebase Admin from server-side environment variables only. */
export function getDb(env: Record<string, string | undefined> = process.env): Firestore {
  if (db) return db;

  const usingEmulator = Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST);
  if (usingEmulator && env.NODE_ENV === "production") {
    throw new Error("Firebase emulator variables must not be set in production.");
  }

  if (getApps().length === 0) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const clientEmail = env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (projectId && clientEmail && privateKey) {
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    } else if (usingEmulator && projectId) {
      initializeApp({ projectId });
    } else {
      throw new Error("Firebase Admin credentials are not configured.");
    }
  }

  db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
