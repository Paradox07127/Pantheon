import { execFileSync } from 'node:child_process';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'insights-memory.entry-read-lines', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

try {
  const stamp = Date.now();
  const { project_id, repo } = await newProject(`verify-memory-read-${stamp}`, {
    'README.md': '# memory read lines\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "memory-read-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  // A project setup session, which carries the memory tools; its first turn ends before the turns below are sent.
  const TITLE = `verify-memory-read-${stamp}`;
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    purpose: 'project_setup',
    input: `${TITLE}\nfixture-script\n${JSON.stringify([{ say: `Ready ${stamp}` }])}`,
  });
  const first = await poll(
    async () =>
      (await query('session.list', { project_id })).find(
        (s) =>
          s.title === TITLE && s.last_turn && !['queued', 'running'].includes(s.last_turn.state),
      ),
    30_000,
  );
  check('前置：会话的第一个回合结束', first, first?.last_turn?.state);
  const session = first?.id;
  // Sends one turn and waits until it ends.
  const send = async (steps) => {
    const before = (await board()).session_turns.filter((t) => t.session_id === session).length;
    await call(
      'session.send',
      { session_id: session, input: `fixture-script\n${JSON.stringify(steps)}` },
      (await board()).sessions.find((s) => s.id === session).revision,
    );
    const turn = await poll(async () => {
      const turns = (await board()).session_turns.filter((t) => t.session_id === session);
      const last = turns.at(-1);
      return turns.length > before && !['queued', 'running'].includes(last.state) && last;
    }, 30_000);
    check(
      `前置：fixture 回合结束且没有失败（${steps[0].tool.name}）`,
      turn && turn.state !== 'failed',
      turn && { state: turn.state, error: turn.error },
    );
  };

  // The session proposes one note citing a file and one without a source.
  const REF = `Answer source ${stamp}`,
    BARE = `Bare note ${stamp}`;
  // Each proposal changes the memory signature, so each goes in its own turn on a fresh one.
  const propose = async (key, title, references) => {
    const { signature } = await call('memory.context', { project_id });
    await send([
      {
        tool: {
          name: 'memory_propose',
          arguments: {
            project_id,
            key,
            kind: 'note',
            title,
            text: `${title}: the answer lives in src/index.ts.`,
            ...(references && { references }),
            based_on: signature,
          },
        },
      },
      { say: `Noted ${stamp}` },
    ]);
  };
  await propose(`testing/answer-${stamp}`, REF, [{ kind: 'file', uri: 'src/index.ts', root: 0 }]);
  await propose(`testing/bare-${stamp}`, BARE);
  // The detail reads memory.item, which carries last_used_at and verified_commit.
  const item = (memory_id) => query('memory.item', { project_id, memory_id });
  const found = await poll(async () => {
    const rows = (await query('memory.read', { project_id, state: 'active' })).records ?? [];
    const ref = rows.find((r) => r.title === REF),
      bare = rows.find((r) => r.title === BARE);
    return ref && bare && { ref, bare };
  }, 30_000);
  const both = found && { ref: await item(found.ref.id), bare: await item(found.bare.id) };
  check('前置：两条笔记都生效', both, both && [both.ref.state, both.bare.state]);
  check(
    'memory.item：带文件引用的那条有 verified_commit，等于仓库 HEAD',
    both?.ref.verified_commit === HEAD,
    { verified_commit: both?.ref.verified_commit, HEAD },
  );
  check(
    '对照组：没有来源的那条没有 verified_commit',
    both && both.bare.verified_commit === undefined,
    both?.bare.verified_commit,
  );
  check(
    '前置：会话读之前两条都没有 last_used_at',
    both && both.ref.last_used_at === undefined && both.bare.last_used_at === undefined,
    both && [both.ref.last_used_at, both.bare.last_used_at],
  );

  // The memory screen's detail of one entry, read in one pass.
  const detail = (title) =>
    page.evaluate(`(() => {
      const d = document.querySelector('aside[aria-label="记忆详情"]');
      if (!d || !d.innerText.includes(${JSON.stringify(title)})) return null;
      const pairs = [...d.querySelectorAll('dl.ed-kv')].flatMap((dl) =>
        [...dl.querySelectorAll('dt')].map((dt) => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim()]));
      const sources = [...d.querySelectorAll('section.ed-sec')].find((s) => s.querySelector('h3')?.textContent.startsWith('来源'));
      return {
        pairs,
        under_sources: sources ? [...sources.querySelectorAll('dt')].map((dt) => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim()]) : null,
      };
    })()`);
  const openEntry = async (title) => {
    await page.click({ role: 'option', name: title, exact: false });
    return poll(() => detail(title));
  };
  // The memory screen opens from a chart card: pinning it offers the way to the project's diagrams.
  const SESSION = `verify-memory-chart-${stamp}`;
  const CHART = `Chart ${stamp}`;
  const created = await call('session.create', {
    project_id,
    runtime: 'fixture',
    purpose: 'conductor',
    input: `${SESSION}\nfixture-script\n${JSON.stringify([
      {
        tool: {
          name: 'draw',
          arguments: { title: CHART, kind: 'mermaid', spec: { source: 'graph TD\n  A-->B' } },
        },
      },
    ])}`,
  });
  // visual.list is a command for the user; its receipt carries the visuals.
  const drawn = await poll(async () => {
    const receipt = await call('visual.list', { project_id, session_id: created.id });
    return JSON.stringify(receipt).includes(CHART) && receipt;
  }, 30_000);
  check('前置：visual.list 有这个会话画的图', drawn, JSON.stringify(drawn).slice(0, 300));
  // A main agent session's row names its type between the title and the runtime.
  await page.click({ role: 'button', name: `${SESSION}，主 agent，fixture`, exact: false });
  await page.click({ role: 'button', name: '钉到图解', exact: true });
  await page.click({ role: 'button', name: '打开图解', exact: true });
  await page.click({ role: 'tab', name: '条目', exact: true });
  await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes(${JSON.stringify(BARE)}))`,
    ),
  );

  const refShown = await openEntry(REF);
  const checked = refShown?.under_sources?.find(([k]) => k === '核对于');
  check(
    '详情"来源"下有"核对于"和提交前 7 位，等于 verified_commit 和 HEAD 的前 7 位',
    checked?.[1] === HEAD.slice(0, 7) && checked[1] === both?.ref.verified_commit?.slice(0, 7),
    { shown: checked, HEAD: HEAD.slice(0, 7) },
  );
  check(
    '会话没读之前详情没有"上次读取"',
    refShown && !refShown.pairs.some(([k]) => k === '上次读取'),
    refShown?.pairs,
  );
  const bareShown = await openEntry(BARE);
  check(
    '对照组：没有来源的那条详情没有"核对于"',
    bareShown && !bareShown.pairs.some(([k]) => k === '核对于'),
    bareShown?.pairs,
  );

  // The session reads the cited note with memory_get.
  await send([
    { tool: { name: 'memory_get', arguments: { memory_id: both?.ref.id } } },
    { say: `Read ${stamp}` },
  ]);
  const used = await poll(async () => {
    const ref = await item(both?.ref.id);
    return ref?.last_used_at && { ref, bare: await item(both?.bare.id) };
  }, 30_000);
  check(
    'memory.item：会话 memory_get 后这条有 last_used_at',
    used?.ref.last_used_at,
    used?.ref.last_used_at,
  );
  check(
    '对照组：没被读的那条仍没有 last_used_at',
    used && used.bare?.last_used_at === undefined,
    used?.bare?.last_used_at,
  );
  const readShown = await poll(async () => {
    const d = await openEntry(REF);
    return d?.pairs.some(([k]) => k === '上次读取') && d;
  });
  const lastRead = readShown?.pairs.find(([k]) => k === '上次读取');
  check('详情显示"上次读取 <日期>"', lastRead?.[1], lastRead);
  result.shot = await page.screenshot(result.id);
  const bareAfter = await openEntry(BARE);
  check(
    '对照组：没被会话读过的那条详情没有"上次读取"',
    bareAfter && !bareAfter.pairs.some(([k]) => k === '上次读取'),
    bareAfter?.pairs,
  );
} catch (error) {
  check('驱动跑完没有抛异常', false, String(error?.message ?? error));
}

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
