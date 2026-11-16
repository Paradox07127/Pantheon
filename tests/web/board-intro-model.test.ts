import { describe, expect, it } from 'vitest';
import { cellLabel } from '@/screens/board/intro-model';

describe('the label of a module cell', () => {
  it.each([
    ['the path when it fits', 'packages/control', 200, 'packages/control'],
    ['the last segment when the path is too long', 'packages/control', 100, 'control'],
    ['nothing when the last segment is too long too', 'packages/control', 48, null],
    ['a path without a folder as it is', 'tests', 60, 'tests'],
  ])('is %s', (_, path, width, label) => {
    expect(cellLabel(path, width)).toBe(label);
  });
});
