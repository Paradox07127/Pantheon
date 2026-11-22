import { expect, it } from 'vitest';
import { inputSchemas, querySchemas, userConfigSchema } from '@pantheon/protocol';

const schemas: Record<string, { safeParse(value: unknown): { success: boolean } }> = inputSchemas;

it('accepts the git init switch, a runtime binary and the Claude artifacts switch in the user config, and turns off an ACP runtime, and refuses an unknown setting of a runtime', () => {
  expect(
    userConfigSchema.safeParse({
      version: 1,
      auto_git_init: true,
      runtimes: { claude: { binary: '/opt/claude/bin/claude', args: ['--verbose'] } },
    }).success,
  ).toBe(true);
  expect(
    userConfigSchema.safeParse({ version: 1, runtimes: { claude: { artifacts: false } } }).success,
  ).toBe(true);
  expect(
    schemas['runtime.config.set']!.safeParse({ runtime: 'claude', artifacts: false }).success,
  ).toBe(true);
  expect(
    userConfigSchema.safeParse({ version: 1, runtimes: { grok: { enabled: false } } }).success,
  ).toBe(true);
  expect(
    userConfigSchema.safeParse({
      version: 1,
      runtimes: { grok: { binary: '/opt/grok', model: 'x' } },
    }).success,
  ).toBe(false);
});

it('refuses an adopted session without a native id or with an unknown runtime', () => {
  const adopt = schemas['session.adopt'];
  expect(adopt).toBeDefined();
  const input = { project_id: 'project', runtime: 'claude', native_session_id: 'native-1' };
  expect(adopt!.safeParse(input).success).toBe(true);
  const { native_session_id: _missing, ...withoutNative } = input;
  expect(adopt!.safeParse(withoutNative).success).toBe(false);
  expect(adopt!.safeParse({ ...input, runtime: 'grok' }).success).toBe(false);
});

it('lists the runtime status, app settings and import queries', () => {
  for (const method of [
    'runtime.status',
    'app.settings',
    'import.candidates',
    'session.importable',
  ])
    expect(Object.keys(querySchemas)).toContain(method);
});

it('accepts the merge archive switch independently and the session pull retry', () => {
  expect(userConfigSchema.safeParse({ version: 1, auto_archive_merged: true }).success).toBe(true);
  expect(inputSchemas['app.settings.set'].safeParse({ auto_archive_merged: true }).success).toBe(
    true,
  );
  expect(inputSchemas['app.settings.set'].safeParse({ auto_git_init: false }).success).toBe(true);
  expect(inputSchemas['app.settings.set'].safeParse({ auto_archive_merged: 'yes' }).success).toBe(
    false,
  );
  expect(schemas['session.reconnect']?.safeParse({ session_id: 'remote-session' }).success).toBe(
    true,
  );
});

it('accepts a baseline start with a runtime, model and effort', () => {
  const start = { project_id: 'project', runtime: 'codex', model: 'gpt-5-mini', effort: 'low' };
  expect(inputSchemas['project.baseline.start'].parse(start)).toEqual(start);
  expect(schemas['project.baseline.start']!.safeParse({ ...start, effort: 'huge' }).success).toBe(
    false,
  );
});

const folder = {
  root: '/repo',
  gate: [{ name: 'test', argv: ['pnpm', 'test'], sources: ['file:package.json'] }],
  setup: { argv: ['pnpm', 'install'], sources: ['file:package.json'] },
};
it.each([
  [
    'a folder with its gate and setup',
    'project.baseline.submit',
    { baseline_id: 'baseline', folders: [folder] },
    true,
  ],
  [
    'a folder without git and its empty gate',
    'project.baseline.submit',
    { baseline_id: 'baseline', folders: [{ root: '/notes', gate: [] }] },
    true,
  ],
  ['no folders', 'project.baseline.submit', { baseline_id: 'baseline', folders: [] }, false],
  [
    'a gate command without sources',
    'project.baseline.submit',
    {
      baseline_id: 'baseline',
      folders: [{ ...folder, gate: [{ name: 'test', argv: ['pnpm', 'test'], sources: [] }] }],
    },
    false,
  ],
  [
    'a gate command with a timeout the model wrote',
    'project.baseline.submit',
    {
      baseline_id: 'baseline',
      folders: [{ ...folder, gate: [{ ...folder.gate[0], timeout_ms: 1000 }] }],
    },
    false,
  ],
  [
    'a folder with the retired stage',
    'project.baseline.submit',
    { baseline_id: 'baseline', folders: [{ ...folder, stage: 'active' }] },
    false,
  ],
  [
    'a project-wide assessment',
    'project.baseline.submit',
    { baseline_id: 'baseline', folders: [folder], workstreams: [], questions: [] },
    false,
  ],
  ['a confirmation without gates', 'project.baseline.confirm', { baseline_id: 'baseline' }, true],
  [
    'a confirmation with the gates the user kept',
    'project.baseline.confirm',
    {
      baseline_id: 'baseline',
      gates: [
        { root: '/repo', commands: [{ name: 'test', argv: ['pnpm', 'test'], timeout_ms: 60000 }] },
      ],
    },
    true,
  ],
  [
    'a confirmation with answers',
    'project.baseline.confirm',
    { baseline_id: 'baseline', answers: [] },
    false,
  ],
  ['baseline rounds, no longer a setting', 'app.settings.set', { baseline_rounds: 3 }, false],
])('%s in %s parses: %s', (_name, type, input, ok) => {
  expect(schemas[type]?.safeParse(input).success).toBe(ok);
});
