// Fail if any package in a `pnpm licenses list --json` report has a license
// outside ALLOWED_LICENSES (semicolon-separated SPDX identifiers), unless the
// package is in IGNORE_PACKAGES (space-separated names). Expressions with nested
// groups, such as "A AND (B OR C)", are rejected for manual review.
import { readFileSync } from "node:fs";

if (!process.env.ALLOWED_LICENSES) throw new Error("ALLOWED_LICENSES is not set");
const allowed = new Set(process.env.ALLOWED_LICENSES.split(";").map((l) => l.trim()));
const ignored = new Set((process.env.IGNORE_PACKAGES ?? "").split(/\s+/).filter(Boolean));

function isAllowed(expression) {
  const license = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/[()]/.test(license)) return false;
  if (license.includes(" OR ")) return license.split(" OR ").some(isAllowed);
  if (license.includes(" AND ")) return license.split(" AND ").every(isAllowed);
  return allowed.has(license);
}

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
let rejected = 0;
for (const [license, packages] of Object.entries(report)) {
  if (isAllowed(license)) continue;
  for (const pkg of packages) {
    if (ignored.has(pkg.name)) continue;
    const versions = [].concat(pkg.versions ?? pkg.version ?? []).join(",");
    console.log(`NOT ALLOWED: ${pkg.name}@${versions} (${license})`);
    rejected++;
  }
}
if (rejected > 0) {
  console.log(`FAIL: ${rejected} package(s) have licenses that need manual review`);
  process.exit(1);
}
console.log("All licenses are on the allow-list.");
