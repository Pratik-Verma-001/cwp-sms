// Fails if the working tree contains obvious secrets or forbidden files.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vercel", "coverage"]);
const problems = [];

const patterns = [
  { name: "raw CWP API key", re: /cwp_(?:live|test)_[0-9a-f]{16}_[0-9a-f]{64}/ },
  { name: "real private key", re: /-----BEGIN (?:RSA )?PRIVATE KEY-----(?!\\n?REPLACE_WITH_PLACEHOLDER_ONLY)[A-Za-z0-9+/=\\n\s]{200,}/ },
];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const name = basename(full);
    if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
      problems.push(`forbidden env file: ${full}`);
    }
    if (/^serviceAccount.*\.json$/.test(name) || /-firebase-adminsdk-.*\.json$/.test(name)) {
      problems.push(`service account file: ${full}`);
    }
    if (/\.(jks|keystore)$/.test(name)) problems.push(`keystore file: ${full}`);
    if (st.size > 1_000_000 || /\.(png|jpg|ico|woff2?)$/.test(name)) continue;
    // Test files intentionally generate keys at runtime, so only scan non-test sources.
    if (full.includes("/tests/")) continue;
    const text = readFileSync(full, "utf8");
    for (const { name: label, re } of patterns) {
      if (re.test(text)) problems.push(`${label} found in ${full}`);
    }
  }
}

walk(process.cwd());

if (problems.length > 0) {
  console.error("Secret check failed:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log("Secret check passed.");
