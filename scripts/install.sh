#!/bin/sh
set -eu

CDPATH= cd "$(dirname "$0")/.."
actual_node=$(node --version)
actual_pnpm=$(pnpm --version)

node - "$actual_node" "$actual_pnpm" <<'NODE'
const { readFileSync } = require('node:fs');
const { engines, packageManager } = JSON.parse(readFileSync('package.json', 'utf8'));
const [actualNode, actualPnpm] = process.argv.slice(2);
const range = /^>=(\d+) <(\d+)$/.exec(engines.node);
const version = /^v(\d+)\.\d+\.\d+$/.exec(actualNode);
const expectedPnpm = packageManager.slice('pnpm@'.length);
let valid = true;
if (!range || !version || +version[1] < +range[1] || +version[1] >= +range[2]) {
  console.error(`Node version mismatch: expected ${engines.node}, actual ${actualNode}`);
  valid = false;
}
if (actualPnpm !== expectedPnpm) {
  console.error(`pnpm version mismatch: expected ${expectedPnpm}, actual ${actualPnpm}`);
  valid = false;
}
if (!valid) process.exit(1);
NODE

pnpm install --frozen-lockfile "$@"
pnpm build
