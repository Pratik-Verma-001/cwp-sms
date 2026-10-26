import { z } from "zod";

export const E164 = /^\+[1-9]\d{6,14}$/;
export const MAX_MESSAGE_CHARS = 1600;

/** `connector` is exclusive: a connector key can register a phone but can never send SMS or open the dashboard. */
export const SCOPES = ["sms:send", "sms:read", "connector"] as const;
export type Scope = (typeof SCOPES)[number];

export const sendRequestSchema = z
  .object({
    to: z.string().regex(E164, "to must be an E.164 number such as +15551234567"),
    message: z
      .string()
      .max(MAX_MESSAGE_CHARS)
      .refine((m) => m.trim().length > 0, "message must not be empty"),
    mode: z.enum(["demo", "live"]).optional(),
    clientReference: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.:-]+$/, "clientReference may only contain letters, digits, _ . : -")
      .optional(),
  })
  .strict();

export type SendRequest = z.infer<typeof sendRequestSchema>;

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/**
 * Documented unit rule: one unit = one SMS segment.
 * Printable-ASCII text is treated as GSM-style (160 chars single, 153 per segment when split).
 * Anything else is treated as UCS-2 (70 single, 67 per segment).
 * This is a conservative approximation; the GSM extension table is not modelled.
 */
export function countSmsUnits(message: string): number {
  const gsmLike = /^[\x20-\x7E\r\n]*$/.test(message);
  const [single, multi] = gsmLike ? [160, 153] : [70, 67];
  const len = message.length;
  if (len <= single) return 1;
  return Math.ceil(len / multi);
}

export function maskDestination(destination: string): string {
  if (destination.length <= 8) return "*".repeat(destination.length);
  const hidden = Math.max(1, destination.length - 8);
  return destination.slice(0, 5) + "*".repeat(hidden) + destination.slice(-3);
}
