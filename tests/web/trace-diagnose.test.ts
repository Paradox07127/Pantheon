import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RuntimeDiagnostics, RuntimeFinding, RuntimeReviewHistory } from '@pantheon/domain';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  shell: {} as any,
  spans: [] as unknown[],
  traceReads: [] as (string | null)[][],
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector?.({ board: { projects: [{ id: 'project-a' }] } }),
    { getState: () => ({ refresh() {} }) },
  ),
}));
vi.mock('@/data/current-project', async (actual) => ({
  ...(await actual<object>()),
  useCurrentProject: Object.assign(
    (selector: (state: { projectId: string | null }) => unknown) =>
      selector({ projectId: 'project-a' }),
    { subscribe: () => () => undefined },
  ),
}));
vi.mock('@/data/trace', () => ({
  useSessionTrace: (projectId: string | null, laneKey: string | null) => {
    mock.traceReads.push([projectId, laneKey]);
    return { data: { spans: mock.spans }, loading: false, error: null, reload() {} };
  },
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { reasonText } from '@/data/needs-you';
import { AnalyzeMenu } from '@/screens/trace/AnalyzeMenu';
import { FindingDetail } from '@/screens/trace/FindingDetail';
import { RuntimePanel, runtimeDuration } from '@/screens/trace/RuntimeDiagnostics';
import { zh } from './i18n-setup.js';

const at = (hours: number, minutes: number, seconds = 0) =>
  new Date(2026, 10, 13, hours, minutes, seconds).getTime();

const finding = (id: string, patch: Partial<RuntimeFinding> = {}): RuntimeFinding => ({
  id,
  kind: 'approval',
  layer: 'human',
  source: 'daemon',
  at: at(10, 30),
  lane_key: `lane-${id}`,
  duration_ms: 360_000,
  evidence_ids: [],
  ...patch,
});

const FINDINGS = [
  finding('f-approval', { ongoing: true }),
  finding('f-queue', {
    kind: 'dispatch_queue',
    layer: 'harness',
    wait_reason: 'upstream',
    duration_ms: 180_000,
    ongoing: true,
  }),
  finding('f-slow', {
    kind: 'slow_tool',
    layer: 'tool',
    tool_category: 'shell',
    duration_ms: 48_200,
    at: at(10, 30, 15),
    started_at: at(10, 29, 27),
    parent_inferred: true,
  }),
];

const diagnostics = (patch: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics => ({
  from: at(9, 0),
  to: at(10, 39),
  events_read: 2318,
  tools_timed: 375,
  tools_untimed: 37,
  partial: false,
  native: 'included',
  findings: FINDINGS,
  ...patch,
});

const REVIEW: RuntimeReviewHistory = {
  session_id: 'analysis-a',
  runtime: 'claude',
  from: at(9, 0),
  to: at(10, 20),
  created_at: at(10, 24),
  state: 'running',
};

let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  command = vi.fn(async () => ({ ok: true, value: { session_id: 'analysis-b' } }));
  mock.shell = { openSession: vi.fn() };
  vi.stubGlobal('window', { pantheon: { command } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function panel(extra: Partial<Parameters<typeof RuntimePanel>[0]> = {}) {
  const props: Parameters<typeof RuntimePanel>[0] = {
    overview: null,
    diagnostics: diagnostics(),
    leads: [{ id: 'lead-a', title: 'lead' }],
    lead: undefined,
    reviews: [REVIEW],
    stale: false,
    titleOf: (lane) => `session of ${lane}`,
    onEvidence: vi.fn(),
    onAllTime: vi.fn(),
    ...extra,
  };
  return { h: mount(() => RuntimePanel(props) as ReactElement<any>), props };
}

const byRole = (tree: unknown, role: string) =>
  nodes(tree as ReactElement).filter((n) => n.props.role === role);
/** A nested part without hooks, rendered from its element. */
const inner = (tree: unknown, name: string) => {
  const element = named(tree as ReactElement, name);
  return (element.type as (props: object) => ReactElement<any>)(element.props);
};
const cells = (row: ReactElement<any>) =>
  [row.props.children]
    .flat()
    .filter(Boolean)
    .map((cell: ReactElement<any>) => text(cell));
const button = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.type === 'button' && text(n.props.children).includes(label));

describe('diagnose findings', () => {
  it('lists the findings under a header of kind, session, reason, duration and time', () => {
    const { h } = panel();
    const head = find(inner(h.value, 'FindingTable'), (n) =>
      String(n.props.className).includes('dg-head'),
    );
    expect(cells(head)).toEqual([
      '',
      zh('trace.diagnose.col.kind'),
      zh('trace.diagnose.col.session'),
      zh('trace.diagnose.col.reason'),
      '',
      zh('trace.diagnose.col.duration'),
      zh('trace.diagnose.col.time'),
    ]);
    const list = find(inner(h.value, 'FindingTable'), (n) => n.props.role === 'listbox');
    expect(list.props['aria-label']).toBe(zh('trace.diagnose.findings'));
    const rows = byRole(list, 'option');
    expect(rows.map(cells)).toEqual([
      [
        '',
        zh('trace.diagnose.kind.approval'),
        'session of lane-f-approval',
        '',
        '',
        '6 分',
        zh('trace.runtime.ongoing'),
      ],
      [
        '',
        zh('trace.diagnose.kind.dispatch'),
        'session of lane-f-queue',
        zh('trace.runtime.wait.upstream'),
        '',
        '3 分',
        zh('trace.runtime.ongoing'),
      ],
      [
        '',
        zh('trace.diagnose.kind.slowTool'),
        'session of lane-f-slow',
        zh('trace.diagnose.category.shell'),
        '',
        '48.2 秒',
        '10:30:15',
      ],
    ]);
    expect(rows.map((row) => row.props['aria-selected'])).toEqual([false, false, false]);
    expect(
      nodes(list)
        .filter((n) => n.props.className === 'meter')
        .map((n) => n.props['aria-label']),
    ).toEqual(['时长是最长一条的 100%', '时长是最长一条的 50%', '时长是最长一条的 13%']);
  });

  it('gives a failed turn its failure as the reason, whole in the title', () => {
    const error = 'SessionStartError: Protocol transport closed';
    const failed = finding('f-turn', {
      kind: 'turn_failure',
      layer: 'runtime',
      duration_ms: undefined,
      error,
    });
    const { h } = panel({ diagnostics: diagnostics({ findings: [failed] }) });
    const [row] = byRole(inner(h.value, 'FindingTable'), 'option');
    expect(cells(row!)).toEqual([
      '',
      zh('trace.diagnose.kind.turnFailure'),
      'session of lane-f-turn',
      error,
      '',
      '—',
      '10:30:00',
    ]);
    expect(find(row!, (n) => text(n) === error && n.props.title !== undefined).props.title).toBe(
      error,
    );
  });

  it.each([
    [30, '30 毫秒'],
    [187, '187 毫秒'],
    [58_900, '58.9 秒'],
    [59_960, '1 分'],
    [61_000, '1 分'],
  ])('prints a duration of %d ms in the column as %s', (ms, shown) => {
    expect(runtimeDuration(ms)).toBe(shown);
  });

  it('keeps no heading, coverage line or pickers of its own', () => {
    const { h } = panel();
    expect(nodes(h.value).some((n) => n.type === 'select' || n.type === 'h2')).toBe(false);
    expect(text(h.value)).not.toContain('运行时阻塞');
  });

  it('selects a finding when its row is pressed and shows its detail beside the list', () => {
    const { h, props } = panel();
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'FindingDetail')).toBe(false);
    byRole(inner(h.value, 'FindingTable'), 'option')[2]!.props.onClick();
    h.render();
    expect(
      byRole(inner(h.value, 'FindingTable'), 'option').map((row) => row.props['aria-selected']),
    ).toEqual([false, false, true]);
    const detail = named(h.value, 'FindingDetail');
    expect(detail.props.finding).toBe(FINDINGS[2]);
    expect(detail.props.title).toBe('session of lane-f-slow');
    expect(props.onEvidence).not.toHaveBeenCalled();
    detail.props.onShowInTimeline();
    expect(props.onEvidence).toHaveBeenCalledWith(FINDINGS[2]);
    detail.props.onClose();
    h.render();
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'FindingDetail')).toBe(false);
  });

  it('switches between the findings and the analysis records, each with its count', () => {
    const { h } = panel();
    const views = find(h.value, (n) => n.props['aria-label'] === zh('trace.diagnose.view'));
    expect(views.props.value).toBe('findings');
    expect([views.props.children].flat().map((n: ReactElement<any>) => text(n))).toEqual([
      '发现3',
      '分析记录1',
    ]);
    views.props.onValueChange('records');
    h.render();
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'FindingTable')).toBe(false);
    const records = named(h.value, 'ReviewRecords');
    expect(records.props).toMatchObject({
      reviews: [REVIEW],
      findings: FINDINGS,
      leadId: 'lead-a',
    });
    records.props.onFinding(FINDINGS[1]);
    h.render();
    expect(named(h.value, 'FindingDetail').props.finding).toBe(FINDINGS[1]);
  });

  it('says when the window has no findings and offers all time', () => {
    const { h, props } = panel({ diagnostics: diagnostics({ findings: [] }) });
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'FindingTable')).toBe(false);
    const empty = inner(inner(h.value, 'NoFindings'), 'EmptyState');
    expect(text(empty)).toContain(zh('trace.diagnose.empty'));
    expect(text(empty)).toContain('读了 2,318 个事件，412 个调用');
    const widen = button(empty, zh('trace.diagnose.allTime'));
    expect(widen.props['aria-keyshortcuts']).toBe('A');
    widen.props.onClick();
    expect(props.onAllTime).toHaveBeenCalled();
    expect(text(find(widen, (n) => n.props.className === 'kbd'))).toBe('A');
    const all = panel({ diagnostics: diagnostics({ findings: [] }), onAllTime: undefined }).h;
    const none = inner(inner(all.value, 'NoFindings'), 'EmptyState');
    expect(nodes(none).some((n) => n.type === 'button')).toBe(false);
  });
});

