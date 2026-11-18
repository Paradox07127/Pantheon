import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { EnvironmentCheck as Check, ProjectBaseline } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { type HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'ev' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/data/app-settings', () => ({ useAppSettings: () => ({ settings: null }) }));
import { EnvironmentCheck, type PlannedCommands } from '@/components/EnvironmentCheck';
import { useBoard } from '@/data/board';
import { durationText } from '@/lib/time-text';
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { Button } from '@/screens/projects/parts';
import { ProjectGate } from '@/screens/settings/GatesPage';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const ROOT = '/work/alpha';
const env = (id: string, values?: Record<string, string | number>) =>
  values ? zhf(`components.environment.${id}`, values) : zh(`components.environment.${id}`);
// Each test reads its own project, so no cached read of another test shows.
let project_id = '';
let tests = 0;

const bridge = {
  checks: [] as Check[],
  queries: [] as { method: string; params: Record<string, string> }[],
  replies: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    if (method === 'project.environment.checks') return { ok: true, value: bridge.checks };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.replies.shift() ?? { ok: true, value: [] };
  },
};

const lint = { name: 'lint', argv: ['pnpm', 'lint'] };
const test = { name: 'test', argv: ['pnpm', 'test'] };
const build = { name: 'build', argv: ['pnpm', 'build'] };
const planned = (root = ROOT): PlannedCommands => [{ root, commands: [lint, test, build] }];

const check = (patch: Partial<Check> = {}): Check => ({
  id: `check-${patch.root ?? ROOT}`,
  revision: 2,
  project_id,
  root: ROOT,
  commit: '4f68ad1e0c',
  cause: { kind: 'user' },
  state: 'passed',
  commands: [
    {
      name: 'setup',
      argv: ['pnpm', 'install'],
      exit_code: 0,
      duration_ms: 38_000,
      output_tail: '',
    },
    { ...lint, exit_code: 0, duration_ms: 14_000, output_tail: 'clean' },
    { ...test, exit_code: 0, duration_ms: 112_000, output_tail: 'ok' },
    { ...build, exit_code: 0, duration_ms: 48_000, output_tail: 'built' },
  ],
  started_at: Date.now() - 300_000,
  finished_at: Date.now() - 100_000,
  ...patch,
});
const failedCheck = (patch: Partial<Check> = {}) =>
  check({
    state: 'failed',
    reason_code: 'checks_failed',
    commands: [
      {
        name: 'setup',
        argv: ['pnpm', 'install'],
        exit_code: 0,
        duration_ms: 38_000,
        output_tail: '',
      },
      { ...lint, exit_code: 0, duration_ms: 14_000, output_tail: 'clean' },
      {
        ...test,
        exit_code: 1,
        duration_ms: 112_000,
        output_tail: 'AssertionError: expected 1250 to be 1200',
        failure_class: 'code',
      },
    ],
    ...patch,
  });

