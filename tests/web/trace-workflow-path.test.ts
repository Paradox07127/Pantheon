import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult, ProjectGateRun, WorkflowPolicyView } from '@pantheon/protocol';
import { SPAWNED_SESSION_LIMIT } from '@pantheon/protocol';
import { find, mount, nodes, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { EnvironmentCheck } from '@/components/EnvironmentCheck';
import { GraphDiagram } from '@/components/visual/GraphDiagram';
import { useBoard } from '@/data/board';
import { dayText } from '@/lib/time-text';
import { approveNode, gateNode, WorkflowPath, workflowPath } from '@/screens/trace/WorkflowPath';

type Project = Parameters<typeof workflowPath>[0];
type Spec = ReturnType<typeof workflowPath>;

const WEB = '/work/web';
const API = '/work/api';
const NOW = new Date(2026, 10, 26, 15, 0).getTime();

const project = (patch: Partial<Project> = {}): Project => ({
  id: 'alpha',
  revision: 4,
  name: 'Alpha app',
  roots: [WEB, API],
  gates: {
    [WEB]: [
      { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
      { name: 'lint', argv: ['pnpm', 'lint'], enabled: false },
      { name: 'unit tests', argv: ['pnpm', 'test', '--run'] },
    ],
    [API]: [{ name: 'go test', argv: ['go', 'test', './...'] }],
  },
  ...patch,
});

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicyView => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  defaults: {},
  ...patch,
});

const run = (
  finished: number,
  results: { name: string; command: string[]; exit_code?: number; skipped?: true }[],
): ProjectGateRun => ({
  run_id: `run-${finished}`,
  commit: 'abc1234',
  started_at: new Date(finished - 60_000).toISOString(),
  finished_at: new Date(finished).toISOString(),
  results,
});

const webPassed = (at: number) =>
  run(at, [
    { name: 'typecheck', command: ['pnpm', 'typecheck'], exit_code: 0 },
    { name: 'unit tests', command: ['pnpm', 'test', '--run'], exit_code: 0 },
  ]);
// The daemon lists the commands after a failure as skipped.
const webFailed = (at: number) =>
  run(at, [
    { name: 'typecheck', command: ['pnpm', 'typecheck'], exit_code: 2 },
    { name: 'unit tests', command: ['pnpm', 'test', '--run'], skipped: true },
  ]);

const node = (spec: Spec, id: string) => spec.nodes.find((n) => n.id === id);
const at = (time: number) => dayText(time, NOW, { time: true });

