import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps docs/api.md in step with the protocol schemas', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/api-doc.mjs', import.meta.url)),
    '--check',
  ]);
});

it('wraps a list of a union in parentheses', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/api.md', import.meta.url)), 'utf8');
  const row = (name: string) => doc.split('\n').find((line) => line.startsWith(`| \`${name}\` |`));
  expect(row('workflow.policy.set')).toContain(
    '`pinned?`: ("path" \\| "acceptance_wake" \\| "max_parallel" \\| "handback_limit" \\| "task_size_hint" \\| "runtime_quota_threshold" \\| "budget")[]',
  );
  expect(row('session.send')).toContain('`refs?`: (object \\| object)[]');
  expect(row('session.send')).toContain('`attachments?`: string[]');
});