async function show(props: Partial<Parameters<typeof EnvironmentCheck>[0]> = {}) {
  const h = mount(() => EnvironmentCheck({ project_id, planned: planned(), ...props }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const run = (h: HookHost<any>) =>
  find(tree(h), (n) => n.type === 'button' && [env('check'), env('again')].includes(text(n)));
const roots = (h: HookHost<any>) =>
  nodes(tree(h)).filter(
    (n) => n.props.role === 'group' && n.props['aria-label']?.includes('/work/'),
  );
const rows = (t: ReactNode) =>
  nodes(find(t, (n) => n.type === 'ul').props.children).filter((n) => n.type === 'li');
const glyphOf = (row: ReactElement<any>) =>
  find(row, (n) => n.props.role === 'img').props['aria-label'];
const press = async (h: HookHost<any>) => {
  run(h).props.onClick();
  await h.flush();
};

beforeEach(() => {
  project_id = `alpha-${++tests}`;
  bridge.checks = [];
  bridge.queries = [];
  bridge.replies = [];
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null, events: [] } as never);
});

describe('the environment check', () => {
  it('offers a first check of every root and sends it without a root', async () => {
    const h = await show();
    expect(text(run(h))).toBe(env('check'));
    expect(run(h).props.disabled).toBe(false);
    expect(rows(tree(h)).map(glyphOf)).toEqual([env('notRun'), env('notRun'), env('notRun')]);
    await press(h);
    expect(bridge.commands).toMatchObject([
      { type: 'project.environment.verify', input: { project_id }, expected_revision: null },
    ]);
  });

  it('lists each command of the newest check with its state and time, and the failed one with its log', async () => {
    bridge.checks = [failedCheck(), check({ id: 'older', started_at: 1, finished_at: 2 })];
    const h = await show();
    expect(text(run(h))).toBe(env('again'));
    const [root] = roots(h);
    expect(root!.props['aria-label']).toBe(env('root', { root: ROOT, state: env('failed') }));
    expect(text(root)).toContain('4f68ad1');
    expect(text(root)).not.toContain('4f68ad1e');
    const listed = rows(root);
    expect(listed.map((row) => text(row).split('pnpm')[0])).toEqual([
      'setup',
      'lint',
      'test',
      'build',
    ]);
    expect(listed.map(glyphOf)).toEqual([
      env('passed'),
      env('passed'),
      env('failedExit', { code: 1 }),
      env('notRun'),
    ]);
    expect(text(listed[1])).toContain(durationText(14_000));
    expect(text(listed[2])).toContain(durationText(112_000));
    expect(text(listed[3])).toContain(env('notRun'));
    const log = labelled(listed[2], env('log', { name: 'test' }));
    expect(log.type).toBe('pre');
    expect(text(log)).toBe('AssertionError: expected 1250 to be 1200');
    expect(text(listed[2])).toContain(env('failsOnCode'));
    for (const row of [listed[0], listed[1]])
      expect(nodes(row).filter((n) => n.type === 'pre')).toEqual([]);
  });

  it.each([
    [
      'a setup that failed',
      { state: 'failed', reason_code: 'setup_failed' } satisfies Partial<Check>,
      'setupFailed',
      null,
    ],
    [
      'a command that fails on the machine',
      { state: 'inconclusive', reason_code: 'checks_environment' } satisfies Partial<Check>,
      'inconclusive',
      null,
    ],
    [
      'a check Pantheon restarted under',
      {
        state: 'inconclusive',
        reason_code: 'daemon_restart',
        commands: [],
      } satisfies Partial<Check>,
      'inconclusive',
      'restarted',
    ],
  ])('names %s on its root', async (_, patch, word, note) => {
    bridge.checks = [failedCheck(patch)];
    const h = await show();
    const [root] = roots(h);
    expect(root!.props['aria-label']).toBe(env('root', { root: ROOT, state: env(word) }));
    if (note) expect(text(root)).toContain(env(note));
  });

  it('names a command that fails on the machine', async () => {
    bridge.checks = [
      failedCheck({
        state: 'inconclusive',
        reason_code: 'checks_environment',
        commands: [
          {
            ...lint,
            exit_code: 127,
            duration_ms: 2000,
            output_tail: 'eslint: not found',
            failure_class: 'environment',
          },
        ],
      }),
    ];
    const h = await show();
    expect(text(rows(tree(h))[0])).toContain(env('failsOnMachine'));
  });

  it('holds the button while a check runs and shows the root running', async () => {
    bridge.checks = [
      check({ state: 'running', commands: [], commit: undefined, finished_at: undefined }),
    ];
    const h = await show();
    expect(run(h).props.disabled).toBe(true);
    const [root] = roots(h);
    expect(root!.props['aria-busy']).toBe(true);
    expect(text(root)).toContain(env('running'));
    expect(nodes(root).filter((n) => n.type === 'ul')).toEqual([]);
  });

  it('reads the checks again when a check of the project ends', async () => {
    const h = await show();
    const reads = () => bridge.queries.filter((q) => q.method === 'project.environment.checks');
    expect(reads()).toHaveLength(1);
    bridge.checks = [check()];
    useBoard.setState({
      events: [{ kind: 'environment.check_finished', project_id, sequence: 7 }],
    } as never);
    h.render();
    await h.flush();
    expect(reads()).toHaveLength(2);
    expect(roots(h)[0]!.props['aria-label']).toBe(
      env('root', { root: ROOT, state: env('passed') }),
    );
  });

  it('turns the button off with its reason when the project has no gate commands', async () => {
    const h = await show({ planned: [{ root: ROOT, commands: [] }] });
    const button = run(h);
    expect(button.props.disabled).toBe(true);
    const why = find(tree(h), (n) => n.props.id === button.props['aria-describedby']);
    expect(text(why)).toBe(env('noCommands'));
  });

  it('says under the button that a check of the project already runs', async () => {
    bridge.checks = [check()];
    bridge.replies.push({ ok: false, error: { code: 'resource_busy', message: 'running' } });
    const h = await show();
    await press(h);
    // The block's own parts in order: its head with the button, then what stands under it.
    const parts = ([] as unknown[])
      .concat((tree(h) as ReactElement<any>).props.children)
      .filter((n): n is ReactElement<any> => !!n && typeof n === 'object');
    expect(parts[1]!.props.role).toBe('alert');
    expect(text(parts[1])).toBe(env('busy'));
    expect(run(h).props['aria-describedby']).toBe(parts[1]!.props.id);
  });

  it('puts the failed root first among three, counts it, and folds the roots that passed', async () => {
    const roots3 = ['/work/alpha', '/work/web', '/work/sdk'];
    bridge.checks = [
      check({ root: '/work/web' }),
      failedCheck({ root: '/work/sdk' }),
      check({ root: '/work/alpha' }),
    ];
    const h = await show({ planned: roots3.flatMap((root) => planned(root)) });
    expect(roots(h).map((n) => n.props['aria-label'])).toEqual([
      env('root', { root: '/work/sdk', state: env('failed') }),
      env('root', { root: '/work/alpha', state: env('passed') }),
      env('root', { root: '/work/web', state: env('passed') }),
    ]);
    expect(text(tree(h))).toContain(env('rootsFailed', { failed: 1, total: 3 }));
    const passed = () => roots(h)[1]!;
    expect(nodes(passed()).filter((n) => n.type === 'ul')).toEqual([]);
    const open = labelled(passed(), env('show', { count: 4, root: '/work/alpha', passed: 4 }));
    expect(open.props['aria-expanded']).toBe(false);
    open.props.onClick();
    await h.flush();
    expect(rows(passed())).toHaveLength(4);
  });
});

describe('the environment check of a baseline', () => {
  const baseline = (patch: Partial<ProjectBaseline> = {}): ProjectBaseline => ({
    id: 'baseline-1',
    revision: 4,
    project_id,
    state: 'submitted',
    session_id: 'session-1',
    runtime: 'claude',
    dropped: 0,
    facts_id: 'facts-1',
    created_at: 1,
    result: {
      folders: [
        {
          root: ROOT,
          stage: 'active',
          gate: [{ ...test, sources: [] }],
          commands: {
            build: { argv: build.argv, sources: [] },
            test: { argv: test.argv, sources: [] },
          },
        },
      ],
      workstreams: [],
      contradictions: [],
      findings: [],
      questions: [],
    } as never,
    ...patch,
  });
  const ofBaseline = (attempt: 1 | 2, patch: Partial<Check> = {}) =>
    check({ cause: { kind: 'baseline', baseline_id: 'baseline-1', attempt }, ...patch });

  it('reads and runs the checks of the baseline', async () => {
    const h = await show({ baseline: baseline() });
    expect(bridge.queries.at(-1)).toEqual({
      method: 'project.environment.checks',
      params: { project_id, baseline_id: 'baseline-1' },
    });
    await press(h);
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id, baseline_id: 'baseline-1' },
    ]);
  });

  it('says the baseline agent is fixing the failed command and opens its conversation', async () => {
    bridge.checks = [
      failedCheck({ cause: { kind: 'baseline', baseline_id: 'baseline-1', attempt: 1 } }),
    ];
    const onOpenSession = vi.fn();
    const h = await show({
      onOpenSession,
      baseline: baseline({
        environment: {
          check_ids: ['check-/work/alpha'],
          fix_requested_at: Date.now(),
          commands: [
            { root: ROOT, name: 'test', state: 'failed' },
            { root: ROOT, name: 'build', state: 'not_run' },
          ],
        },
      }),
    });
    expect(text(tree(h))).toContain(env('fresh'));
    expect(text(tree(h))).toContain(env('fixing', { name: 'test' }));
    find(
      tree(h),
      (n) => n.type === 'button' && text(n) === env('viewConversation'),
    ).props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });

  it('says the commands passed after the fix', async () => {
    bridge.checks = [
      ofBaseline(2),
      failedCheck({
        id: 'first',
        cause: { kind: 'baseline', baseline_id: 'baseline-1', attempt: 1 },
        started_at: 1,
      }),
    ];
    const h = await show({
      baseline: baseline({
        environment: { check_ids: [], fix_requested_at: 5, commands: [] },
      }),
    });
    expect(text(tree(h))).toContain(env('fixed'));
    expect(text(tree(h))).not.toContain(env('fixing', { name: 'test' }));
  });
});