describe('the workflow path', () => {
  it('draws the steps from starting a session to landing, left to right', () => {
    const spec = workflowPath(project(), policy(), [], NOW);
    expect(spec.direction).toBe('LR');
    expect(spec.nodes.map((n) => n.label)).toEqual([
      zh('trace.workflow.start'),
      zh('trace.workflow.review'),
      WEB,
      API,
      zh('trace.workflow.land'),
    ]);
  });

  it('gives each folder its gate, with its turned-on commands in order, the runner and what follows a failure', () => {
    const spec = workflowPath(
      project(),
      policy({ gate_runner: 'session', gate_on_fail: 'retry' }),
      [],
      NOW,
    );
    expect(node(spec, gateNode(WEB))?.detail).toEqual([
      'pnpm typecheck',
      'pnpm test --run',
      zh('trace.workflow.gate.runner.session'),
      zh('trace.workflow.gate.onFail.retry'),
    ]);
    expect(node(spec, gateNode(API))?.detail).toEqual([
      'go test ./...',
      zh('trace.workflow.gate.runner.session'),
      zh('trace.workflow.gate.onFail.retry'),
    ]);
  });

  it('reads an unset runner and failure choice as the daemon and stopping', () => {
    const spec = workflowPath(project(), policy(), [], NOW);
    expect(node(spec, gateNode(API))?.detail).toEqual([
      'go test ./...',
      zh('trace.workflow.gate.runner.daemon'),
      zh('trace.workflow.gate.onFail.stop'),
    ]);
  });

  it('writes no gate for a folder without turned-on commands', () => {
    const spec = workflowPath(
      project({
        gates: { [WEB]: [{ name: 'lint', argv: ['pnpm', 'lint'], enabled: false }] },
      }),
      policy(),
      [],
      NOW,
    );
    expect(node(spec, gateNode(WEB))?.detail).toEqual([zh('trace.workflow.gate.none')]);
    expect(node(spec, gateNode(API))?.detail).toEqual([zh('trace.workflow.gate.none')]);
  });

  it("shows each folder's newest recorded result and none for a folder without a record", () => {
    const older = NOW - 3_600_000;
    const newer = NOW - 600_000;
    const spec = workflowPath(project(), policy(), [webPassed(older), webFailed(newer)], NOW);
    const web = node(spec, gateNode(WEB))!;
    expect(web.status).toBe('failed');
    expect(web.detail?.at(-1)).toBe(zhf('trace.workflow.gate.lastFailed', { at: at(newer) }));
    const api = node(spec, gateNode(API))!;
    expect(api).not.toHaveProperty('status');
    expect(api.detail?.at(-1)).toBe(zh('trace.workflow.gate.onFail.stop'));

    const passed = workflowPath(project(), policy(), [webPassed(newer), webFailed(older)], NOW);
    expect(node(passed, gateNode(WEB))?.status).toBe('done');
    expect(node(passed, gateNode(WEB))?.detail?.at(-1)).toBe(
      zhf('trace.workflow.gate.lastPassed', { at: at(newer) }),
    );
  });

  it.each([
    ['a passing run of only part of its commands', [['typecheck', ['pnpm', 'typecheck'], 0]]],
    [
      "another folder's failed run whose commands begin the same",
      [['typecheck', ['pnpm', 'typecheck'], 2]],
    ],
    [
      'a run of its commands in another order',
      [
        ['unit tests', ['pnpm', 'test', '--run'], 0],
        ['typecheck', ['pnpm', 'typecheck'], 0],
      ],
    ],
  ] as const)("does not count %s as the folder's last result", (_, results) => {
    const spec = workflowPath(
      project(),
      policy(),
      [
        run(
          NOW - 600_000,
          results.map(([name, command, exit_code]) => ({ name, command: [...command], exit_code })),
        ),
      ],
      NOW,
    );
    expect(node(spec, gateNode(WEB))).not.toHaveProperty('status');
  });

  it('has no approval step without protected paths, and every gate leads to landing', () => {
    const spec = workflowPath(project({ protected_paths: { [WEB]: [] } }), policy(), [], NOW);
    expect(spec.nodes.filter((n) => n.label.startsWith(zh('trace.workflow.approve')))).toEqual([]);
    expect(spec.edges.filter((e) => e.to === 'land').map((e) => e.from)).toEqual([
      gateNode(WEB),
      gateNode(API),
    ]);
  });

  it("waits for you before a protected folder's gate only on the way that changes protected files, and goes straight to the gate of a folder without", () => {
    const spec = workflowPath(
      project({ protected_paths: { [WEB]: ['migrations/**', 'package.json'] } }),
      policy(),
      [],
      NOW,
    );
    expect(spec.edges).toEqual(
      expect.arrayContaining([
        { from: 'start', to: approveNode(WEB), style: 'async' },
        { from: approveNode(WEB), to: gateNode(WEB), style: 'main' },
        { from: 'start', to: gateNode(WEB), style: 'main' },
        { from: gateNode(WEB), to: 'land', style: 'main' },
        { from: 'start', to: gateNode(API), style: 'main' },
        { from: gateNode(API), to: 'land', style: 'main' },
      ]),
    );
    expect(spec.edges.filter((e) => e.from.startsWith('gate:')).map((e) => e.to)).toEqual([
      'land',
      'land',
    ]);
    expect(node(spec, approveNode(API))).toBeUndefined();
  });

  it("gives each protected folder its own approval step with that folder's paths", () => {
    const spec = workflowPath(
      project({
        protected_paths: { [WEB]: ['migrations/**', 'package.json'], [API]: ['go.mod'] },
      }),
      policy(),
      [],
      NOW,
    );
    expect(node(spec, approveNode(WEB))).toMatchObject({
      label: zhf('trace.workflow.approve.root', { root: WEB }),
      detail: ['migrations/**', 'package.json'],
    });
    expect(node(spec, approveNode(API))).toMatchObject({
      label: zhf('trace.workflow.approve.root', { root: API }),
      detail: ['go.mod'],
    });

    const single = workflowPath(
      project({ roots: [WEB], protected_paths: { [WEB]: ['package.json'] } }),
      policy(),
      [],
      NOW,
    );
    expect(node(single, approveNode(WEB))).toMatchObject({
      label: zh('trace.workflow.approve'),
      detail: ['package.json'],
    });
  });

  it('draws review as an optional way beside the edge that skips it', () => {
    const spec = workflowPath(
      project({ protected_paths: { [WEB]: ['package.json'] } }),
      policy(),
      [],
      NOW,
    );
    expect(spec.edges).toEqual(
      expect.arrayContaining([
        { from: 'start', to: 'review', style: 'async' },
        { from: 'review', to: approveNode(WEB), style: 'async' },
        { from: 'review', to: gateNode(API), style: 'async' },
        { from: 'start', to: approveNode(WEB), style: 'async' },
        { from: 'start', to: gateNode(WEB), style: 'main' },
        { from: 'start', to: gateNode(API), style: 'main' },
      ]),
    );
  });

  it('shows the default limit of spawned sessions when none is set, and the set one otherwise', () => {
    const start = (p: WorkflowPolicyView) => node(workflowPath(project(), p, [], NOW), 'start')!;
    expect(start(policy()).detail?.[0]).toBe(
      zhf('trace.workflow.start.max', { count: SPAWNED_SESSION_LIMIT }),
    );
    expect(start(policy({ max_spawned: 7 })).detail?.[0]).toBe(
      zhf('trace.workflow.start.max', { count: 7 }),
    );
  });

  it('names the runtimes with a limit and counts the routes by kind', () => {
    const start = node(
      workflowPath(
        project(),
        policy({
          runtime_parallel: { codex: 2 },
          kind_routes: [
            { kind: 'docs', runtime: 'codex' },
            { kind: 'tests', runtime: 'claude' },
          ],
        }),
        [],
        NOW,
      ),
      'start',
    )!;
    expect(start.detail?.slice(1)).toEqual([
      zhf('trace.workflow.start.runtime', { runtime: 'Codex', count: 2 }),
      zhf('trace.workflow.start.routes', { count: 2 }),
    ]);
  });

  it.each([
    ['each_session', 'trace.workflow.review.eachSession'],
    ['before_landing', 'trace.workflow.review.beforeLanding'],
    [undefined, 'trace.workflow.review.unset'],
  ] as const)('says when review happens for %s', (timing, id) => {
    const review = node(
      workflowPath(project(), policy(timing ? { verify_timing: timing } : {}), [], NOW),
      'review',
    )!;
    expect(review.detail).toEqual([zh(id)]);
  });
});

