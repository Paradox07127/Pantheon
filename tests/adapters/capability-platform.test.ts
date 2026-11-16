import { describe, expect, it } from 'vitest';
import {
  AcpAdapter,
  ClaudeAdapter,
  CodexAdapter,
  FixtureAdapter,
  acpProfiles,
  report,
} from '@pantheon/adapters';

describe('capability evidence platform', () => {
  for (const runtime of ['claude', 'codex']) {
    it(`keeps ${runtime} write isolation unknown on a platform it was not verified on`, () => {
      expect(report(runtime, '1', false, {}, 'freebsd').capabilities.write_isolation?.status).toBe(
        'unknown',
      );
    });

    for (const platform of ['darwin', 'linux'] as const)
      it(`applies ${runtime} isolation evidence on ${platform}, where it was verified`, () => {
        const { capabilities } = report(runtime, '1', false, {}, platform);
        expect(capabilities.write_isolation?.status).toBe('supported');
        expect(capabilities.read_isolation?.status).toBe('supported');
      });
  }
});

it('advertises manual compaction only through native adapters and the deterministic fixture', () => {
  for (const adapter of [new ClaudeAdapter(), new CodexAdapter(), new FixtureAdapter()])
    expect(adapter.report.capabilities.manual_compaction?.status).toBe('supported');
  expect(
    [new ClaudeAdapter(), new CodexAdapter(), new FixtureAdapter()].map(
      (adapter) => adapter.report.capabilities.compaction_instructions?.status,
    ),
  ).toEqual(['supported', 'unsupported', 'supported']);
  expect(report('other', '1').capabilities.manual_compaction?.status).toBe('unsupported');
  const profile = acpProfiles.grok!;
  const acp = new AcpAdapter({ name: 'grok', profile });
  expect(acp.report.capabilities.manual_compaction?.status).toBe('unsupported');
});

it('reports a model change during a turn as supported exactly where the adapter can make one', () => {
  for (const adapter of [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new FixtureAdapter(),
    new AcpAdapter({ name: 'grok', profile: acpProfiles.grok! }),
  ])
    expect([adapter.name, adapter.report.capabilities.turn_model_change?.status]).toEqual([
      adapter.name,
      'setModel' in adapter ? 'supported' : 'unsupported',
    ]);
});