describe('finding detail', () => {
  const detail = (shown: RuntimeFinding, title = 'session of lane-f-slow') => {
    const onClose = vi.fn();
    const onShowInTimeline = vi.fn();
    const tree = FindingDetail({ finding: shown, title, onClose, onShowInTimeline });
    return { tree, onClose, onShowInTimeline };
  };

  it('heads the detail with the kind and session and closes it', () => {
    const { tree, onClose } = detail(FINDINGS[2]!);
    expect(tree.props['aria-label']).toBe(zh('trace.diagnose.detail.label'));
    const head = find(tree, (n) => n.props.className === 'fd-h');
    expect(text(head)).toBe('慢工具session of lane-f-slow');
    find(head, (n) => n.props['aria-label'] === zh('trace.diagnose.detail.close')).props.onClick();
    expect(onClose).toHaveBeenCalled();
  });

  it('heads the detail with the turn of the finding among its session turns', () => {
    const span = (id: string, start: number, extra: object = {}) => ({
      id,
      parent: null,
      turn: id,
      kind: 'turn',
      name: id,
      start,
      end: null,
      status: 'ok',
      timing: 'daemon',
      ...extra,
    });
    mock.spans = [
      span('turn-c', at(10, 20)),
      span('turn-a', at(9, 0)),
      span('call-x', at(9, 30), { kind: 'tool', parent: 'turn-b', turn: 'turn-b' }),
      span('turn-b', at(9, 10)),
    ];
    const turnOf = (shown: RuntimeFinding) => {
      const head = find(detail(shown).tree, (n) => n.props.className === 'fd-h');
      const element = nodes(head).find((n) => (n.type as any)?.name === 'FindingTurn');
      if (!element) return null;
      const render = element.type as (props: object) => ReactElement<any> | null;
      return text(mount(() => render(element.props)).value);
    };
    expect(turnOf(finding('f-turn', { lane_key: 'lane-a', turn_id: 'turn-b' }))).toBe('第 2 轮');
    expect(mock.traceReads.at(-1)).toEqual(['project-a', 'lane-a']);
    expect(turnOf(finding('f-gone', { lane_key: 'lane-a', turn_id: 'turn-z' }))).toBe('');
    expect(turnOf(finding('f-none', { lane_key: 'lane-a' }))).toBeNull();
  });

  it('says how long it took and that its parent was inferred', () => {
    const { tree } = detail(FINDINGS[2]!);
    expect(text(find(tree, (n) => n.type === 'p'))).toBe(
      '一次工具调用跑了 48.2 秒。它的父调用是按时间推断的，可能和别的调用重叠。',
    );
    expect(text(find(detail(FINDINGS[0]!).tree, (n) => n.type === 'p'))).toBe(
      '等你批准等了 6 分。',
    );
  });

  it('lays out the start, duration and category, with a dash for what is unknown', () => {
    const facts = (shown: RuntimeFinding) =>
      nodes(detail(shown).tree)
        .filter((n) => n.props.className === 'cell')
        .map((cell) => [cell.props.children].flat().map((n: ReactElement<any>) => text(n)));
    expect(facts(FINDINGS[2]!)).toEqual([
      [zh('trace.diagnose.detail.start'), '10:29:27'],
      [zh('trace.diagnose.detail.duration'), '48.2 秒'],
      [zh('trace.diagnose.detail.category'), zh('trace.diagnose.category.shell')],
    ]);
    expect(facts(FINDINGS[0]!)).toEqual([
      [zh('trace.diagnose.detail.start'), '—'],
      [zh('trace.diagnose.detail.duration'), '6 分'],
      [zh('trace.diagnose.detail.category'), '—'],
    ]);
  });

  it('shows the finding in the timeline and in its conversation', () => {
    const { tree, onShowInTimeline } = detail(FINDINGS[2]!);
    button(tree, zh('trace.diagnose.detail.showInTimeline')).props.onClick();
    expect(onShowInTimeline).toHaveBeenCalled();
    button(tree, zh('trace.diagnose.detail.showInThread')).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('lane-f-slow');
    const native = detail(finding('f-native', { lane_key: 'native:codex:a' })).tree;
    expect(
      nodes(native).some((n) =>
        text(n.props.children).includes(zh('trace.diagnose.detail.showInThread')),
      ),
    ).toBe(false);
  });
});

