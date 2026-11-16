import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import type { ReactElement } from 'react';
import type { BoardSnapshot } from '@pantheon/protocol';
import { VariableFields } from '@/screens/projects/EnvironmentFields';
import { ProjectEnvironment } from '@/screens/settings/ProjectSettingsScreen';
import { find, HookHost, named, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';

type Project = BoardSnapshot['projects'][number];

const command = vi.fn(async () => ({ ok: true, value: { revision: 2 } }));
beforeEach(() => {
  command.mockClear();
  vi.stubGlobal('window', {
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
  });
});
afterEach(() => vi.unstubAllGlobals());

it('shows no variable value after saving that the user did not show', async () => {
  let project: Project = {
    id: 'alpha',
    revision: 1,
    name: 'Alpha',
    roots: ['/work/app'],
    env: { FIRST: 'one', SECOND: 'two', THIRD: 'three' },
  };
  const screen = new HookHost(() => ProjectEnvironment({ project }));
  screen.render();
  // A child keeps its state while its key stays, as React does.
  let child: { key: string | null; host: HookHost<ReactElement> } | null = null;
  const fields = () => {
    const element = named(screen.value, 'VariableFields');
    if (child?.key !== element.key)
      child = {
        key: element.key,
        host: new HookHost(() => VariableFields(named(screen.value, 'VariableFields').props)),
      };
    return child.host.render();
  };
  const press = (label: string) => {
    find(fields(), (n) => n.props['aria-label'] === label).props.onClick();
    screen.render();
  };
  const valueType = (n: number) =>
    find(fields(), (node) => node.props['aria-label'] === zhf('projects.variables.value', { n }))
      .props.type;

  press(zhf('projects.variables.delete', { n: 1 }));
  press(zhf('projects.variables.show', { n: 1 }));
  expect([valueType(1), valueType(2)]).toEqual(['text', 'password']);

  const save = nodes(screen.value).find(
    (n) => n.type === 'button' && text(n) === zh('settings.common.save'),
  )!;
  save.props.onClick();
  await screen.flush();
  expect(command).toHaveBeenCalledTimes(1);
  project = { ...project, revision: 2, env: { SECOND: 'two', THIRD: 'three' } };
  screen.render();

  expect(valueType(2)).toBe('password');
});
