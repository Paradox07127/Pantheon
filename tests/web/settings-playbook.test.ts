import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, PlaybookRead } from '@pantheon/protocol';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog/index.mjs';
import { type HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'pb' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { PlaybookEditor } from '@/screens/settings/PlaybookEditor';
import { zh, zhf } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Sections = PlaybookRead['sections'];

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const BUILT_IN: Sections = {
  before_you_plan: 'Read the goal first.',
  routing: 'Send backend tasks to Codex.',
  replies: 'Start with what changed.',
};
const OWN: Sections = {
  before_you_plan: 'Read the goal and the last retrospective.',
  routing: 'Keep migrations on Codex.',
  replies: 'Name the branch in every hand-off.',
};
const FIRST: Sections = {
  before_you_plan: 'Read the goal.',
  routing: 'Send every task to a task session.',
  replies: 'Start with what changed.',
};

const readOf = (patch: Partial<PlaybookRead> = {}): PlaybookRead => ({
  project_id: 'alpha',
  version: 0,
  versions: [],
  source: 'code',
  sections: BUILT_IN,
  built_in: BUILT_IN,
  ...patch,
});
const codexOwn = readOf({
  runtime: 'codex',
  version: 3,
  versions: [1, 2, 3],
  source: 'runtime',
  sections: OWN,
});

const bridge = {
  /** The answer to each command by type; playbook.get by default answers from `reads`. */
  replies: {} as Record<string, BridgeResult<unknown>[]>,
  reads: {} as Record<string, PlaybookRead>,
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    if (method === 'runtime.status')
      return {
        ok: true,
        value: ['claude', 'codex'].map((runtime) => ({
          runtime,
          enabled: true,
          installed: true,
          auth: { state: 'ok' },
        })),
      };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    const queued = bridge.replies[command.type]?.shift();
    if (queued) return queued;
    const runtime = (command.input.runtime as string | undefined) ?? '';
    return { ok: true, value: bridge.reads[runtime] ?? readOf() };
  },
};

const sectionName = (id: string) => zh(`settings.playbook.section.${id}`);
const defaultBox = (id: string) =>
  zhf('settings.playbook.box.default', { section: sectionName(id) });
const runtimeBox = (runtime: string, id: string) =>
  zhf('settings.playbook.box.runtime', { runtime, section: sectionName(id) });

