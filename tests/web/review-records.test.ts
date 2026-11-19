import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RuntimeFinding, RuntimeReviewHistory } from '@pantheon/domain';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ shell: {} as any, toast: (() => '') as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign(() => undefined, { getState: () => ({ refresh() {} }) }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/components/Toast', () => ({ toast: (options: unknown) => mock.toast(options) }));
import { RunningFor } from '@/components/RunningFor';
import { useMemoryView } from '@/data/memory-view';
import { t } from '@/i18n';
import { reasonText } from '@/data/needs-you';
import { ReviewRecords } from '@/screens/trace/ReviewRecords';

const phase = (value: string) =>
  t({ id: 'trace.reviews.phase', defaultMessage: '' }, { phase: value });

const at = (hours: number, minutes: number) => new Date(2026, 10, 13, hours, minutes).getTime();

const finding = (id: string, patch: Partial<RuntimeFinding> = {}): RuntimeFinding => ({
  id,
  kind: 'approval',
  layer: 'human',
  source: 'daemon',
  at: at(9, 30),
  lane_key: `lane-${id}`,
  duration_ms: 360_000,
  evidence_ids: [],
  ...patch,
});

const report = (patch: Partial<NonNullable<RuntimeReviewHistory['report']>> = {}) => ({
  summary: 'Approvals took a sixth of the window.',
  finding_ids: ['f-approval', 'f-outside', 'f-gate'],
  change: 'Always allow the migration command',
  baseline: 'Six approvals this morning',
  metric: 'Request to decision p95',
  rollback: 'Any rejected migration',
  disposition: 'experiment' as const,
  recorded_at: at(10, 24),
  ...patch,
});

const review = (patch: Partial<RuntimeReviewHistory> = {}): RuntimeReviewHistory => ({
  session_id: 'analysis-a',
  runtime: 'claude',
  from: at(9, 0),
  to: at(10, 20),
  created_at: at(10, 24),
  state: 'ready',
  report: report(),
  ...patch,
});

const improved = {
  outcome: 'improved' as const,
  baseline: 31.2,
  trial: 6.8,
  evidence: 'turn_7c1e09',
  recorded_at: at(18, 12),
};

const findings = [
  finding('f-approval'),
  finding('f-gate', { kind: 'gate', layer: 'harness', duration_ms: 125_000 }),
];

let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // The records are of this day; a window on another day is written with its date.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(12, 0));
  command = vi.fn(async () => ({ ok: true, value: {} }));
  mock.shell = { openSession: vi.fn(), setMemoryTab: vi.fn(), setScreen: vi.fn() };
  mock.toast = vi.fn(() => '');
  useMemoryView.getState().select(null);
  vi.stubGlobal('window', { pantheon: { command } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The card of the one review, rendered with its hooks. */
function card(
  record: RuntimeReviewHistory,
  extra: Partial<Parameters<typeof ReviewRecords>[0]> = {},
) {
  const onFinding = vi.fn();
  const list = ReviewRecords({
    reviews: [record],
    findings,
    leads: [{ id: 'lead-a', title: 'lead' }],
    stale: false,
    titleOf: (lane) => `session of ${lane}`,
    onFinding,
    ...extra,
  }) as ReactElement<any>;
  const element = named(list, 'ReviewCard');
  const render = element.type as (props: object) => ReactElement<any>;
  return { h: mount(() => render(element.props)), onFinding };
}

const byText = (tree: ReactElement<any>, value: string) =>
  find(tree, (n) => typeof n.type === 'string' && text(n.props.children) === value);
const button = (tree: ReactElement<any>, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n.props.children).includes(label));
/** Opens the experiment form of a card and renders it with its hooks. */
function experimentForm(h: HookHost<ReactElement<any>>) {
  button(h.value, zh('trace.reviews.record')).props.onClick();
  h.render();
  const element = named(h.value, 'ExperimentForm');
  const render = element.type as (props: object) => ReactElement<any>;
  const form = mount(() => render(element.props));
  const input = (label: string) => find(form.value, (n) => n.props['aria-label'] === label);
  return { form, input };
}
const sent = () => command.mock.calls.map(([c]: any[]) => [c.type, c.input]);

describe('analysis records', () => {
  it('heads a record with its state, runtime, window and creation time', () => {
    const { h } = card(review());
    const head = find(h.value, (n) => n.props.className === 'rvr-head');
    const chip = find(head, (n) => String(n.props.className).includes('chip'));
    expect([text(chip), chip.props['data-phase']]).toEqual([phase('ready'), 'ready']);
    expect(text(find(head, (n) => n.props.className === 'rvr-win'))).toBe('09:00 – 10:20');
    expect(text(find(head, (n) => n.props.className === 'rvr-rt'))).toBe(
      zhf('trace.reviews.analyzedBy', { runtime: 'Claude', time: '10:24' }),
    );
  });

  it('heads a running record with how long it has been writing', () => {
    const { h } = card(review({ state: 'running', report: undefined }));
    const head = find(h.value, (n) => n.props.className === 'rvr-head');
    const running = find(head, (n) => n.type === RunningFor);
    expect(running.props).toEqual({ label: zh('components.running.writing'), since: at(10, 24) });
    expect(nodes(head).some((n) => n.props.className === 'rvr-rt')).toBe(false);
  });

  it('calls a verified improvement effective', () => {
    const { h } = card(review({ verification: improved }));
    const chip = find(h.value, (n) => String(n.props.className).includes('chip'));
    expect([text(chip), chip.props['data-phase']]).toEqual([phase('improved'), 'improved']);
    const result = find(h.value, (n) => n.props.className === 'rvr-result');
    expect(nodes(result).map((n) => text(n.props.children))).toEqual(
      expect.arrayContaining([
        t({ id: 'trace.reviews.outcome', defaultMessage: '' }, { outcome: 'improved' }),
        zh('trace.reviews.baselineValue'),
        '31.2',
        zh('trace.reviews.trialValue'),
        '6.8',
        'turn_7c1e09',
      ]),
    );
  });

  it('lists the cited findings that are in the window and opens one when pressed', () => {
    const { h, onFinding } = card(review());
    const rows = nodes(h.value).filter((n) => n.props.className === 'rvr-rf');
    expect(rows.map((row) => text(row.props.children))).toEqual([
      '等批准久session of lane-f-approval6 分钟',
      '门禁慢session of lane-f-gate2 分 5 秒',
    ]);
    rows[1]!.props.onClick();
    expect(onFinding).toHaveBeenCalledWith(findings[1]);
  });

  it('lays out the experiment as four labelled fields', () => {
    const { h } = card(review());
    const fields = find(h.value, (n) => n.props.className === 'rvr-xp');
    expect(
      nodes(fields)
        .filter((n) => n.type === 'dt')
        .map((n) => text(n.props.children)),
    ).toEqual([
      zh('trace.reviews.change'),
      zh('trace.reviews.baseline'),
      zh('trace.reviews.metric'),
      zh('trace.reviews.rollback'),
    ]);
    expect(text(byText(fields, 'Request to decision p95'))).toBe('Request to decision p95');
  });

  it('opens the analysis session', () => {
    const { h } = card(review());
    button(h.value, zh('trace.reviews.open')).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('analysis-a');
  });

  it('sends the conclusion to the only lead, then shows it as sent', async () => {
    const { h } = card(review());
    button(h.value, zh('trace.reviews.share')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['trace.share', { session_id: 'analysis-a', lead_session_id: 'lead-a' }],
    ]);
    const shared = card(review({ shared_at: at(10, 30), lead_session_id: 'lead-a' })).h;
    expect(button(shared.value, zh('trace.reviews.shared')).props.disabled).toBe(true);
  });

  it('shows why a command failed on its card, not in a toast', async () => {
    command.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: '' } });
    const { h } = card(review());
    button(h.value, zh('trace.reviews.share')).props.onClick();
    await h.flush();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toBe(reasonText('invalid_state'));
    expect(mock.toast).not.toHaveBeenCalled();
    button(h.value, zh('trace.reviews.share')).props.onClick();
    await h.flush();
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('shows why saving a result failed in its form', async () => {
    command.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: '' } });
    const { h } = card(review());
    const { form, input } = experimentForm(h);
    input(zh('trace.reviews.baselineInput')).props.onChange({ currentTarget: { value: '4' } });
    input(zh('trace.reviews.trialInput')).props.onChange({ currentTarget: { value: '1' } });
    input(zh('trace.reviews.evidence')).props.onChange({ currentTarget: { value: 'turn_1' } });
    form.render();
    find(form.value, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await form.flush();
    const alert = find(form.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toBe(reasonText('invalid_state'));
    expect(mock.toast).not.toHaveBeenCalled();
  });

  it('records an experiment result from the form', async () => {
    const { h } = card(review());
    const toggle = button(h.value, zh('trace.reviews.record'));
    expect(toggle.props['aria-expanded']).toBe(false);
    const { form, input } = experimentForm(h);
    expect(button(h.value, zh('trace.reviews.record')).props['aria-expanded']).toBe(true);
    input(zh('trace.reviews.result')).props.onValueChange('unchanged');
    input(zh('trace.reviews.baselineInput')).props.onChange({ currentTarget: { value: '4.0' } });
    input(zh('trace.reviews.trialInput')).props.onChange({ currentTarget: { value: '0.2' } });
    input(zh('trace.reviews.evidence')).props.onChange({ currentTarget: { value: 'turn_1' } });
    form.render();
    expect(button(form.value, zh('trace.reviews.save')).props.disabled).toBe(false);
    find(form.value, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await form.flush();
    expect(sent()).toEqual([
      [
        'trace.verify',
        {
          session_id: 'analysis-a',
          outcome: 'unchanged',
          baseline: 4,
          trial: 0.2,
          evidence: 'turn_1',
        },
      ],
    ]);
  });

  it('keeps the save button off until the values are numbers and evidence is given', () => {
    const { h } = card(review());
    const { form, input } = experimentForm(h);
    input(zh('trace.reviews.baselineInput')).props.onChange({ currentTarget: { value: 'abc' } });
    input(zh('trace.reviews.trialInput')).props.onChange({ currentTarget: { value: '1' } });
    input(zh('trace.reviews.evidence')).props.onChange({ currentTarget: { value: 'turn_1' } });
    form.render();
    expect(button(form.value, zh('trace.reviews.save')).props.disabled).toBe(true);
  });

  it('drafts a memory from an improvement and opens that draft among the memory entries', async () => {
    command.mockResolvedValue({ ok: true, value: { memory_id: 'memory-new' } });
    const { h } = card(review({ verification: improved }));
    button(h.value, zh('trace.reviews.remember')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([['trace.remember', { session_id: 'analysis-a' }]]);
    expect(mock.shell.setMemoryTab).toHaveBeenCalledWith('entries');
    expect(useMemoryView.getState().selectedId).toBe('memory-new');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('memory');
  });

  it('opens a drafted memory among the memory entries for confirmation', () => {
    const { h } = card(review({ verification: improved, memory_id: 'memory-a' }));
    const bar = find(h.value, (n) => n.props.className === 'rvr-nb');
    expect(text(bar)).toContain(zh('trace.reviews.remembered'));
    expect(
      nodes(h.value).some((n) => text(n.props.children) === zh('trace.reviews.remember')),
    ).toBe(false);
    expect(
      nodes(h.value).some((n) => text(n.props.children).includes(zh('trace.reviews.record'))),
    ).toBe(false);
    button(bar, zh('trace.reviews.confirm')).props.onClick();
    expect(mock.shell.setMemoryTab).toHaveBeenCalledWith('entries');
    expect(useMemoryView.getState().selectedId).toBe('memory-a');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('memory');
  });
});