describe('where the environment check is drawn', () => {
  it('stands first on the gates page with the enabled gate commands of each root', async () => {
    const project = {
      id: project_id,
      revision: 1,
      name: 'Alpha',
      roots: [ROOT],
      gates: { [ROOT]: [lint, { ...test, enabled: false }] },
    };
    const h = mount(() => ProjectGate({ project } as never));
    await h.flush();
    const [first] = nodes((tree(h) as ReactElement<any>).props.children);
    expect(first!.type).toBe(EnvironmentCheck);
    expect(first!.props.project_id).toBe(project_id);
    expect(first!.props.planned).toEqual([{ root: ROOT, commands: [lint] }]);
  });

  it('stands on the submitted baseline with its proposed commands and leaves confirming open after a failure', async () => {
    const submitted = {
      id: 'baseline-1',
      revision: 4,
      project_id,
      state: 'submitted',
      session_id: 'session-1',
      dropped: 0,
      facts_id: 'facts-1',
      created_at: 1,
      environment: {
        check_ids: ['c1'],
        commands: [{ root: ROOT, name: 'test', state: 'failed' }],
      },
      result: {
        folders: [
          {
            root: ROOT,
            stage: 'active',
            gate: [{ ...test, sources: [] }],
            commands: {
              build: { argv: build.argv, sources: [] },
              test: { argv: test.argv, sources: [] },
            },
          },
        ],
        workstreams: [],
        contradictions: [],
        findings: [],
        questions: [],
      },
    };
    const onOpenSession = vi.fn();
    const h = mount(() => ReviewBaseline({ baseline: submitted as never, onOpenSession }));
    await h.flush();
    const block = find(tree(h), (n) => n.type === EnvironmentCheck);
    expect(block.props.baseline).toBe(submitted);
    expect(block.props.onOpenSession).toBe(onOpenSession);
    expect(block.props.planned).toEqual([{ root: ROOT, commands: [test, build] }]);
    const confirm = find(
      tree(h),
      (n) => n.type === Button && n.props.label === zh('projects.baseline.confirmBaseline'),
    );
    expect(confirm.props.busy).toBe(false);
    expect(confirm.props.state).toBeUndefined();
  });
});