async function editor() {
  const h = mount(() => PlaybookEditor({ project: project as never }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (h: HookHost<any>, label: string) =>
  find(tree(h), (n) => n.props['aria-label'] === label);
const button = (h: HookHost<any>, label: string) =>
  find(tree(h), (n) => n.type === 'button' && text(n) === label);
const hasButton = (h: HookHost<any>, label: string) =>
  nodes(tree(h)).some((n) => n.type === 'button' && text(n) === label);
const alerts = (h: HookHost<any>) =>
  nodes(tree(h))
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));
const sent = (type: string) => bridge.commands.filter((c) => c.type === type).map((c) => c.input);
async function choose(h: HookHost<any>, runtime: string) {
  find(
    labelled(h, zh('settings.playbook.for')),
    (n) => typeof n.props.onValueChange === 'function',
  ).props.onValueChange(runtime);
  await h.flush();
}
async function type(h: HookHost<any>, label: string, value: string) {
  labelled(h, label).props.onChange({ target: { value } });
  await h.flush();
}
async function click(h: HookHost<any>, node: ReactElement<any>) {
  node.props.onClick();
  await h.flush();
}

beforeEach(() => {
  bridge.replies = {};
  bridge.reads = { '': readOf(), codex: codexOwn };
  bridge.commands = [];
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
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

describe('playbook editor', () => {
  it('shows the built-in text for the default playbook, then reads a runtime’s own', async () => {
    const h = await editor();
    expect(sent('playbook.get')).toEqual([{ project_id: 'alpha' }]);
    expect(labelled(h, defaultBox('beforeYouPlan')).props.value).toBe(BUILT_IN.before_you_plan);
    expect(text(tree(h))).toContain(zh('settings.playbook.source.code'));
    expect(nodes(tree(h)).some((n) => String(n.props['aria-label']).startsWith('打法版本'))).toBe(
      false,
    );
    expect(hasButton(h, zh('settings.playbook.reset'))).toBe(false);

    await choose(h, 'codex');
    expect(sent('playbook.get').at(-1)).toEqual({ project_id: 'alpha', runtime: 'codex' });
    expect(labelled(h, runtimeBox('Codex', 'routing')).props.value).toBe(OWN.routing);
    expect(text(tree(h))).toContain(zhf('settings.playbook.source.runtime', { runtime: 'Codex' }));
    expect(text(labelled(h, zhf('settings.playbook.version', { version: 3 })))).toBe('v3');
  });

  it('holds the boxes empty and disabled until the read lands', async () => {
    const command = bridge.command;
    bridge.command = () => new Promise(() => {});
    try {
      const h = await editor();
      const box = labelled(h, defaultBox('replies'));
      expect(box.props.value).toBe('');
      expect(box.props.disabled).toBe(true);
      expect(button(h, zh('settings.playbook.save')).props.disabled).toBe(true);
      expect(nodes(tree(h)).some((n) => n.props['aria-busy'] === true)).toBe(true);
    } finally {
      bridge.command = command;
    }
  });

  it('shows a read failure in the section’s place with a retry', async () => {
    bridge.replies['playbook.get'] = [{ ok: false, error: { code: 'internal', message: 'down' } }];
    const h = await editor();
    expect(alerts(h).join('\n')).toContain('down');
    await click(h, button(h, zh('components.retry')));
    expect(labelled(h, defaultBox('routing')).props.value).toBe(BUILT_IN.routing);
  });

  it('checks each box in place and saves a valid edit as the next version', async () => {
    const h = await editor();
    await choose(h, 'codex');
    const save = () => button(h, zh('settings.playbook.save'));
    expect(save().props.disabled).toBe(true);

    await type(h, runtimeBox('Codex', 'replies'), '  ');
    await type(h, runtimeBox('Codex', 'routing'), 'Keep migrations on Codex.\n## Backend');
    expect(labelled(h, runtimeBox('Codex', 'replies')).props['aria-invalid']).toBe(true);
    expect(alerts(h)).toEqual([
      zhf('settings.playbook.heading', { line: 2 }),
      zhf('settings.playbook.empty', { section: sectionName('replies') }),
    ]);
    expect(save().props.disabled).toBe(true);

    await type(h, runtimeBox('Codex', 'routing'), 'Keep migrations on Codex.\nBackend first.');
    await type(h, runtimeBox('Codex', 'replies'), 'Name the gate result.');
    expect(alerts(h)).toEqual([]);
    bridge.replies['playbook.set'] = [
      {
        ok: true,
        value: {
          ...codexOwn,
          version: 4,
          versions: [1, 2, 3, 4],
          sections: { ...OWN, routing: 'x', replies: 'y' },
        },
      },
    ];
    await click(h, save());
    expect(sent('playbook.set')).toEqual([
      {
        project_id: 'alpha',
        runtime: 'codex',
        base_version: 3,
        sections: {
          before_you_plan: OWN.before_you_plan,
          routing: 'Keep migrations on Codex.\nBackend first.',
          replies: 'Name the gate result.',
        },
      },
    ]);
    expect(labelled(h, zhf('settings.playbook.version', { version: 4 }))).toBeTruthy();
    expect(labelled(h, runtimeBox('Codex', 'routing')).props.value).toBe('x');
    expect(save().props.disabled).toBe(true);
  });

  it('puts the read text back on discard, and keeps each choice’s draft while switching', async () => {
    const h = await editor();
    expect(hasButton(h, zh('settings.playbook.discard'))).toBe(false);
    await type(h, defaultBox('replies'), 'Default draft.');
    await choose(h, 'codex');
    expect(labelled(h, runtimeBox('Codex', 'replies')).props.value).toBe(OWN.replies);
    await choose(h, '');
    expect(labelled(h, defaultBox('replies')).props.value).toBe('Default draft.');
    await click(h, button(h, zh('settings.playbook.discard')));
    expect(labelled(h, defaultBox('replies')).props.value).toBe(BUILT_IN.replies);
    expect(hasButton(h, zh('settings.playbook.discard'))).toBe(false);
  });

  it('fills the built-in text into the boxes as an unsaved draft', async () => {
    const h = await editor();
    await choose(h, 'codex');
    await click(h, button(h, zh('settings.playbook.reset')));
    expect(labelled(h, runtimeBox('Codex', 'beforeYouPlan')).props.value).toBe(
      BUILT_IN.before_you_plan,
    );
    expect(sent('playbook.set')).toEqual([]);
    expect(button(h, zh('settings.playbook.save')).props.disabled).toBe(false);
  });

  it('shows an earlier version read only and saves it as the next version', async () => {
    bridge.replies['playbook.get'] = [
      { ok: true, value: readOf() },
      { ok: true, value: codexOwn },
      { ok: true, value: { ...codexOwn, sections: FIRST } },
    ];
    const h = await editor();
    await choose(h, 'codex');
    const menu = labelled(h, zh('settings.playbook.versions'));
    const items = nodes(menu).filter((n) => typeof n.props.onClick === 'function');
    expect(items.map((n) => n.props.value)).toEqual(['3', '2', '1']);
    expect(text(items[0])).toContain(zh('settings.playbook.current'));
    await click(h, items[2]!);
    expect(sent('playbook.get').at(-1)).toEqual({
      project_id: 'alpha',
      runtime: 'codex',
      version: 1,
    });
    const old = labelled(
      h,
      zhf('settings.playbook.box.runtimeVersion', {
        runtime: 'Codex',
        version: 1,
        section: sectionName('routing'),
      }),
    );
    expect(old.props.value).toBe(FIRST.routing);
    expect(old.props.readOnly).toBe(true);
    expect(
      labelled(h, zhf('settings.playbook.versionShowing', { shown: 1, current: 3 })),
    ).toBeTruthy();

    await click(h, button(h, zhf('settings.playbook.saveVersion', { version: 1 })));
    expect(sent('playbook.set')).toEqual([
      { project_id: 'alpha', runtime: 'codex', base_version: 3, sections: FIRST },
    ]);
  });

  it('goes back from an earlier version to the current one', async () => {
    const h = await editor();
    await choose(h, 'codex');
    const items = nodes(labelled(h, zh('settings.playbook.versions'))).filter(
      (n) => typeof n.props.onClick === 'function',
    );
    await click(h, items[1]!);
    await click(h, button(h, zhf('settings.playbook.back', { version: 3 })));
    expect(labelled(h, runtimeBox('Codex', 'routing')).props.readOnly).toBeFalsy();
    expect(labelled(h, runtimeBox('Codex', 'routing')).props.value).toBe(OWN.routing);
  });

  it('keeps text typed while a save is in flight as a draft on the saved version', async () => {
    const h = await editor();
    await choose(h, 'codex');
    await type(h, runtimeBox('Codex', 'replies'), 'First.');
    let answer!: (result: BridgeResult<unknown>) => void;
    bridge.replies['playbook.set'] = [
      new Promise((resolve) => (answer = resolve)) as unknown as BridgeResult<unknown>,
    ];
    await click(h, button(h, zh('settings.playbook.save')));
    await type(h, runtimeBox('Codex', 'replies'), 'First. Then more.');
    answer({
      ok: true,
      value: {
        ...codexOwn,
        version: 4,
        versions: [1, 2, 3, 4],
        sections: { ...OWN, replies: 'First.' },
      },
    });
    await h.flush();
    expect(labelled(h, zhf('settings.playbook.version', { version: 4 }))).toBeTruthy();
    expect(labelled(h, runtimeBox('Codex', 'replies')).props.value).toBe('First. Then more.');

    await click(h, button(h, zh('settings.playbook.save')));
    expect(sent('playbook.set').map((input) => [input.base_version, input.sections])).toEqual([
      [3, { ...OWN, replies: 'First.' }],
      [4, { ...OWN, replies: 'First. Then more.' }],
    ]);
  });

  it('keeps the text after a version conflict and loads the newer version to save over', async () => {
    const h = await editor();
    await choose(h, 'codex');
    await type(h, runtimeBox('Codex', 'replies'), 'Mine.');
    bridge.replies['playbook.set'] = [
      { ok: false, error: { code: 'version_conflict', message: 'stale' } },
    ];
    bridge.reads.codex = { ...codexOwn, version: 5, versions: [1, 2, 3, 4, 5] };
    await click(h, button(h, zh('settings.playbook.save')));
    expect(alerts(h)).toContain(zh('settings.playbook.conflict'));
    expect(labelled(h, runtimeBox('Codex', 'replies')).props.value).toBe('Mine.');

    await click(h, button(h, zhf('settings.playbook.load', { version: 5 })));
    expect(alerts(h)).toEqual([]);
    expect(labelled(h, runtimeBox('Codex', 'replies')).props.value).toBe('Mine.');
    await click(h, button(h, zh('settings.playbook.save')));
    expect(sent('playbook.set').map((input) => input.base_version)).toEqual([3, 5]);
  });

  it('removes a runtime’s own playbook only once the user confirms', async () => {
    const h = await editor();
    expect(hasButton(h, zh('settings.playbook.remove'))).toBe(false);
    await choose(h, 'codex');
    await click(h, button(h, zh('settings.playbook.remove')));
    expect(sent('playbook.remove')).toEqual([]);
    const dialog = find(tree(h), (n) => n.type === AlertDialog.Root);
    expect(dialog.props.open).toBe(true);
    bridge.replies['playbook.remove'] = [
      { ok: true, value: readOf({ runtime: 'codex', source: 'default' }) },
    ];
    await click(
      h,
      find(dialog, (n) => n.props.className === 'btn dng'),
    );
    expect(sent('playbook.remove')).toEqual([
      { project_id: 'alpha', runtime: 'codex', base_version: 3 },
    ]);
    expect(text(tree(h))).toContain(zh('settings.playbook.source.default'));
    expect(hasButton(h, zh('settings.playbook.remove'))).toBe(false);
  });
});
