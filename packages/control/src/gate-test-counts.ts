import type { TestCounts } from '@pantheon/domain';

const patterns = [
  { line: /^\s*Tests:?\s+(.+)$/, counts: /(\d+)\s+(passed|failed|skipped)\b/g },
  { line: /^=+\s+(.+?)\s+=+\s*$/, counts: /(\d+)\s+(passed|failed|skipped)\b/g },
  { line: /^test result: \w+\.\s+(.+)$/, counts: /(\d+)\s+(passed|failed|ignored)\b/g },
  { line: /^\s*--- (PASS|FAIL|SKIP): / },
];

/** Consumes complete output lines while retaining only an unfinished line per stream. */
export class GateTestCounts {
  private pending = { stdout: '', stderr: '' };
  private counts: TestCounts | undefined;

  write(text: string, channel: 'stdout' | 'stderr' = 'stdout'): void {
    const lines = (this.pending[channel] + text).split('\n');
    this.pending[channel] = lines.pop()!;
    for (const line of lines) this.readLine(line);
  }

  finish(): TestCounts | undefined {
    this.readLine(this.pending.stdout);
    this.readLine(this.pending.stderr);
    return this.counts;
  }

  private readLine(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    for (const pattern of patterns) {
      const match = pattern.line.exec(line);
      if (!match) continue;
      if (pattern.counts) {
        for (const count of match[1]!.matchAll(pattern.counts)) {
          this.counts ??= { passed: 0, failed: 0, skipped: 0 };
          const key = count[2] === 'ignored' ? 'skipped' : (count[2] as keyof TestCounts);
          this.counts[key] += Number(count[1]);
        }
      } else {
        this.counts ??= { passed: 0, failed: 0, skipped: 0 };
        const key = match[1] === 'PASS' ? 'passed' : match[1] === 'FAIL' ? 'failed' : 'skipped';
        this.counts[key]++;
      }
      break;
    }
  }
}