describe('analysis menu', () => {
  function menu(extra: Partial<Parameters<typeof AnalyzeMenu>[0]> = {}) {
    const props: Parameters<typeof AnalyzeMenu>[0] = {
      projectId: 'project-a',
      diagnostics: diagnostics(),
      runtimes: ['claude', 'codex'],
      leads: [{ id: 'lead-a', title: 'lead' }],
      lead: undefined,
      onLead: vi.fn(),
      windowText: '09:00 – 10:39',
      stale: false,
      ...extra,
    };
    return { h: mount(() => AnalyzeMenu(props) as ReactElement<any>), props };
  }
  const groups = (tree: unknown) =>
    nodes(tree as ReactElement).filter((n) => (n.type as any)?.name === 'MenuGroup');
  const radios = (group: ReactElement<any>) =>
    nodes(group)
      .filter((n) => (n.type as any)?.name === 'MenuRadioItem')
      .map((n) => [n.props.value, text(n.props.children)]);
  const choice = (group: ReactElement<any>) =>
    find(group, (n) => (n.type as any)?.name === 'MenuRadioGroup');
  const start = (tree: unknown) =>
    find(tree as ReactElement, (n) => n.props.className === 'btn am-start');
  const root = (tree: unknown) => find(tree as ReactElement, (n) => 'onOpenChange' in n.props);
  const trigger = (tree: unknown) =>
    find(tree as ReactElement, (n) => 'render' in n.props).props.render as ReactElement<any>;

  it('opens from the bar as a menu of runtime and recipient, then a start with the window', () => {
    const { h } = menu();
    expect(trigger(h.value).props.className).toBe('btn pri');
    expect(text(trigger(h.value))).toBe(zh('trace.diagnose.analyze'));
    expect(find(h.value, (n) => n.props.className === 'mn pop am').props['aria-label']).toBe(
      zh('trace.diagnose.analyze'),
    );
    const [runtime, recipient] = groups(h.value);
    expect(runtime!.props.label).toBe(zh('trace.diagnose.runtime'));
    expect(radios(runtime!)).toEqual([
      ['claude', 'Claude'],
      ['codex', 'Codex'],
    ]);
    expect(choice(runtime!).props.value).toBe('claude');
    expect(recipient!.props.label).toBe(zh('trace.diagnose.sendTo'));
    expect(radios(recipient!)).toEqual([
      ['lead-a', 'lead'],
      ['', zh('trace.runtime.noLeadLink')],
    ]);
    expect(choice(recipient!).props.value).toBe('lead-a');
    expect(text(start(h.value))).toBe('开始分析09:00 – 10:39');
  });

  it('starts an analysis of the window with the chosen runtime and lead, then opens it', async () => {
    const { h } = menu();
    root(h.value).props.onOpenChange(true);
    choice(groups(h.value)[0]!).props.onChange('codex');
    h.render();
    start(h.value).props.onClick();
    await h.flush();
    expect(command.mock.calls.map(([c]: any[]) => [c.type, c.input])).toEqual([
      [
        'trace.reflect',
        {
          project_id: 'project-a',
          runtime: 'codex',
          lead_session_id: 'lead-a',
          from: at(9, 0),
          to: at(10, 39),
        },
      ],
    ]);
    expect(mock.shell.openSession).toHaveBeenCalledWith('analysis-b');
    expect(root(h.value).props.open).toBe(false);
  });

  it('sends the conclusion to the whole project when chosen', async () => {
    const { h, props } = menu({ lead: null });
    choice(groups(h.value)[1]!).props.onChange('');
    expect(props.onLead).toHaveBeenCalledWith(null);
    expect(choice(groups(h.value)[1]!).props.value).toBe('');
    start(h.value).props.onClick();
    await h.flush();
    expect(command.mock.calls[0]![0].input).not.toHaveProperty('lead_session_id');
  });

  it('shows a failed start in the menu and keeps it open', async () => {
    command.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: '' } });
    const { h } = menu();
    root(h.value).props.onOpenChange(true);
    h.render();
    start(h.value).props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(reasonText('invalid_state'));
    expect(root(h.value).props.open).toBe(true);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it('cannot open without a runtime that can analyze', () => {
    const { h } = menu({ runtimes: [] });
    expect(trigger(h.value).props.disabled).toBe(true);
  });
});
