import type { TokenVerifier } from "../auth/userAuth.js";
import type { Config } from "../config.js";
import type { ManagementStore } from "../management/types.js";

export interface ManagementDeps {
  store: ManagementStore;
  verifier: TokenVerifier;
  config: Config;
  now?: () => Date;
}

export interface RouteInput {
  authorization?: string;
  rawBody: string;
  /** Path/query parameters (e.g. keyId, id). */
  params: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
}

export const nowOf = (d: ManagementDeps): Date => (d.now ?? (() => new Date()))();
