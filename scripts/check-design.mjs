import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const failures = [];
const need = (value, message) => { if (!value) failures.push(message); };
// The local-only docs are checked when present; a fresh clone checks just the tracked ones.
const localDocs = ["CLAUDE.md", ".notes/acceptance.md", ".notes/backend-status.md", ".notes/decisions.md"];
const files = ["README.md", "docs/api.md", "docs/architecture.md", "docs/memory.md",
  "README.zh-CN.md", "docs/usage.md", "docs/usage.zh-CN.md", "docs/development.md", "docs/development.zh-CN.md",
  "docs/releasing.md", "docs/releasing.zh-CN.md", "CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md", "SECURITY.md",
  ...localDocs.filter(f => fs.existsSync(path.join(root, f)))];
const texts = files.map(read);
const catalog = JSON.parse(read("tests/acceptance/cases.json"));
const ids = new Set(catalog.cases.map(c => c.id));
// Retired case IDs that the docs may still name.
const retired = new Set(["A007", "A009", "A019"]);
need(catalog.schema_version === 1, "acceptance schema_version");
need(ids.size === catalog.cases.length && ids.size === 33, "33 unique cases");
const validModes = new Set(["integration", "live", "ui"]);
const groups = new Set(Object.keys(catalog.gates));
let assertionCount = 0;
for (const c of catalog.cases) {
  need(/^A\d{3}$/.test(c.id), "bad case ID: " + c.id);
  need(groups.has(c.gate), "unknown gate: " + c.id);
  need(validModes.has(c.mode), "unknown mode: " + c.id);
  need(c.status === "not_run", "spec must not claim product passed: " + c.id);
  need(Number.isInteger(c.timeout_ms) && c.timeout_ms > 0, "invalid deadline: " + c.id);
  for (const key of ["setup", "steps", "assertions", "evidence"]) need(Array.isArray(c[key]) && c[key].length > 0, "missing " + key + ": " + c.id);
  need(new Set(c.evidence).size === c.evidence.length, "duplicate evidence: " + c.id);
  const paths = new Set();
  for (const a of c.assertions) {
    need(a.op === "eq" && Object.hasOwn(a, "expected"), "unsupported assertion: " + c.id);
    need(/^[a-z][a-z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(a.path), "bad assertion path: " + c.id);
    need(!paths.has(a.path), "duplicate assertion: " + c.id); paths.add(a.path);
    assertionCount++;
  }
}
need(assertionCount === 224, "224 assertions");
for (let f = 0; f < files.length; f++) {
  const text = texts[f];
  for (const m of text.matchAll(/\bA\d{3}\b/g)) need(ids.has(m[0]) || retired.has(m[0]), "unknown case in " + files[f] + ": " + m[0]);
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const url = m[1];
    if (/^(https?:|#|~\/)/.test(url)) continue;
    const target = path.resolve(path.dirname(path.join(root, files[f])), url.split("#")[0]);
    need(fs.existsSync(target), "broken local link " + files[f] + " → " + url);
  }
}
if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure);
  process.exitCode = 1;
} else {
  console.log(`Design checks passed: 33 cases, 224 assertions, links in ${files.length} docs.`);
  console.log("Scope: static specification only; product results are recorded in separate reports.");
}
