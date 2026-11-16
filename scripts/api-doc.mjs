// Regenerates the command, query and MCP tool tables in docs/api.md from packages/protocol.
// Usage: node scripts/api-doc.mjs [--check]   (run `pnpm build` first; --check exits 1 when the doc is stale)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// zod is a dependency of packages/protocol only, so it is imported through that package's node_modules.
import { z } from '../packages/protocol/node_modules/zod/index.js';
import {
  coordinationTools,
  inputSchemas,
  querySchemas,
  sessionTools,
} from '../packages/protocol/dist/index.js';

const docPath = fileURLToPath(new URL('../docs/api.md', import.meta.url));
const START = '<!-- api-doc:start -->';
const END = '<!-- api-doc:end -->';

const typeOf = (s) => {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' \\| ');
  if ('const' in s) return JSON.stringify(s.const);
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map(typeOf).join(' \\| ');
  if (s.type === 'array') {
    const item = typeOf(s.items);
    return item.includes(' \\| ') ? `(${item})[]` : `${item}[]`;
  }
  if (Array.isArray(s.type)) return s.type.join(' \\| ');
  return s.type ?? 'object';
};
const objectFields = (json) => {
  const branches = json.anyOf ?? json.oneOf;
  if (branches) return branches.map(objectFields).join('<br>或<br>');
  const props = json.properties ?? {};
  const required = new Set(json.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return json.type === 'object' ? '—' : typeOf(json);
  return names
    .map((n) => `\`${n}${required.has(n) ? '' : '?'}\`: ${typeOf(props[n])}`)
    .join('<br>');
};
const fields = (schema) =>
  objectFields(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));

const tools = new Map();
for (const [role, entries] of Object.entries(sessionTools))
  for (const [tool, cmd] of Object.entries(entries))
    tools.set(cmd, `${tools.has(cmd) ? tools.get(cmd) + ', ' : ''}${tool} (${role})`);
for (const [tool, cmd] of Object.entries(coordinationTools))
  tools.set(cmd, `${tool} (${tools.has(cmd) ? tools.get(cmd) + ', ' : ''}project session)`);

const group = (name) =>
  name
    .split('.')
    .slice(0, name.startsWith('project.') ? 2 : 1)
    .join('.');
const lines = [START, '', '## 命令(`POST /v1/commands`)', ''];
const commandNames = Object.keys(inputSchemas).sort();
for (const g of [...new Set(commandNames.map(group))]) {
  lines.push(`### ${g}`, '', '| type | input | MCP 工具 |', '|---|---|---|');
  for (const name of commandNames.filter((n) => group(n) === g))
    lines.push(`| \`${name}\` | ${fields(inputSchemas[name])} | ${tools.get(name) ?? ''} |`);
  lines.push('');
}
lines.push('## 查询(`GET /v1/<method>?…`)', '', '| method | 参数 |', '|---|---|');
for (const name of Object.keys(querySchemas).sort())
  lines.push(`| \`${name}\` | ${fields(querySchemas[name])} |`);
lines.push('', END);

const doc = fs.readFileSync(docPath, 'utf8');
const begin = doc.indexOf(START);
const end = doc.indexOf(END);
if (begin < 0 || end < begin)
  throw new Error(`docs/api.md is missing the ${START} … ${END} markers`);
const next = doc.slice(0, begin) + lines.join('\n') + doc.slice(end + END.length);
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/api.md is stale; run `pnpm build && node scripts/api-doc.mjs`');
    process.exitCode = 1;
  }
} else fs.writeFileSync(docPath, next);
