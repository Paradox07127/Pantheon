import { expect, it } from 'vitest';
import { GateTestCounts } from '../../packages/control/dist/gate-test-counts.js';

it.each([
  ['vitest', ' Tests  3 failed | 41 passed | 2 skipped (46)\n'],
  ['jest', 'Tests:       3 failed, 41 passed, 2 skipped, 46 total\n'],
  ['pytest', '================ 3 failed, 41 passed, 2 skipped in 1.2s ================\n'],
  ['cargo', 'test result: FAILED. 41 passed; 3 failed; 2 ignored; 0 measured\n'],
  [
    'go verbose',
    Array.from({ length: 41 }, (_, i) => `--- PASS: TestPass${i} (0.00s)`)
      .concat(
        Array.from({ length: 3 }, (_, i) => `--- FAIL: TestFail${i} (0.00s)`),
        ['--- SKIP: TestSkip (0.00s)', '    --- SKIP: TestNestedSkip (0.00s)'],
      )
      .join('\n'),
  ],
])('reads %s test counts', (_format, output) => {
  const parser = new GateTestCounts();
  parser.write(output);
  expect(parser.finish()).toEqual({ passed: 41, failed: 3, skipped: 2 });
});

it('adds multiple summaries across output chunks and channels', () => {
  const parser = new GateTestCounts();
  parser.write('Tests  1 failed | 4 pa');
  parser.write('== 2 failed, 5 passed, 1 skipped in 1.2s ==\n', 'stderr');
  parser.write('ssed (5)\n');
  expect(parser.finish()).toEqual({ passed: 9, failed: 3, skipped: 1 });
});

it.each(['ordinary output\n', 'ok\texample/package\t0.012s\nPASS\n', ''])(
  'omits counts without a summary: %s',
  (output) => {
    const parser = new GateTestCounts();
    parser.write(output);
    expect(parser.finish()).toBeUndefined();
  },
);