describe('the workflow tab', () => {
  const answers: Record<string, unknown> = {};
  const asked: Record<string, unknown> = {};
  beforeEach(() => {
    answers['workflow.policy'] = policy({ max_spawned: 3 });
    answers['project.gates.history'] = { runs: [webPassed(NOW)] };
    answers['project.environment.checks'] = [];
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: {
        async query(method: string, params: unknown): Promise<BridgeResult<unknown>> {
          asked[method] = params;
          return method in answers
            ? { ok: true, value: answers[method] }
            : { ok: false, error: { code: 'unknown_route', message: method } };
        },
      },
    });
    useBoard.setState({
      board: { cursor: 1, projects: [project()], sessions: [] },
      status: { state: 'live' },
    } as never);
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    useBoard.setState({ board: null });
  });

  it("draws the project's path and offers the trial run of its gates under it", async () => {
    const h = mount(() => WorkflowPath({ projectId: 'alpha' }) as ReactElement);
    await h.flush();
    const all = nodes(h.value);
    const graph = all.findIndex((n) => n.type === GraphDiagram);
    expect(graph).toBeGreaterThanOrEqual(0);
    const spec = all[graph]!.props.spec as Spec;
    expect(node(spec, 'start')?.detail?.[0]).toBe(zhf('trace.workflow.start.max', { count: 3 }));
    expect(node(spec, gateNode(WEB))?.status).toBe('done');
    expect(all[graph]!.props.styleNames).toEqual({
      main: zh('trace.workflow.edge.direct'),
      async: zh('trace.workflow.edge.optional'),
    });
    const trial = all.findIndex((n) => n.props['aria-label'] === zh('trace.workflow.trial'));
    expect(trial).toBeGreaterThan(graph);
    const check = find(all[trial]!, (n) => n.type === EnvironmentCheck);
    expect(check.props).toEqual({
      project_id: 'alpha',
      planned: [
        {
          root: WEB,
          commands: [
            { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
            { name: 'unit tests', argv: ['pnpm', 'test', '--run'] },
          ],
        },
        { root: API, commands: [{ name: 'go test', argv: ['go', 'test', './...'] }] },
      ],
    });
  });

  it('reads as many recorded gate runs as the history allows for the last results', async () => {
    const h = mount(() => WorkflowPath({ projectId: 'alpha' }) as ReactElement);
    await h.flush();
    expect(asked['project.gates.history']).toEqual({
      project_id: 'alpha',
      since: '0',
      limit: '500',
    });
  });
});
