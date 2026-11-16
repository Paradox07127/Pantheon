import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffCounts } from '@/components/DiffCounts';

const counts = (additions: number | null, deletions: number | null) =>
  [
    ...renderToStaticMarkup(createElement(DiffCounts, { additions, deletions })).matchAll(
      /<span([^>]*)>([^<]*)<\/span>/g,
    ),
  ].map(([, attrs, shown]) => [shown, /data-zero/.test(attrs!)]);

describe('diff counts', () => {
  it('shows added and removed lines, marking a zero count apart', () => {
    expect(counts(12, 3)).toEqual([
      ['+12', false],
      ['−3', false],
    ]);
    expect(counts(0, 5)).toEqual([
      ['+0', true],
      ['−5', false],
    ]);
  });

  it('leaves out a count that is not known', () => {
    expect(counts(4, null)).toEqual([['+4', false]]);
    expect(counts(null, null)).toEqual([]);
  });
});
