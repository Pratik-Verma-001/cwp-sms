import { describe, expect, it } from "vitest";
import { generateApiKey, hashSecret, parseApiKey, verifySecret } from "../../backend/security/apiKey";
import { countSmsUnits, maskDestination } from "../../shared/schemas";

const PEPPER = "unit-test-pepper-0123456789";

describe("api keys", () => {
  it("generates a parseable key whose hash verifies", () => {
    const k = generateApiKey("live", PEPPER);
    const parsed = parseApiKey(k.raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(k.keyId);
    expect(parsed!.environment).toBe("live");
    expect(verifySecret(parsed!.secret, k.secretHash, PEPPER)).toBe(true);
  });

  it("does not store the raw secret in the hash or prefix", () => {
    const k = generateApiKey("test", PEPPER);
    const secret = parseApiKey(k.raw)!.secret;
    expect(k.secretHash).not.toContain(secret);
    expect(k.prefix).not.toContain(secret);
  });

  it("rejects wrong secrets, wrong peppers, and malformed keys", () => {
    const k = generateApiKey("live", PEPPER);
    const secret = parseApiKey(k.raw)!.secret;
    expect(verifySecret("0".repeat(64), k.secretHash, PEPPER)).toBe(false);
    expect(verifySecret(secret, k.secretHash, "a-different-pepper-0123456")).toBe(false);
    expect(parseApiKey("cwp_live_nothex_nothex")).toBeNull();
    expect(parseApiKey("Bearer abc")).toBeNull();
  });

  it("rejects a weak pepper", () => {
    expect(() => hashSecret("x", "short")).toThrow();
  });

  it("generates unique keys", () => {
    expect(generateApiKey("live", PEPPER).raw).not.toBe(generateApiKey("live", PEPPER).raw);
  });
});

describe("sms helpers", () => {
  it("counts segments with the documented rule", () => {
    expect(countSmsUnits("hello")).toBe(1);
    expect(countSmsUnits("a".repeat(160))).toBe(1);
    expect(countSmsUnits("a".repeat(161))).toBe(2);
    expect(countSmsUnits("é".repeat(70))).toBe(1);
    expect(countSmsUnits("é".repeat(71))).toBe(2);
  });

  it("masks destinations", () => {
    const masked = maskDestination("+15551234567");
    expect(masked).not.toContain("1234");
    expect(masked.startsWith("+1555")).toBe(true);
    expect(masked.endsWith("567")).toBe(true);
  });
});
