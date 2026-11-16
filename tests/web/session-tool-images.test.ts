import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const mock = vi.hoisted(() => ({
  board: {
    board: {
      sessions: [
        { id: 'session-a', project_id: 'project-a', workspace_id: 'workspace-a', runtime: 'codex' },
      ],
      workspaces: [{ id: 'workspace-a', path: '/work/tree' }],
      projects: [{ id: 'project-a', roots: ['/work/project'] }],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  } as any,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { Items } from '@/screens/sessions/items';
import { zh } from './i18n-setup.js';

const event = (sequence: number, kind: string, payload: unknown): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});
const turn: SessionTurn = {
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: 'draw',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
};

describe('images on tool rows', () => {
  const png = 'iVBORw0KGgoAAAA';

  it('shows a thumbnail on the row of a call that generated an image', () => {
    const view = buildTranscript(
      [turn],
      [
        event(1, 'agent.tool.started', {
          tool_call_id: 'drawn',
          turn_id: 'turn-1',
          name: 'imageGeneration',
          input: { revisedPrompt: 'a tree' },
        }),
        event(2, 'agent.tool.completed', {
          tool_call_id: 'drawn',
          turn_id: 'turn-1',
          ok: true,
          output: { status: 'completed' },
          images: [{ mime: 'image/png', data: png }],
        }),
      ],
    );
    const html = renderToStaticMarkup(
      createElement(Items, {
        items: view.turns[0]!.items,
        verbose: false,
        ended: true,
        folders: ['/work/tree'],
        sessionId: 'session-a',
      }),
    );
    expect(html).toContain(`src="data:image/png;base64,${png}"`);
    expect(html).toContain(`aria-label="${zh('sessions.parts.openImage')}"`);
  });

  it('keeps the hash of a stored image and the page an Artifact call published on the call', () => {
    const hash = 'ab'.repeat(32);
    const page = {
      url: 'https://claude.ai/artifact/page-a',
      path: '/work/tree/landing.html',
      title: 'Landing design',
      version: '3',
    };
    const view = buildTranscript(
      [turn],
      [
        event(1, 'agent.tool.started', {
          tool_call_id: 'published',
          turn_id: 'turn-1',
          name: 'Artifact',
          input: { file_path: '/work/tree/landing.html' },
        }),
        event(2, 'agent.tool.completed', {
          tool_call_id: 'published',
          turn_id: 'turn-1',
          ok: true,
          images: [
            { mime: 'image/png', hash, size: 4 },
            { mime: 'text/html', hash },
          ],
          artifact: { ...page, artifact_id: 'page-a' },
        }),
      ],
    );
    const call = view.turns[0]!.items.find((item) => item.kind === 'tool');
    expect(call).toMatchObject({ images: [{ mime: 'image/png', hash, size: 4 }] });
    expect((call as { artifact?: object }).artifact).toEqual(page);
  });
});
