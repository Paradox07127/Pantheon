import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '@pantheon/domain';
import { parsePatch } from '@/data/patch';
import { anchorFinding } from '@/screens/sessions/model';

const files = parsePatch(
  [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+log(b);',
    ' return a + b;',
    '-gone();',
    '@@ -30,2 +30,1 @@',
    ' keep();',
    '-dropped();',
    '',
  ].join('\n'),
);

const finding = (location: string, quote: string): ReviewFinding => ({
  id: 'finding',
  review_id: 'review',
  runtime: 'codex',
  round: 1,
  location,
  quote,
  evidence: 'evidence',
  impact: 'impact',
  status: 'open',
  blocking: false,
});

describe('anchoring a review finding to a diff line', () => {
  it.each([
    ['lands on an added line', 'src/a.ts:12', 'log(b);', 'new', 12],
    ['lands on a context line', 'src/a.ts:10-11', '  const a = 1;\nconst b', 'new', 10],
    ['lands on a removed line on the old side', 'src/a.ts:31', 'dropped()', 'old', 31],
    [
      'prefers the new side when both sides have the line number',
      'src/a.ts:11',
      'const b',
      'new',
      11,
    ],
    [
      'lands on the removed line when only it holds the quote at a number both sides have',
      'src/a.ts:11',
      'const b = 2;',
      'old',
      11,
    ],
  ])('%s', (_, location, quote, side, line) => {
    expect(anchorFinding(finding(location, quote), files)).toEqual({
      path: 'src/a.ts',
      side,
      line,
    });
  });

  it.each<[string, [string, string][]]>([
    ['drops a path that is not in the diff', [['src/b.ts:10', 'const a']]],
    ['drops a line outside the shown hunks', [['src/a.ts:20', 'const a']]],
    [
      'drops a line whose text does not contain the quote',
      [
        ['src/a.ts:10', 'something else'],
        ['src/a.ts:10', ''],
      ],
    ],
    [
      'drops a location that names no line',
      [
        ['src/a.ts', 'const a'],
        ['near the top of a.ts', 'const a'],
      ],
    ],
  ])('%s', (_, cases) => {
    for (const [location, quote] of cases)
      expect(anchorFinding(finding(location, quote), files)).toBeNull();
  });
});
