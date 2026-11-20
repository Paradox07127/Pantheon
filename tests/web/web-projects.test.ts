import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@pantheon/domain';
import { runCommand } from '@/data/commands';
import {
  findProjectByRoots,
  nameFromPath,
  openRejectText,
  removeProject,
  removeRejectText,
  searchProjects,
  visibleProjects,
} from '@/data/projects';
import { changesSummary } from '@/data/projects-summary';
import { reasonText } from '@/data/needs-you';
import { zh, zhf } from './i18n-setup.js';

vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));

const projects = [
  { id: 'p1', name: 'Pantheon', roots: ['/Users/me/Pantheon'] },
  { id: 'p2', name: 'api-server', roots: ['/Users/me/work/api-server'] },
  { id: 'p3', name: 'notes', roots: ['/srv/Docs/notes'] },
];

describe('project search', () => {
  const multi = [...projects, { id: 'p5', name: 'site', roots: ['/a/app', '/b/Docs-site'] }];
  const all = ['p1', 'p2', 'p3'];

  it.each([
    ['keeps every project for an empty or blank query', projects, { '': all, '   ': all }],
    ['matches the name without case', projects, { PANTH: ['p1'] }],
    ['matches the root path', projects, { '/work/': ['p2'], docs: ['p3'] }],
    ["matches any of a project's folders", multi, { 'docs-site': ['p5'], '/a/app': ['p5'] }],
    ['returns nothing when no name or path matches', projects, { missing: [] }],
  ])('%s', (_name, list, found: Record<string, string[]>) => {
    for (const [query, ids] of Object.entries(found))
      expect(searchProjects(list, query).map((p) => p.id)).toEqual(ids);
  });
});

describe('removed projects', () => {
  it('leaves removed projects out of the visible list', () => {
    const listed: Pick<Project, 'id' | 'name' | 'roots' | 'removed_at'>[] = [
      ...projects,
      { id: 'p4', name: 'old', roots: ['/old'], removed_at: 5 },
    ];
    expect(visibleProjects(listed).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('sends project.remove at the project revision', async () => {
    const result = await removeProject({ id: 'p2', revision: 7 });
    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('project.remove', { project_id: 'p2' }, 7);
  });

  it('names a busy project in words and keeps other reasons', () => {
    expect(removeRejectText({ code: 'resource_busy', message: 'x' })).toBe(
      zh('data.projects.removeBusy'),
    );
    expect(removeRejectText({ code: 'bridge_unavailable', message: 'x' })).toBe(
      '桌面桥不可用（x）',
    );
    expect(removeRejectText({ code: 'mystery_code', message: 'boom' })).toBe('mystery_code：boom');
  });
});

describe('open project rejections', () => {
  it('names the known reasons in words', () => {
    expect(openRejectText('invalid_project', 'Project must be a directory')).toBe(
      zh('data.projects.notFolder'),
    );
    expect(
      openRejectText(
        'scope_violation',
        'Project cannot include the control database or credentials',
      ),
    ).toBe(zh('data.projects.containsData'));
    expect(openRejectText('scope_violation', 'Project roots overlap project "api" (p-1)')).toBe(
      zhf('data.projects.overlaps', { name: 'api' }),
    );
    expect(openRejectText('scope_violation', 'Project roots overlap each other')).toBe(
      zh('data.projects.foldersNested'),
    );
    expect(openRejectText('permission_denied', 'x')).toBe(zh('data.projects.ownerOnly'));
    expect(
      openRejectText('invalid_request', "ENOENT: no such file or directory, realpath '/nope'"),
    ).toBe(zh('data.projects.folderMissing'));
    expect(openRejectText('invalid_request', 'EACCES: permission denied')).toBe(
      zh('data.projects.noReadPermission'),
    );
    expect(openRejectText('invalid_request', 'Too small')).toBe(zh('data.reason.invalidInput'));
    expect(openRejectText('bridge_unavailable', 'Desktop bridge unavailable')).toBe(
      zh('data.reason.bridgeUnavailable'),
    );
  });

  it('points a folder that is not a git repository to the auto git init setting', () => {
    expect(openRejectText('git_required', '/work/notes is not a git repository')).toBe(
      reasonText('git_required'),
    );
  });

  it('names an invalid project settings file rather than calling the folder not a folder', () => {
    expect(
      openRejectText(
        'invalid_project',
        'Invalid /work/app/.pantheon/config.json: [{"code":"unrecognized_keys"}]',
      ),
    ).toBe(zhf('data.projects.invalidConfig', { file: '.pantheon/config.json' }));
    expect(
      openRejectText('invalid_project', 'Invalid /work/app/.pantheon/config.local.json: bad'),
    ).toBe(zhf('data.projects.invalidConfig', { file: '.pantheon/config.local.json' }));
  });

  it('says an overlapping project was removed and how to get it back', () => {
    expect(
      openRejectText('scope_violation', 'Project roots overlap removed project "Wallpaper" (p-2)'),
    ).toBe(zhf('data.projects.overlapsRemoved', { name: 'Wallpaper' }));
  });

  it('shows an unknown code as it is', () => {
    expect(openRejectText('mystery_code', 'x')).toBe('mystery_code');
  });
});

describe('directory names and roots', () => {
  it('takes the last path segment as the name', () => {
    expect(nameFromPath('/Users/me/cli-tool')).toBe('cli-tool');
    expect(nameFromPath('/Users/me/cli-tool/')).toBe('cli-tool');
    expect(nameFromPath('C:\\code\\api-server')).toBe('api-server');
    expect(nameFromPath('/')).toBe('');
  });

  it('finds the project already opened at a root, ignoring a trailing slash', () => {
    expect(findProjectByRoots(projects, ['/Users/me/Pantheon/'])?.id).toBe('p1');
    expect(findProjectByRoots(projects, ['/Users/me/Pantheon2'])).toBeNull();
    expect(findProjectByRoots(projects, ['  '])).toBeNull();
  });

  it('finds a project only by the same set of roots, in any order', () => {
    const pair = [{ id: 'p5', roots: ['/a/app', '/a/docs'] }];
    expect(findProjectByRoots(pair, ['/a/docs/', '/a/app'])?.id).toBe('p5');
    expect(findProjectByRoots(pair, ['/a/app'])).toBeNull();
    expect(findProjectByRoots(pair, ['/a/app', '/a/docs', '/a/more'])).toBeNull();
  });
});

describe('project summary refresh', () => {
  it('reads the summary again after task dispatch and lead wake events', () => {
    for (const kind of [
      'task.dispatch_failed',
      'task.dispatched',
      'task.stop_requested',
      'board.lead_wake_failed',
    ])
      expect(changesSummary(kind)).toBe(true);
    expect(changesSummary('agent.message.delta')).toBe(false);
  });

  it('reads the summary again after the events that change what needs you', () => {
    for (const kind of [
      'lead.question_asked',
      'lead.question_answered',
      'workflow.step_created',
      'workflow.step_changed',
      'workflow.definition_trial_completed',
      'workflow.definition_trial_decided',
      'workflow.policy_changed',
    ])
      expect([kind, changesSummary(kind)]).toEqual([kind, true]);
  });
});
