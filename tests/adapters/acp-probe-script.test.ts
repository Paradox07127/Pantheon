import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../../scripts/probe-acp.mjs', import.meta.url));
const server = fileURLToPath(new URL('./fake-acp-server.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-acp-probe-script-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Step {
  step: string;
  passed: boolean;
  detail: Record<string, unknown>;
  event_file: string;
  sha256: string;
}

// The fixture's tax line is line 9, and its README example totals 176.
const correct = [
  {
    match: '指出不一致的那一行',
    text: '第 9 行按未打折的金额算税（tax），之后才打折（discount），和 README 先打折再算税的顺序不一致。',
  },
  {
    match: '能抓住这个 bug 的测试用例',
    text: '输入 README 的示例：discountPercent 20、taxRate 0.1，期望输出 176。',
  },
  { match: 'test/invoice.test.js', text: '写入测试。', write: '(test/invoice\\.test\\.js)' },
  { match: '边界情况', text: '先看 subtotal()。', hold: true },
  { match: '../outside-', text: '写入总结。', write: '(\\.\\./outside-[\\w-]+\\.md)' },
];

async function probe(name: string, replies: typeof correct) {
  const out = path.join(root, name);
  const file = path.join(root, `${name}-replies.json`);
  writeFileSync(file, JSON.stringify(replies));
  await promisify(execFile)(process.execPath, [
    script,
    '--live',
    '--runtime',
    'agy',
    '--binary',
    process.execPath,
    '--args',
    server,
    '--args',
    file,
    '--out',
    out,
  ]);
  const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as {
    backends: { runtime: string; handshake: { status: string }; steps: Step[] }[];
  };
  return { out, backend: report.backends[0]! };
}

describe('ACP probe script', () => {
  it('checks the five live steps against a scripted agent', async () => {
    const { out, backend } = await probe('correct', correct);
    expect(backend).toMatchObject({ runtime: 'agy', handshake: { status: 'passed' } });
    expect(backend.steps.map(({ step, passed }) => [step, passed])).toEqual([
      ['text', true],
      ['resume', true],
      ['permission', true],
      ['cancel', true],
      ['outside_write', true],
    ]);
    expect(backend.steps[1]!.detail).toMatchObject({ resumed_same_session: true });
    expect(backend.steps[2]!.detail).toMatchObject({ permission_requests: 1, file_exists: false });
    expect(backend.steps[3]!.detail).toMatchObject({ status: 'interrupted' });
    expect(backend.steps[4]!.detail).toMatchObject({ outside_file_written: true });
    for (const step of backend.steps)
      expect(step.sha256).toBe(
        createHash('sha256')
          .update(readFileSync(path.join(out, step.event_file)))
          .digest('hex'),
      );
  }, 60000);

  it('fails the text step when the answer misses the line', async () => {
    const wrong = [
      { match: '指出不一致的那一行', text: 'total() 和 README 一致，没有问题。' },
      ...correct.slice(1),
    ];
    const { backend } = await probe('wrong', wrong);
    expect(backend.steps[0]).toMatchObject({ step: 'text', passed: false });
  }, 60000);
});
