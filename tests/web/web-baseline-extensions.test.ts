import { afterEach, expect, it, vi } from 'vitest';
import { find, mount, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'ap' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/data/app-settings', () => ({ useAppSettings: () => ({ settings: null }) }));
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zhf } from './i18n-setup.js';

afterEach(unmountAll);

const reason =
  'The project is a TypeScript workbench with no n8n workflows, so this server only adds tool noise to every session.';

it('lists each suggested extension with its full name and its full reason on hover', () => {
  const baseline: any = {
    id: 'b1',
    revision: 1,
    project_id: 'p1',
    state: 'submitted',
    session_id: 's1',
    runtime: 'claude',
    dropped: 0,
    facts_id: 'f1',
    created_at: 1,
    result: {
      folders: [],
      workstreams: [],
      contradictions: [],
      findings: [],
      brief: { goal: 'Ship', goals: [], non_goals: [], sources: [] },
      questions: [],
      extensions: [
        { runtime: 'codex', kind: 'mcp_server', name: 'n8n_capstream_readonly', reason },
      ],
    },
  };
  const h = mount(() => ReviewBaseline({ baseline }));
  const row = find(h.value, (n) => n.type === 'label' && /hm-pi/.test(n.props.className));
  const [name, why] = nodes(row.props.children).filter((n) => n.type === 'span');
  expect(name!.props.title).toBe('n8n_capstream_readonly');
  expect(why!.props.title).toBe(reason);
  expect(find(row, (n) => n.type === 'input').props['aria-label']).toBe(
    zhf('projects.baseline.keepOff', { runtime: 'Codex', name: 'n8n_capstream_readonly' }),
  );
});

it('groups the suggested extensions by runtime name in the runtime table order', () => {
  const extension = (runtime: string) => ({
    runtime,
    kind: 'skill',
    name: `${runtime}-skill`,
    reason,
  });
  const baseline: any = {
    id: 'b1',
    revision: 1,
    project_id: 'p1',
    state: 'submitted',
    dropped: 0,
    facts_id: 'f1',
    created_at: 1,
    result: {
      folders: [],
      workstreams: [],
      contradictions: [],
      findings: [],
      questions: [],
      extensions: ['codex', 'grok', 'claude'].map(extension),
    },
  };
  const h = mount(() => ReviewBaseline({ baseline }));
  const groups = nodes(h.value).filter((n) => n.type === 'fieldset');
  expect(groups.map((n) => n.props['aria-label'])).toEqual(['Claude', 'Codex', 'grok']);
});
