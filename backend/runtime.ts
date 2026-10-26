import { loadConfig } from "./config.js";
import { getDb } from "./firebase/admin.js";
import { FirebaseTokenVerifier } from "./firebase/tokenVerifier.js";
import { FirestoreManagementStore } from "./management/firestoreManagementStore.js";
import type { ManagementDeps } from "./services/deps.js";
import { FirestoreStore } from "./sms/firestoreStore.js";
import type { Deps } from "./sms/sendService.js";

let sendDeps: Deps | undefined;
let mgmtDeps: ManagementDeps | undefined;

/** Built once per warm serverless instance. */
export function getDeps(): Deps {
  if (!sendDeps) sendDeps = { store: new FirestoreStore(getDb()), config: loadConfig() };
  return sendDeps;
}

export function getManagementDeps(): ManagementDeps {
  if (!mgmtDeps) {
    mgmtDeps = { store: new FirestoreManagementStore(getDb()), verifier: new FirebaseTokenVerifier(), config: loadConfig() };
  }
  return mgmtDeps;
}
