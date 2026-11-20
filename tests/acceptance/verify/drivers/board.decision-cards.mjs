import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 200_000,
});
const result = { id: 'board.decision-cards', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change; `state` is a page
// expression. A window on a background display gets no animation frames, so this does not use them.
const watch = (state) =>
  page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifyStates = []);
    const take = () => {
      const now = (() => ${state})();
      if (seen.at(-1) !== now) seen.push(now);
    };
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), 6000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');
// Clicks the button with text `text` inside the element `scope` (a page expression) with the mouse.
const clickIn = async (scope, text) => {
  const at = await page.evaluate(`(() => {
    const b = [...((${scope})?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) throw new Error(`no button ${text} in ${scope}`);
  const m = { x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...m });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...m, buttons: 0 });
};
// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-decision-cards-${stamp}`, {
    'README.md': '# decisions\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "decision-cards-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  // A deadline on questions, so each question of a batch has its Keep open.
  await call('workflow.policy.set', { project_id, question_defaults: { after_hours: 24 } });
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const idle = () =>
    poll(async () => {
      const s = (await query('session.list', { project_id })).find((x) => x.id === assistant);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const send = async (input) => {
    await idle();
    await call(
      'session.send',
      { session_id: assistant, input },
      (await board()).sessions.find((s) => s.id === assistant).revision,
    );
    return idle();
  };
  const script = (steps, line = '') =>
    `${line}${line && '\n'}fixture-script\n${JSON.stringify(steps)}`;
  const task = (id, title) => ({
    id,
    title,
    goal: `Do ${title}.`,
    lane: 'lane-a',
    milestone: 'milestone-a',
    estimate: 3,
    depends_on: [],
    source: ['The user asked for it.'],
    scope: ['src/index.ts'],
    acceptance: ['pnpm test'],
    kind: { domain: 'backend-logic', tier: 't1' },
    priority: 'normal',
  });
  await send(
    script([
      {
        tool: {
          name: 'update_board',
          arguments: {
            base_version: 0,
            headline: `Decisions ${stamp}`,
            lanes: [{ id: 'lane-a', title: 'Lane A' }],
            tasks: [task('task-one', 'Task one'), task('task-two', 'Task two')],
            milestones: [
              {
                id: 'milestone-a',
                title: 'Milestone A',
                criteria: ['Both tasks merge.'],
                tasks: ['task-one', 'task-two'],
              },
            ],
            risks: [],
            assumptions: [],
          },
        },
      },
    ]),
  );
  // Two questions from the same lead make one batch row.
  const Q1 = `Which store for ${stamp}?`;
  const Q2 = `Which queue for ${stamp}?`;
  await send(
    script([
      {
        tool: {
          name: 'ask_user',
          arguments: {
            question: Q1,
            options: ['SQLite', 'Postgres'],
            recommended: 'SQLite',
            assumption: 'SQLite until you answer.',
            blocks: ['task-one'],
            reversible: true,
          },
        },
      },
      {
        tool: {
          name: 'ask_user',
          arguments: {
            question: Q2,
            options: ['Redis', 'In memory'],
            recommended: 'In memory',
            assumption: 'In memory until you answer.',
            blocks: ['task-two'],
            reversible: true,
          },
        },
      },
    ]),
  );
  const mine = async () => (await query('needs_you.list', { project_id })).items;
  const items = await poll(async () => {
    const list = await mine();
    return list.filter((i) => i.kind === 'lead.question').length === 2 && list;
  }, 20_000);
  check(
    '前置：needs_you.list 有同一 lead 的两条提问',
    items,
    (await mine()).map((i) => [i.kind, i.reason]),
  );

  // 1. The board's Overview, its Needs you strip.
  const stripJs = `(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length && el.getBoundingClientRect().height > 0);
    if (!s) return null;
    return {
      count: s.querySelector('.bf-strip-n')?.textContent ?? null,
      rows: [...s.querySelectorAll('li.bf-need')].map((li) => {
        const art = li.querySelector('article');
        return {
          label: art?.getAttribute('aria-label') ?? null,
          kind: li.querySelector('.rq-kind')?.textContent ?? null,
          text: li.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
          buttons: [...li.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), disabled: b.getAttribute('aria-disabled') === 'true' })),
          questions: [...li.querySelectorAll('.rqb-q')].map((q) => q.querySelector('.rqb-t')?.textContent ?? null),
        };
      }),
    };
  })()`;
  await watch(
    `(() => { const s = ${stripJs}; return s ? s.count + ':' + s.rows.map((r) => r.kind).join('|') : 'none'; })()`,
  );
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '总览', exact: true });
  // Unfold the strip when it folds rows away.
  const folded = await poll(
    async () => (await names('还有 ')).find((n) => n.role === 'button'),
    3000,
  );
  if (folded?.name) await page.click({ role: 'button', name: folded.name, exact: true });
  const shown = await poll(async () => {
    const s = await page.evaluate(stripJs);
    return s?.rows.length === 1 && s;
  });
  result.strip = shown || (await page.evaluate(stripJs));
  const firstStates = await states();
  result.first_open_states = firstStates;
  check(
    '"需要你" 列表 1 行：一张成批提问卡',
    shown?.rows.length === 1,
    result.strip?.rows.map((r) => [r.kind, r.label]),
  );
  const batch = (shown?.rows ?? []).find((r) => r.kind === '决定');
  check(
    '成批卡种类 "决定"，含两条问题',
    batch?.questions.length === 2 && batch.questions.includes(Q1) && batch.questions.includes(Q2),
    batch,
  );
  check(
    '成批卡有 "全部回答" 和每题的 "保持待答"',
    batch?.buttons.some((b) => b.text === '全部回答') &&
      batch.buttons.filter((b) => b.text === '保持待答').length === 2,
    batch?.buttons,
  );
  result.shot = await page.screenshot(result.id);

  // 2. Keep one question open from the batch, then answer all.
  const questionsOf = async () => (await mine()).filter((i) => i.kind === 'lead.question');
  const before = await questionsOf();
  const first = before.find((i) => i.question?.question === Q1) ?? before[0];
  result.first_question = first && { default_at: first.default_at, question: first.question };
  await clickIn(
    `[...document.querySelectorAll('section[aria-label="需要你"] li.rqb-q')].find((q) => q.querySelector('.rqb-t')?.textContent === ${JSON.stringify(Q1)})`,
    '保持待答',
  );
  const kept = await poll(async () => {
    const q = (await questionsOf()).find((i) => i.question?.id === first?.question?.id);
    return q && q.default_at === undefined && q;
  });
  check('点第一题的 "保持待答" 后该提问没有默认生效时间', kept, {
    before: first?.default_at,
    after: (await questionsOf()).map((i) => i.default_at),
  });
  const batchNow = await poll(async () => {
    const r = (await page.evaluate(stripJs))?.rows.find((x) => x.kind === '决定');
    return r && r.buttons.filter((b) => b.text === '保持待答').length === 1 && r;
  });
  check('保持待答后这题的 "保持待答" 消失，另一题还在', batchNow, batchNow?.buttons);
  await page.click({ role: 'button', name: '全部回答', exact: true });
  const answered = await poll(async () => (await questionsOf()).length === 0);
  check('点 "全部回答" 后两条提问都答了(needs_you.list 无 lead.question)', answered);
  const plan = (await query('board.view', { project_id, days: '7' })).leads?.find(
    (l) => l.session_id === assistant,
  );
  result.plan_questions = plan?.questions;
  const stripGone = await poll(async () => (await page.evaluate(stripJs)) === null, 5000);
  check('全部处理完后 "需要你" 列表离开', stripGone, await page.evaluate(stripJs));
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
