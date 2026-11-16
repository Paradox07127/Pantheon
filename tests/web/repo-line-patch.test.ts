import { describe, expect, it } from 'vitest';
import { parsePatch } from '@/data/patch';
import { discardPatch, fileHeaders, lineKey } from '@/screens/repo/changes/line-patch';

const HEADER = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 1111111..2222222 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
];
const CONFIG = [
  ...HEADER,
  '@@ -8,5 +8,6 @@ export const refundConfig = {',
  "   currency: 'CNY',",
  '-  maxPartialRatio: 0.9,',
  '+  maxPartialRatio: 1,',
  '+  retryLimit: 5,',
  '   webhookTimeoutMs: 8000,',
  '-  debugLog: false,',
  '+  debugLog: true,',
  ' };',
  '@@ -30,3 +31,3 @@ export function limit() {',
  ' export function limit() {',
  '-  return 3;',
  '+  return 5;',
  ' }',
  '',
].join('\n');
const LIST = [
  'diff --git a/notes/list.md b/notes/list.md',
  '--- a/notes/list.md',
  '+++ b/notes/list.md',
  '@@ -1,2 +1,4 @@',
  ' a',
  '+b',
  '+c',
  ' d',
  '',
].join('\n');

const RUN = [
  'diff --git a/scripts/run.sh b/scripts/run.sh',
  'old mode 100644',
  'new mode 100755',
  'index 6666666..7777777',
  '--- a/scripts/run.sh',
  '+++ b/scripts/run.sh',
  '@@ -1,2 +1,2 @@',
  ' set -e',
  '-make',
  '+make all',
  '',
].join('\n');

const discard = (patch: string, keys: [number, number][]) =>
  discardPatch(
    fileHeaders(patch)[0]!,
    parsePatch(patch)[0]!.hunks,
    new Set(keys.map(([h, l]) => lineKey(h, l))),
  );

const cases: { name: string; patch: string; keys: [number, number][]; expected: string[] }[] = [
  {
    name: 'one added line',
    patch: CONFIG,
    keys: [[0, 3]],
    expected: [
      ...HEADER,
      '@@ -8,5 +8,6 @@ export const refundConfig = {',
      "   currency: 'CNY',",
      '   maxPartialRatio: 1,',
      '+  retryLimit: 5,',
      '   webhookTimeoutMs: 8000,',
      '   debugLog: true,',
      ' };',
    ],
  },
  {
    name: 'one removed line',
    patch: CONFIG,
    keys: [[0, 1]],
    expected: [
      ...HEADER,
      '@@ -8,7 +8,6 @@ export const refundConfig = {',
      "   currency: 'CNY',",
      '-  maxPartialRatio: 0.9,',
      '   maxPartialRatio: 1,',
      '   retryLimit: 5,',
      '   webhookTimeoutMs: 8000,',
      '   debugLog: true,',
      ' };',
    ],
  },
  {
    name: 'a removed line and the added line that replaced it',
    patch: CONFIG,
    keys: [
      [0, 1],
      [0, 2],
    ],
    expected: [
      ...HEADER,
      '@@ -8,6 +8,6 @@ export const refundConfig = {',
      "   currency: 'CNY',",
      '-  maxPartialRatio: 0.9,',
      '+  maxPartialRatio: 1,',
      '   retryLimit: 5,',
      '   webhookTimeoutMs: 8000,',
      '   debugLog: true,',
      ' };',
    ],
  },
  {
    name: 'lines of the second hunk only',
    patch: CONFIG,
    keys: [
      [1, 1],
      [1, 2],
    ],
    expected: [
      ...HEADER,
      '@@ -31,3 +31,3 @@ export function limit() {',
      ' export function limit() {',
      '-  return 3;',
      '+  return 5;',
      ' }',
    ],
  },
  {
    name: 'a later hunk placed after what the earlier kept hunk changes',
    patch: CONFIG,
    keys: [
      [0, 1],
      [1, 2],
    ],
    expected: [
      ...HEADER,
      '@@ -8,7 +8,6 @@ export const refundConfig = {',
      "   currency: 'CNY',",
      '-  maxPartialRatio: 0.9,',
      '   maxPartialRatio: 1,',
      '   retryLimit: 5,',
      '   webhookTimeoutMs: 8000,',
      '   debugLog: true,',
      ' };',
      '@@ -32,2 +31,3 @@ export function limit() {',
      ' export function limit() {',
      '+  return 5;',
      ' }',
    ],
  },
  {
    name: 'only added lines with no context',
    patch: [...HEADER, '@@ -3,1 +3,2 @@', '-x', '+y', '+z', ''].join('\n'),
    keys: [
      [0, 1],
      [0, 2],
    ],
    expected: [...HEADER, '@@ -2,0 +3,2 @@', '+y', '+z'],
  },
  {
    name: 'an added line whose unselected neighbour becomes context',
    patch: LIST,
    keys: [[0, 2]],
    expected: [
      'diff --git a/notes/list.md b/notes/list.md',
      '--- a/notes/list.md',
      '+++ b/notes/list.md',
      '@@ -1,3 +1,4 @@',
      ' a',
      ' b',
      '+c',
      ' d',
    ],
  },
  {
    name: 'the mode change when only text lines are selected',
    patch: RUN,
    keys: [[0, 2]],
    expected: [
      'diff --git a/scripts/run.sh b/scripts/run.sh',
      'index 6666666..7777777',
      '--- a/scripts/run.sh',
      '+++ b/scripts/run.sh',
      '@@ -1,1 +1,2 @@',
      ' set -e',
      '+make all',
    ],
  },
];

describe('patch that discards selected lines', () => {
  it.each(cases)('keeps $name', ({ patch, keys, expected }) => {
    expect(discard(patch, keys)).toBe(`${expected.join('\n')}\n`);
  });
});
