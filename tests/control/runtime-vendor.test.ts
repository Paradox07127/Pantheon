import { expect, it } from 'vitest';
import { report } from '@pantheon/adapters';
import type { Project } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { verifierRuntime } from '../../packages/control/src/runtime-vendor.js';

// An adapter whose isolation is unverified is refused as a reviewer.
const adapter = (name: string, admitted: boolean) => ({
  name,
  report: report(name, '1', admitted, {}, 'win32'),
});

it.each([
  {
    case: 'claude writers on another vendor when one is admitted',
    adapters: { claude: true, codex: true },
    reviewer: undefined,
    expected: { runtime: 'codex', independence: 'other_vendor' },
  },
  {
    case: 'claude writers on another runtime of unknown vendor',
    adapters: { claude: true, opencode: true },
    reviewer: undefined,
    expected: { runtime: 'opencode', independence: 'other_runtime' },
  },
  {
    case: "claude writers on the writers' own runtime as the last resort",
    adapters: { claude: true, codex: false },
    reviewer: undefined,
    expected: { runtime: 'claude', independence: 'same_runtime' },
  },
  {
    case: 'claude writers on nothing when no runtime is admitted',
    adapters: { claude: false, codex: false },
    reviewer: undefined,
    expected: undefined,
  },
  {
    case: "claude writers on another vendor over a reviewer default on the writers' vendor",
    adapters: { claude: true, codex: true },
    reviewer: { runtime: 'claude' },
    expected: { runtime: 'codex', independence: 'other_vendor' },
  },
  {
    case: 'no writers on another runtime, never another vendor',
    writers: [],
    adapters: { claude: true, codex: true },
    reviewer: undefined,
    expected: { runtime: 'claude', independence: 'other_runtime' },
  },
  {
    case: "claude writers on the single model's own runtime",
    adapters: { claude: true, codex: true },
    reviewer: undefined,
    defaults: { model: 'claude-opus', single_model: true },
    expected: { runtime: 'claude', independence: 'same_runtime' },
  },
  {
    case: 'claude writers on the reviewer fallback when the reviewer default is worse',
    adapters: { claude: true, codex: true, gemini: true },
    reviewer: { runtime: 'claude' },
    defaults: { fallbacks: { reviewer: { runtime: 'gemini' } } },
    expected: { runtime: 'gemini', independence: 'other_vendor' },
  },
])('verifies $case', ({ writers = ['claude'], adapters, reviewer, defaults, expected }) => {
  const project = {
    id: 'project',
    session_defaults: (reviewer || defaults) && {
      runtime: 'claude',
      permission_mode: 'default',
      reviewer,
      ...defaults,
    },
  } as unknown as Project;
  const ctx = {
    adapters: new Map(
      Object.entries(adapters).map(([name, admitted]) => [name, adapter(name, admitted)]),
    ),
    store: { must: () => project },
  } as unknown as ControlContext;
  expect(verifierRuntime(ctx, project.id, writers)).toEqual(expected);
});
