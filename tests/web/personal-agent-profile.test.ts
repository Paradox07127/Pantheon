import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, type HookHost, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
}));
const runCommand = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, value: {} })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: (projectId: string | null) =>
    projectId === 'home' ? [{ id: 'agent-p', template: 'personal', personal_key_id: 'k-1' }] : null,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', async (actual) => ({ ...(await actual<object>()), toast }));
import { failureText } from '@/data/needs-you';
import { showPersonalProfile } from '@/data/personal-agent';
import { PersonalAgentProfile } from '@/screens/sessions/PersonalAgentProfile';
import { PersonalAgentScreen } from '@/screens/sessions/PersonalAgentScreen';

const AT = Date.parse('2026-11-12T10:00:00.000Z');
let personalAnswers: string[];
let keys: unknown[];
let query: ReturnType<typeof vi.fn>;

beforeEach(() => {
  personalAnswers = [];
  keys = [
    { id: 'k-1', label: 'Built-in personal agent', created_at: AT },
    { id: 'k-2', label: 'Laptop', created_at: AT },
  ];
  query = vi.fn(async (method: string) =>
    method === 'app.settings'
      ? { ok: true, value: { personal_answers: personalAnswers } }
      : method === 'personal.key.list'
        ? { ok: true, value: keys }
        : { ok: false, error: { code: 'unknown_route', message: method } },
  );
  vi.stubGlobal('window', { pantheon: { query }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible' });
  mock.board = {
    board: {
      projects: [
        { id: 'alpha', name: 'Alpha', roots: ['/a'] },
        { id: 'beta', name: 'Beta', roots: ['/b'] },
        { id: 'home', name: 'Personal', roots: [], kind: 'personal' },
      ],
      sessions: [],
      session_turns: [],
      workspaces: [],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = {};
  runCommand.mockClear();
  toast.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  showPersonalProfile(false);
});

async function profile() {
  const h = mount(() => PersonalAgentProfile({ runtime: 'claude' }));
  await h.flush();
  await h.flush();
  return h;
}
const section = (h: HookHost<any>, name: string) =>
  find(
    h.value,
    (n) =>
      n.type === 'section' &&
      (n.props['aria-label'] === name ||
        nodes(n.props.children).some(
          (c) => c.props.id === n.props['aria-labelledby'] && text(c) === name,
        )),
  );
const rows = (h: HookHost<any>, name: string) =>
  nodes(section(h, name)).filter((n) => n.type === 'li');
const switchOf = (h: HookHost<any>, label: string) => {
  const forId = find(
    section(h, zh('sessions.personalAgent.answers')),
    (n) => n.type === 'label' && text(n) === label,
  ).props.htmlFor;
  return find(h.value, (n) => n.type === 'input' && n.props.id === forId);
};

describe('the personal agent’s profile', () => {
  it('lists starting workers and reading whole plans as things it cannot do', async () => {
    const h = await profile();
    const cannot = rows(h, zh('sessions.personalAgent.can')).filter((li) =>
      nodes(li).some((n) => n.props.role === 'img' && n.props['aria-label'] === '不能'),
    );
    expect(cannot.map((li) => text(li))).toEqual([
      zh('sessions.personalAgent.cannot.workers'),
      zh('sessions.personalAgent.cannot.plans'),
    ]);
    // Two visible projects; the home is not one of them.
    expect(text(rows(h, zh('sessions.personalAgent.can'))[0]!)).toContain('2 个项目');
  });

  it('keeps every decision it may answer for you off by default', async () => {
    const h = await profile();
    const labels = ['问题', '计划变更', '里程碑验收'];
    expect(labels.map((label) => switchOf(h, label).props)).toEqual(
      labels.map(() =>
        expect.objectContaining({ role: 'switch', checked: false, disabled: false }),
      ),
    );
  });

  it('turning Questions on saves that kind in the personal answers', async () => {
    personalAnswers = ['milestone_accept'];
    const h = await profile();
    switchOf(h, '问题').props.onChange({ target: { checked: true } });
    await h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['app.settings.set', { personal_answers: ['question', 'milestone_accept'] }, null],
    ]);
  });

  it('lists what always asks you', async () => {
    const h = await profile();
    expect(rows(h, zh('sessions.personalAgent.yours')).map((li) => text(li))).toEqual([
      '权限',
      '新智能体',
      '外部事件',
      '预算',
      'Worker 的提问',
    ]);
  });

  it('names the built-in key, says what revoking it does, and revokes a key by its id', async () => {
    const h = await profile();
    const [builtIn, laptop] = rows(h, zh('sessions.personalAgent.keys'));
    expect(text(builtIn!)).toContain('内置个人级智能体');
    const revoke = find(builtIn!, (n) => n.type === 'button');
    const warning = find(builtIn!, (n) => n.props.id === revoke.props['aria-describedby']);
    expect(text(warning)).toBe(zh('sessions.personalAgent.keys.builtInRevoke'));
    expect(text(laptop!)).toContain('Laptop');
    expect(nodes(laptop!).some((n) => n.props.id === 'pa-built-in')).toBe(false);
    find(laptop!, (n) => n.type === 'button' && text(n) === '吊销').props.onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([['personal.key.revoke', { key_id: 'k-2' }, null]]);
  });

  it('shows a refused revoke’s failure text', async () => {
    const error = { code: 'invalid_state', message: 'The key is revoked already' };
    runCommand.mockResolvedValueOnce({ ok: false, error });
    const h = await profile();
    find(
      rows(h, zh('sessions.personalAgent.keys'))[1]!,
      (n) => n.type === 'button',
    ).props.onClick();
    await h.flush();
    expect(toast).toHaveBeenCalledWith({ title: failureText(error), kind: 'failure' });
  });
});

describe('the personal agent’s Profile toggle', () => {
  const screen = () =>
    mount(() =>
      PersonalAgentScreen({
        needs: { items: [], loading: false, error: null, reload() {} } as any,
        list: { data: [], loading: false, error: null, reload() {} } as any,
      }),
    );
  const toggle = (h: HookHost<any>) =>
    find(h.value, (n) => n.type === 'button' && n.props['aria-label'] === '资料');

  it('docks the profile beside the conversation while pressed', () => {
    const h = screen();
    expect(toggle(h).props['aria-pressed']).toBe(false);
    expect(() => named(h.value, 'PersonalAgentProfile')).toThrow();
    toggle(h).props.onClick();
    h.render();
    expect(toggle(h).props['aria-pressed']).toBe(true);
    const dock = find(h.value, (n) => n.props.className === 'ss-dock');
    expect(named(dock, 'PersonalAgentProfile')).toBeTruthy();
  });
});
