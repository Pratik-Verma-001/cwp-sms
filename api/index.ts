import handler from "../backend/dispatch.js";

// Raw body is read manually so size limits and idempotency hashing are exact.
export const config = { api: { bodyParser: false } };

// vercel.json rewrites /api/v1/* to this single function (Vercel Hobby allows at most 12 functions).
export default handler;
