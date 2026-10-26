import { describe, expect, it } from "vitest";
import {
  canTransition,
  isConfirmedDelivery,
  isDuplicateRisk,
  isSimulated,
  isStale,
} from "../../shared/status-machine";

describe("status machine", () => {
  it("allows the documented happy path", () => {
    expect(canTransition("queued", "assigned")).toBe(true);
    expect(canTransition("assigned", "sending")).toBe(true);
    expect(canTransition("sending", "sent")).toBe(true);
    expect(canTransition("sent", "delivery_pending")).toBe(true);
    expect(canTransition("delivery_pending", "delivered")).toBe(true);
  });

  it("never jumps from sending straight to delivered", () => {
    expect(canTransition("sending", "delivered")).toBe(false);
    expect(canTransition("queued", "sent")).toBe(false);
    expect(canTransition("queued", "delivered")).toBe(false);
  });

  it("treats terminal states as final", () => {
    for (const s of ["delivered", "failed", "expired", "cancelled", "demo_completed"] as const) {
      expect(canTransition(s, "queued")).toBe(false);
    }
  });

  it("flags stale and duplicate callbacks", () => {
    expect(isStale("sent", "sending")).toBe(true);
    expect(isStale("sent", "sent")).toBe(true);
    expect(isStale("sending", "sent")).toBe(false);
  });

  it("only `delivered` counts as confirmed delivery", () => {
    expect(isConfirmedDelivery("delivered")).toBe(true);
    for (const s of ["queued", "sending", "sent", "delivery_pending", "unknown", "demo_completed"] as const) {
      expect(isConfirmedDelivery(s)).toBe(false);
    }
  });

  it("marks sending/unknown as duplicate-risk and demo as simulated", () => {
    expect(isDuplicateRisk("sending")).toBe(true);
    expect(isDuplicateRisk("unknown")).toBe(true);
    expect(isDuplicateRisk("queued")).toBe(false);
    expect(isSimulated("demo_completed")).toBe(true);
  });
});
