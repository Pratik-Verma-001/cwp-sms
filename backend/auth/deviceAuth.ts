import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import type { DeviceRecord, ManagementStore } from "../management/types.js";
import { parseDeviceCredential, verifyDeviceSecret } from "../security/deviceCredential.js";
import type { UserRecord } from "../sms/store.js";

const INVALID = () => new ApiError(401, "INVALID_DEVICE_CREDENTIAL", "The device credential is missing or invalid.");

/** Every connector call re-checks credential, device state, and account state. */
export async function authenticateDevice(
  authorization: string | undefined,
  store: ManagementStore,
  config: Config,
  now?: Date,
): Promise<{ device: DeviceRecord; user: UserRecord }> {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  const parsed = m ? parseDeviceCredential(m[1]!) : null;
  if (!parsed) throw INVALID();

  const device = await store.getDevice(parsed.deviceId);
  if (!device || !verifyDeviceSecret(parsed.secret, device.deviceCredentialHash, config.deviceTokenPepper)) {
    throw INVALID();
  }
  if (device.status !== "active") throw new ApiError(401, "DEVICE_REVOKED", "This device has been revoked.");

  // A phone enrolled with a connector key is only as valid as that key.
  if (device.connectorKeyId) {
    const key = await store.getApiKey(device.connectorKeyId);
    if (!key || key.status !== "active" || (key.expiresAt && key.expiresAt.getTime() <= (now ?? new Date()).getTime())) {
      throw new ApiError(401, "CONNECTOR_KEY_INACTIVE", "The connector key for this device was revoked or has expired.");
    }
  }

  const user = await store.getUser(device.ownerUid);
  if (!user || user.status !== "active") throw new ApiError(403, "ACCOUNT_SUSPENDED", "The account is not active.");
  return { device, user };
}
