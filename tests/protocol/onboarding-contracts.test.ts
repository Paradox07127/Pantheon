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

it('accepts a baseline start with a runtime, model and effort and a submission without next tasks', () => {
  const start = { project_id: 'project', runtime: 'codex', model: 'gpt-5-mini', effort: 'low' };
  expect(inputSchemas['project.baseline.start'].parse(start)).toEqual(start);
  expect(schemas['project.baseline.start']!.safeParse({ ...start, effort: 'huge' }).success).toBe(
    false,
  );
  const submission = {
    baseline_id: 'baseline',
    workstreams: [],
    contradictions: [],
    findings: [],
    questions: [],
  };
  expect(inputSchemas['project.baseline.submit'].parse(submission).tasks).toEqual([]);
  const task = {
    id: 'json',
    title: 'Parse JSON rows',
    workstream: 'importer',
    why: 'JSON parsing is open',
    scope: ['src'],
    acceptance: ['pnpm build'],
    depends_on: [],
    sources: ['file:TODO.md:5'],
  };
  const submit = schemas['project.baseline.submit']!;
  expect(submit.safeParse({ ...submission, tasks: [task] }).success).toBe(true);
  expect(submit.safeParse({ ...submission, tasks: [{ ...task, scope: [] }] }).success).toBe(false);
});

const emptySubmission = {
  baseline_id: 'baseline',
  workstreams: [],
  contradictions: [],
  findings: [],
};
const scopeQuestion = {
  id: 'scope',
  header: 'Scope',
  question: 'Is publishing in scope?',
  options: [
    { label: 'Yes', description: 'Publish to npm' },
    {
      label: 'No',
      description: 'Keep it internal',
      preview: { kind: 'mermaid', spec: { source: 'graph LR; a-->b' } },
    },
  ],
  multiSelect: false,
  recommended: 'No',
};
it.each([
  [
    'a question card',
    'project.baseline.submit',
    { ...emptySubmission, questions: [scopeQuestion] },
    true,
  ],
  [
    'a recommended label that names no option',
    'project.baseline.submit',
    { ...emptySubmission, questions: [{ ...scopeQuestion, recommended: 'Maybe' }] },
    false,
  ],
  [
    'six questions',
    'project.baseline.submit',
    {
      ...emptySubmission,
      questions: Array.from({ length: 6 }, (_, i) => ({ ...scopeQuestion, id: `q${i}` })),
    },
    false,
  ],
  [
    'a continued round with the answers so far',
    'project.baseline.continue',
    {
      baseline_id: 'baseline',
      answers: [
        { question_id: 'scope', question: 'Is publishing in scope?', answer: 'No', by: 'user' },
        { question_id: 'stack', question: 'Which stack?', answer: '', by: 'model' },
      ],
    },
    true,
  ],
  ['six baseline rounds', 'app.settings.set', { baseline_rounds: 6 }, false],
  ['three baseline rounds', 'app.settings.set', { baseline_rounds: 3 }, true],
])('%s in %s parses: %s', (_name, type, input, ok) => {
  expect(schemas[type]?.safeParse(input).success).toBe(ok);
});
