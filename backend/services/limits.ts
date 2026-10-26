import type { Config } from "../config.js";
import type { PlatformSettings, UserLimits, UserRecord } from "../sms/store.js";

export interface EffectiveLimits {
  dailyUnits: number;
  requestsPerMinute: number;
  maxDevices: number;
  maxActiveKeys: number;
}

/** Admin overrides on the account win; otherwise platform defaults apply. */
export function effectiveLimits(user: { limits?: UserLimits }, config: Config): EffectiveLimits {
  return {
    dailyUnits: user.limits?.dailyUnits ?? config.defaultDailyUnits,
    requestsPerMinute: user.limits?.requestsPerMinute ?? config.defaultRequestsPerMinute,
    maxDevices: user.limits?.maxDevices ?? config.maxConnectedDevices,
    maxActiveKeys: user.limits?.maxActiveKeys ?? config.maxActiveKeys,
  };
}

/** The administrator's runtime switch, if set, replaces the environment default. */
export function platformLiveEnabled(settings: PlatformSettings, config: Config): boolean {
  return settings.liveSendingEnabled ?? config.liveSendingEnabled;
}

export const liveAllowedFor = (user: Pick<UserRecord, "liveSendingEnabled">, settings: PlatformSettings, config: Config) =>
  platformLiveEnabled(settings, config) && user.liveSendingEnabled;
