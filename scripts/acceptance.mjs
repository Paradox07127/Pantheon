import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const raw = await fs.readFile(path.join(root, "tests/acceptance/cases.json"), "utf8");
const catalog = JSON.parse(raw);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (["--list", "--allow-live"].includes(key)) options[key] = true;
  else if (["--case", "--milestone", "--driver", "--out"].includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) options[key] = args[++i];
  else { console.error("Invalid argument: " + key); process.exit(64); }
}
if (options["--case"] && options["--milestone"]) {
  console.error("Choose --case or --milestone, not both"); process.exit(64);
}
if (options["--milestone"] && !/^M[0-4]$/.test(options["--milestone"])) {
  console.error("Unknown milestone"); process.exit(64);
}
let cases = catalog.cases;
if (options["--case"]) cases = cases.filter(c => c.id === options["--case"]);
if (options["--milestone"]) cases = cases.filter(c => Number(c.gate.slice(1)) <= Number(options["--milestone"].slice(1)));
if (!cases.length) { console.error("Unknown case"); process.exit(64); }
if (options["--list"]) {
  for (const c of cases) console.log([c.id, c.gate, c.mode, c.title, "NOT_RUN"].join("\t"));
  process.exit(0);
}
if (!options["--case"] && !options["--milestone"]) {
  console.error("Use --list, --case <case-id>, or --milestone <milestone>"); process.exit(64);
}
if (!options["--driver"]) {
  if (options["--case"]) console.log(JSON.stringify(cases[0], null, 2));
  console.error("NOT_IMPLEMENTED: no product driver supplied; no acceptance was executed.");
  process.exit(2);
}
const driver = path.resolve(options["--driver"]);
try { await fs.access(driver); } catch {
  console.error("NOT_IMPLEMENTED: driver file does not exist: " + driver); process.exit(2);
}
if (cases.some(c => c.mode === "live") && !options["--allow-live"]) {
  console.error("NOT_RUN: selected cases require --allow-live and prior account/budget authorization.");
  process.exit(2);
}
const output = path.resolve(options["--out"] || path.join(root, ".notes/evidence/acceptance-" + new Date().toISOString().replaceAll(":", "-")));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Refuse to overwrite any report directory.
const hash = value => createHash("sha256").update(value).digest("hex");
const lookup = (object, dotted) => dotted.split(".").reduce((v, key) =>
  v && typeof v === "object" && Object.hasOwn(v, key) ? v[key] : undefined, object);
const report = { spec_version: catalog.spec_version, catalog_sha256: hash(raw),
  runner_environment: { node: process.version, platform: process.platform, arch: process.arch },
  started_at: new Date().toISOString(), cases: [] };
for (const spec of cases) {
  const caseDir = path.join(output, spec.id);
  const evidenceDir = path.join(caseDir, "evidence");
  const workspace = path.join(caseDir, "workspace");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(workspace);
  const input = path.join(caseDir, "input.json");
  const resultPath = path.join(caseDir, "observations.json");
  await fs.writeFile(input, JSON.stringify({ spec, workspace, evidenceDir }, null, 2));
  const log = await fs.open(path.join(caseDir, "driver.log"), "wx");
  let timedOut = false;
  let spawnError = null;
  const child = spawn(process.execPath, [path.join(root, "scripts/acceptance-worker.mjs"), driver, input, resultPath], {
    cwd: root, stdio: ["ignore", log.fd, log.fd], detached: process.platform !== "win32"
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch { /* Result still records timeout. */ }
  }, spec.timeout_ms);
  const exitCode = await new Promise(resolve => {
    child.once("error", error => { spawnError = error.message; resolve(null); });
    child.once("close", code => resolve(code));
  });
  clearTimeout(timer);
  await log.close();
  const entry = { id: spec.id, mode: spec.mode, status: "failed", assertions: [], evidence: [], errors: [] };
  try {
    if (exitCode === 2 && !timedOut && !spawnError) { entry.status = "not_implemented"; throw new Error("NOT_IMPLEMENTED: product driver does not implement this case"); }
    if (spawnError || timedOut || exitCode !== 0) throw new Error(spawnError || (timedOut ? "driver timeout" : "driver exit " + exitCode));
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (result.provenance?.kind !== spec.mode || !result.provenance?.product_version) throw new Error("Missing or mismatched provenance");
    entry.provenance = result.provenance;
    for (const assertion of spec.assertions) {
      const actual = lookup(result.observations, assertion.path);
      entry.assertions.push({ ...assertion, actual: actual === undefined ? { missing: true } : actual,
        passed: assertion.op === "eq" && isDeepStrictEqual(actual, assertion.expected) });
    }
    const realEvidenceDir = await fs.realpath(evidenceDir);
    for (const name of spec.evidence) {
      const matches = (result.evidence || []).filter(e => e.name === name);
      if (matches.length !== 1) throw new Error("Missing or duplicate evidence: " + name);
      const real = await fs.realpath(path.resolve(matches[0].path));
      if (!real.startsWith(realEvidenceDir + path.sep)) throw new Error("Evidence outside case evidence directory: " + name);
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size === 0) throw new Error("Empty/non-file evidence: " + name);
      entry.evidence.push({ name, path: path.relative(output, real), bytes: stat.size, sha256: hash(await fs.readFile(real)) });
    }
    entry.status = entry.assertions.every(a => a.passed) ? "passed" : "failed";
  } catch (error) { entry.errors.push(error.message); }
  report.cases.push(entry);
  console.log(spec.id + " " + entry.status.toUpperCase());
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
report.finished_at = new Date().toISOString();
report.passed = report.cases.length === cases.length && report.cases.every(c => c.status === "passed");
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("Report: " + path.join(output, "report.json"));
process.exitCode = report.passed ? 0 : report.cases.some(c => c.status === "failed") ? 1 : 2;
