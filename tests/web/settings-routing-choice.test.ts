import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RoutingCell } from '@pantheon/protocol';
import { HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { kindText } from '@/data/workflow-policy';
import { RoutingPage } from '@/screens/settings/RoutingPage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 4, name: 'Alpha app', roots: ['/work/alpha'] };
const cell: RoutingCell = {
  domain: 'backend-logic',
  tier: 't2',
  first: { runtime: 'claude', model: 'claude-opus-4-5', effort: 'high' },
  first_source: 'user',
  alternate: { runtime: 'codex', model: 'gpt-5.1-codex' },
  alternate_source: 'records',
  candidates: [
    {
      runtime: 'claude',
      model: 'claude-opus-4-5',
      effort: 'high',
      p: 0.8,
      n: 9,
      s: 7,
      success_rate: 0.778,
    },
    { runtime: 'codex', model: 'gpt-5.1-codex', p: 0.5, n: 0, s: 0, success_rate: null },
  ],
  prior: null,
};
const bridge = {
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method === 'routing.table'
      ? { ok: true, value: { cells: [cell] } }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return { ok: true, value: { revision: 5 } };
  },
};

async function page() {
  const h = mount(() => RoutingPage({ project: project as never }));
  await h.flush();
  return h;
}
const kind = () => kindText('backend-logic', 't2');
const firstOf = () =>
  t({ id: 'settings.routing.firstOf', defaultMessage: '{kind} first choice' }, { kind: kind() });
const alternateOf = () =>
  t({ id: 'settings.routing.alternateOf', defaultMessage: '{kind} alternate' }, { kind: kind() });
/** The menu of the chip labelled `label`. */
const open = (h: HookHost<any>, label: string) => {
  const chip = find(h.value as ReactNode, (n) => n.props.label === label);
  return (chip.type as (props: unknown) => ReactElement<any>)(chip.props);
};
const group = (menu: ReactNode) => find(menu, (n) => typeof n.props.onChange === 'function');
const choices = (menu: ReactNode) =>
  nodes(menu).filter((n) => typeof n.props.value === 'string' && !n.props.onChange);
const choice = (menu: ReactNode, model: string) =>
  choices(menu).find((n) => text(n).includes(model))!;

beforeEach(() => {
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('routing table choices', () => {
  it('lists choosing from the records, then each candidate with its runs and success rate apart', async () => {
    const menu = open(await page(), firstOf());
    expect(text(choices(menu)[0])).toBe(zh('settings.routing.auto'));
    const opus = choice(menu, 'claude-opus-4-5');
    expect(nodes(opus).filter((n) => text(n) === '9 次' || text(n) === '78%')).toHaveLength(2);
    expect(text(opus)).not.toContain('·');
    const codex = choice(menu, 'gpt-5.1-codex');
    expect(text(codex)).toContain('0 次');
    expect(text(codex)).not.toContain('%');
  });

  it("ticks the user's choice, or choosing from the records for a choice the records made", async () => {
    const h = await page();
    const first = open(h, firstOf());
    expect(group(first).props.value).toBe(choice(first, 'claude-opus-4-5').props.value);
    const alternate = open(h, alternateOf());
    expect(group(alternate).props.value).toBe(choices(alternate)[0]!.props.value);
  });

  it('sends routing.set with the chosen candidate', async () => {
    const h = await page();
    const menu = open(h, firstOf());
    group(menu).props.onChange(choice(menu, 'gpt-5.1-codex').props.value);
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'routing.set',
        input: {
          project_id: 'alpha',
          domain: 'backend-logic',
          tier: 't2',
          slot: 'first',
          choice: { runtime: 'codex', model: 'gpt-5.1-codex' },
        },
        expected_revision: 4,
      }),
    ]);
  });

  it('sends a null choice to go back to the records', async () => {
    const h = await page();
    const menu = open(h, firstOf());
    group(menu).props.onChange(choices(menu)[0]!.props.value);
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', domain: 'backend-logic', tier: 't2', slot: 'first', choice: null },
    ]);
  });
});
