import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it('accepts terminal dimensions at the bounds and refuses out-of-range or fractional sizes', () => {
  for (const type of ['terminal.open', 'terminal.resize'] as const) {
    const id = type === 'terminal.open' ? { project_id: 'project' } : { terminal_id: 'terminal' };
    expect(inputSchemas[type].safeParse({ ...id, cols: 20, rows: 5 }).success).toBe(true);
    expect(inputSchemas[type].safeParse({ ...id, cols: 500, rows: 200 }).success).toBe(true);
    for (const size of [
      { cols: 19, rows: 24 },
      { cols: 501, rows: 24 },
      { cols: 80, rows: 4 },
      { cols: 80, rows: 201 },
      { cols: 80.5, rows: 24 },
      { cols: 80, rows: 24.5 },
    ])
      expect(inputSchemas[type].safeParse({ ...id, ...size }).success).toBe(false);
    expect(inputSchemas[type].safeParse({ ...id, cols: 80, rows: 24, extra: true }).success).toBe(
      false,
    );
  }
});

it('limits terminal writes to 64 KiB of UTF-8, allowing empty writes', () => {
  for (const data of ['', 'x'.repeat(65536), '界'.repeat(21845)])
    expect(
      inputSchemas['terminal.write'].safeParse({ terminal_id: 'terminal', data }).success,
    ).toBe(true);
  for (const data of ['x'.repeat(65537), '界'.repeat(21846)])
    expect(
      inputSchemas['terminal.write'].safeParse({ terminal_id: 'terminal', data }).success,
    ).toBe(false);
  expect(inputSchemas['terminal.close'].safeParse({ terminal_id: 'terminal' }).success).toBe(true);
  expect(inputSchemas['terminal.close'].safeParse({}).success).toBe(false);
  expect(
    inputSchemas['terminal.close'].safeParse({ terminal_id: 'terminal', extra: true }).success,
  ).toBe(false);
});
