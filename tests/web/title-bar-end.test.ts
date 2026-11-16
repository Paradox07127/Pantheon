import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleBarEnd } from '@/components/TitleBarEnd';
import type { NeedsYouItem } from '@/data/needs-you';
import { zh, zhf } from './i18n-setup.js';

const render = (count: number) =>
  renderToStaticMarkup(
    createElement(TitleBarEnd, {
      needs: Array.from({ length: count }, (_, i): NeedsYouItem => ({
        source: { table: 'approvals', id: `a${i}`, revision: 1 },
        kind: 'permission',
        project_id: 'alpha',
        status: 'pending',
        created_at: 0,
        reason: 'permission_requested',
        actions: [],
      })),
    }),
  );
/** The opening tags of the buttons named `name`. */
const buttons = (html: string, name: string) =>
  [...html.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`aria-label="${name}"`));

describe('title bar end', () => {
  it('counts what waits for the user, and shows nothing while nothing does', () => {
    const name = zhf('components.titleBarEnd.needs', { count: 3 });
    expect(name).toBe('3 件事等你');
    expect(buttons(render(3), name)).toHaveLength(1);
    expect(render(0)).not.toContain('<button');
    expect(buttons(render(0), zhf('components.titleBarEnd.needs', { count: 0 }))).toEqual([]);
  });

  it('holds no search', () => {
    expect(render(3).match(/<button/g)).toHaveLength(1);
    expect(render(3)).not.toContain(zh('components.windowControls.search'));
  });
});
