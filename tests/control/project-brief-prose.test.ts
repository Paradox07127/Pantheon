import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectBriefItem, ProjectBriefRef } from '@pantheon/protocol';
import { briefItemsKey } from '../../packages/control/dist/project-brief.js';
import { eventually, fixture, user } from '../helpers.js';

type Reply = {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
};
type Summarizer = (prompt: string, signal: AbortSignal) => Promise<Reply>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function setup(turnSummarizer: Summarizer) {
  const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-brief-prose-config-'));
  const f = await fixture({ controlOptions: { turnSummarizer, userConfigDir } });
  cleanups.push(async () => {
    await f.close();
    rmSync(userConfigDir, { recursive: true, force: true });
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Two merges after the cursor; returns their brief refs. */
function happened(f: Fixture): { merge: ProjectBriefRef; search: ProjectBriefRef } {
  f.store.event('session.merged', { id: 'session-filters', revision: 1 }, f.project.id, {});
  f.store.event('session.merged', { id: 'session-search', revision: 1 }, f.project.id, {});
  return {
    merge: { kind: 'merge', id: 'session-filters' },
    search: { kind: 'merge', id: 'session-search' },
  };
}

const key = (ref: ProjectBriefRef) => `${ref.kind}:${ref.id}`;
const write = (f: Fixture) =>
  f.call<{ started: boolean }>('project.brief.prose.write', { project_id: f.project.id });
const brief = (f: Fixture) => f.control.projectBrief(user, f.project.id);
const written = (f: Fixture) =>
  f.store
    .events(0, undefined, 10_000)
    .filter((event) => event.kind === 'project.brief_prose_written');
/** Lets the side call and what it stores finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

type Refs = ReturnType<typeof happened>;
const merged = (refs: Refs) => ({ text: 'Refund list filters merged.', refs: [key(refs.merge)] });
const searched = (refs: Refs) => ({
  text: 'Refund search merged.',
  refs: [key(refs.search)],
});

it.each<
  [
    string,
    (refs: Refs) => string,
    (refs: Refs) => { text: string; refs: ProjectBriefRef[] }[] | undefined,
  ]
>([
  [
    'every sentence cites known items',
    (refs) => JSON.stringify({ sentences: [merged(refs), searched(refs)] }),
    (refs) => [
      { text: 'Refund list filters merged.', refs: [refs.merge] },
      { text: 'Refund search merged.', refs: [refs.search] },
    ],
  ],
  [
    'one sentence cites an unknown item',
    (refs) =>
      JSON.stringify({
        sentences: [
          merged(refs),
          { text: 'A review passed.', refs: [key(refs.search), 'event:unknown-review'] },
        ],
      }),
    (refs) => [{ text: 'Refund list filters merged.', refs: [refs.merge] }],
  ],
  [
    'one sentence cites nothing',
    (refs) => JSON.stringify({ sentences: [{ text: 'Work went on.', refs: [] }, searched(refs)] }),
    (refs) => [{ text: 'Refund search merged.', refs: [refs.search] }],
  ],
  [
    'one sentence gives a number its items do not',
    (refs) =>
      JSON.stringify({
        sentences: [{ text: '3 sessions merged.', refs: [key(refs.merge)] }, searched(refs)],
      }),
    (refs) => [{ text: 'Refund search merged.', refs: [refs.search] }],
  ],
  [
    'five sentences cite known items',
    (refs) => JSON.stringify({ sentences: Array.from({ length: 5 }, () => merged(refs)) }),
    (refs) =>
      Array.from({ length: 4 }, () => ({
        text: 'Refund list filters merged.',
        refs: [refs.merge],
      })),
  ],
  ['the reply is not JSON', () => 'Refund list filters merged.', () => undefined],
])('when %s, keeps only the cited sentences on the brief', async (_name, reply, kept) => {
  let refs: Refs | undefined;
  const summarizer = vi.fn<Summarizer>(async () => ({
    text: reply(refs!),
    model: 'side-model',
    usage: { input_tokens: 40, output_tokens: 12 },
  }));
  const f = await setup(summarizer);
  refs = happened(f);
  expect(write(f)).toEqual({ started: true });
  await settled();

  const prompt = summarizer.mock.calls[0]![0];
  expect(prompt).toContain(`[${key(refs.merge)}]`);
  expect(prompt).toContain(`[${key(refs.search)}] An untitled session merged.`);
  const sentences = kept(refs);
  expect(brief(f).prose?.sentences).toEqual(sentences);
  expect(written(f).map((event) => (event.payload as { sentences: unknown }).sentences)).toEqual(
    sentences ? [sentences] : [],
  );
});

it('shows the stored prose on the brief only until project.seen moves the cursor', async () => {
  let refs: Refs | undefined;
  const f = await setup(async () => ({
    text: JSON.stringify({ sentences: [merged(refs!)] }),
  }));
  refs = happened(f);
  write(f);
  await settled();
  expect(brief(f).prose).toEqual({
    sentences: [{ text: 'Refund list filters merged.', refs: [refs.merge] }],
    at: expect.any(Number),
  });

  const seen = f.call<{ at: number }>('project.seen', { project_id: f.project.id });
  expect(brief(f)).toEqual({ since: expect.any(Number), items: [] });
  await eventually(() => f.store.now() > seen.at);
  happened(f);
  expect(brief(f).items).not.toEqual([]);
  expect(brief(f).prose).toBeUndefined();
});

it('asks the side model once per brief, also while the first call runs', async () => {
  const answer = Promise.withResolvers<Reply>();
  const summarizer = vi.fn<Summarizer>(() => answer.promise);
  const f = await setup(summarizer);
  const refs = happened(f);
  expect(write(f)).toEqual({ started: true });
  expect(write(f)).toEqual({ started: false });
  answer.resolve({ text: JSON.stringify({ sentences: [merged(refs)] }) });
  await settled();
  expect(brief(f).prose).toBeDefined();
  expect(write(f)).toEqual({ started: false });
  await settled();
  expect(summarizer).toHaveBeenCalledOnce();
});

it('makes no side call with the setting off or for an empty brief', async () => {
  const summarizer = vi.fn<Summarizer>(async () => ({ text: '{}' }));
  const f = await setup(summarizer);
  expect(write(f)).toEqual({ started: false });
  happened(f);
  f.call('app.settings.set', { brief_prose: false });
  expect(write(f)).toEqual({ started: false });
  await settled();
  expect(summarizer).not.toHaveBeenCalled();
  expect(brief(f).prose).toBeUndefined();
});

it('keeps the paragraph of a brief when only the count of what was decided for the user moves', () => {
  const merged: ProjectBriefItem = {
    kind: 'merge',
    ref: { kind: 'merge', id: 'session-a' },
    at: 1,
  };
  const decided = (count: number): ProjectBriefItem => ({
    kind: 'decided',
    ref: { kind: 'decided', id: 'project-a' },
    count,
    types: { permission: count, question: 0, action: 0 },
  });
  expect(briefItemsKey([merged, decided(2)])).toBe(briefItemsKey([merged]));
  expect(briefItemsKey([merged, decided(3)])).toBe(briefItemsKey([merged, decided(2)]));
  expect(briefItemsKey([merged, { ...merged, at: 2 }])).not.toBe(briefItemsKey([merged]));
});
