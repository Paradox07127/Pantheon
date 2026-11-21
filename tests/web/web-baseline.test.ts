import { describe, expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';
import type { ProjectBaseline, BaselineResult } from '@pantheon/domain';
import {
  baselineConfirmRequest,
  baselineDraft,
  baselineFolders,
  baselineStartRequest,
} from '@/screens/projects/baseline';

const result = (extra: Partial<BaselineResult> = {}): BaselineResult => ({
  folders: [
    {
      root: '/work/ledger',
      gate: [
        { name: 'build', argv: ['pnpm', 'build'], sources: ['file:package.json'] },
        {
          name: 'test',
          argv: ['pnpm', 'test'],
          timeout_ms: 60_000,
          sources: ['file:package.json'],
        },
      ],
      setup: { argv: ['pnpm', 'install'], sources: ['file:package.json'] },
    },
  ],
  ...extra,
});

const baseline = (extra: Partial<ProjectBaseline> = {}): ProjectBaseline => ({
  id: 'baseline-1',
  revision: 4,
  project_id: 'project-a',
  state: 'submitted',
  session_id: 'session-1',
  runtime: 'claude',
  result: result(),
  dropped: 0,
  facts_id: 'facts-1',
  created_at: 1,
  ...extra,
});

describe('baselineStartRequest', () => {
  it('starts a baseline without a revision', () => {
    const req = baselineStartRequest('project-a');
    expect(req).toEqual({
      ok: true,
      type: 'project.baseline.start',
      input: { project_id: 'project-a' },
      expected_revision: null,
    });
    if (req.ok)
      expect(inputSchemas['project.baseline.start'].safeParse(req.input).success).toBe(true);
  });
});

describe('baselineConfirmRequest', () => {
  it('sends only the checked gate commands, without their sources', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    draft.gate[0]!.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input).toEqual({
      baseline_id: 'baseline-1',
      gates: [
        {
          root: '/work/ledger',
          commands: [{ name: 'test', argv: ['pnpm', 'test'], timeout_ms: 60_000 }],
        },
      ],
    });
    expect(req.expected_revision).toBe(4);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('clears the gate of a folder whose suggested commands are all unchecked', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    for (const item of draft.gate) item.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.gates).toEqual([{ root: '/work/ledger', commands: [] }]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('refuses a baseline that is not waiting for confirmation', () => {
    const s = baseline({ state: 'confirmed' });
    expect(baselineConfirmRequest(s, baselineDraft(s)).ok).toBe(false);
  });
});

describe('baselineDraft', () => {
  it('starts with every gate command checked', () => {
    const draft = baselineDraft(baseline());
    expect(draft.gate.map((g) => g.checked)).toEqual([true, true]);
  });

  it('groups the gate checklist under each folder with its setup command', () => {
    const two = result({
      folders: [
        result().folders[0]!,
        {
          root: '/work/site',
          gate: [{ name: 'lint', argv: ['npm', 'run', 'lint'], sources: ['file:package.json'] }],
        },
        { root: '/work/notes', gate: [] },
      ],
    });
    const s = baseline({ result: two });
    const draft = baselineDraft(s);
    expect(baselineFolders(s, draft)).toEqual([
      { root: '/work/ledger', setup: 'pnpm install', gate: [0, 1] },
      { root: '/work/site', setup: null, gate: [2] },
      { root: '/work/notes', setup: null, gate: [] },
    ]);
    draft.gate[1]!.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.gates).toEqual([
      { root: '/work/ledger', commands: [{ name: 'build', argv: ['pnpm', 'build'] }] },
      { root: '/work/site', commands: [{ name: 'lint', argv: ['npm', 'run', 'lint'] }] },
    ]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });
});
