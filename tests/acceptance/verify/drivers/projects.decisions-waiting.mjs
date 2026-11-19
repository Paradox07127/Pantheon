import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 150_000,
});
const result = { id: 'projects.decisions-waiting', checks: [] };
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

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const NAME = `verify-waiting-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# waiting\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "waiting-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );

  // A lead with a plan asks the user one question that holds a task.
  const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
  const LEAD = `Lead waiting ${stamp}`;
  const task = (id, depends_on = []) => ({
    id,
    title: `Task ${id} ${stamp}`,
    goal: `Do ${id}.`,
    lane: 'main',
    depends_on,
    source: ['The user asked for it.'],
    scope: [`src/${id}.ts`],
    acceptance: ['true'],
    kind: { domain: 'backend-logic', tier: 't1' },
  });
  const plan = {
    base_version: 0,
    headline: `Waiting ${stamp}`,
    lanes: [{ id: 'main', title: `Main ${stamp}` }],
    tasks: [task('one'), task('two', ['one'])],
    milestones: [],
    risks: [],
    assumptions: [],
  };
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${LEAD}\n${script({ tool: { name: 'update_board', arguments: plan } })}`,
  });
  const leadOf = async () =>
    (await query('session.list', { project_id })).find((s) => s.title === LEAD);
  const idle = () =>
    poll(async () => {
      const s = await leadOf();
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const ready = await idle();
  const QUESTION = `Which store for ${stamp}?`;
  await call(
    'session.send',
    {
      session_id: ready.id,
      input: script({
        tool: {
          name: 'ask_user',
          arguments: {
            question: QUESTION,
            options: ['SQLite', 'Postgres'],
            recommended: 'SQLite',
            assumption: 'SQLite until you answer.',
            blocks: ['two'],
          },
        },
      }),
    },
    (await board()).sessions.find((s) => s.id === ready.id)?.revision ?? ready.revision,
  );
  await idle();
  const summaryOf = async () =>
    (await query('projects.summary')).projects?.find?.((p) => p.project_id === project_id) ??
    (await query('projects.summary')).find?.((p) => p.project_id === project_id);
  const summary = await poll(async () => {
    const s = await summaryOf();
    return s?.needs_you === 1 && s;
  }, 20_000);
  result.summary = summary && {
    needs_you: summary.needs_you,
    waiting: summary.waiting,
    brief: summary.brief,
  };
  check(
    '前置：projects.summary 里这个项目 needs_you=1',
    summary,
    result.summary ?? (await summaryOf()),
  );

  // 1. Sidebar > All projects.
  const rowState = `(() => {
    const r = [...document.querySelectorAll('section[role=region]')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(NAME)});
    if (!r) return 'none';
    const b = [...r.querySelectorAll('button')].map((x) => x.getAttribute('aria-label') ?? x.textContent.trim()).filter((n) => n.startsWith('等你决定'));
    return r.querySelector('.skel, [class*=sk]') ? 'loading' : b.join('|') || 'no-waiting';
  })()`;
  await page.click({ role: 'button', name: '切换项目', exact: true });
  await watch(rowState);
  await page.click({ role: 'menuitem', name: '全部项目', exact: false });
  const row = () =>
    page.evaluate(`(() => {
      const r = [...document.querySelectorAll('section[role=region]')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(NAME)});
      if (!r) return null;
      return { text: r.innerText.replace(/\\s+/g, ' '), buttons: [...r.querySelectorAll('button')].map((x) => x.getAttribute('aria-label') ?? x.textContent.trim()) };
    })()`);
  const shown = await poll(async () => {
    const r = await row();
    return r?.buttons.includes('等你决定：1') && r;
  });
  result.row = shown || (await row());
  check(`有以项目名 "${NAME}" 命名的 region`, result.row, await names(NAME));
  check('该行有按钮 "等你决定：1"(= projects.summary needs_you)', shown, result.row);
  check('行里写出提问的正文', shown?.text.includes(QUESTION), shown?.text);
  // The list shows the first projects until "显示全部 N 个项目" is pressed.
  const all = (await names('显示全部')).find((n) => n.role === 'button');
  if (all) await page.click({ role: 'button', name: all.name, exact: true });
  await poll(
    async () =>
      (await page.evaluate(`document.querySelectorAll('section[role=region]').length`)) ===
      (await query('board')).projects.length,
  );
  const regions = await page.evaluate(
    `[...document.querySelectorAll('section[role=region]')].map((s) => s.getAttribute('aria-label'))`,
  );
  const listed = (await query('board')).projects.map((p) => p.name);
  check(
    '每个项目一个 region，名字是项目名',
    listed.every((n) => regions.includes(n)),
    { regions, listed },
  );
  check(
    '对照组：boot 项目 verify-app 的行没有 "等你决定"',
    !(await page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[role=region]')].find((s) => s.getAttribute('aria-label') === 'verify-app');
    return r ? [...r.querySelectorAll('button')].some((x) => (x.getAttribute('aria-label') ?? x.textContent).startsWith('等你决定')) : true;
  })()`)),
  );
  const firstStates = await states();
  result.first_open_states = firstStates;
  const drawn = firstStates.filter((s) => s !== 'none' && s !== 'loading');
  check('首次打开不闪：这一行落定前没画出别的数', new Set(drawn).size <= 1, firstStates);
  result.shot = await page.screenshot(result.id);

  // 2. The count opens the project's inbox.
  await page.click({
    role: 'button',
    name: '等你决定：1',
    exact: true,
    within: { role: 'region', name: NAME, exact: true },
  });
  const switched = await poll(() =>
    page.evaluate(
      `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(NAME)})`,
    ),
  );
  check('点 "等你决定：1" 后当前项目切到这个项目', switched);
  const inbox = await poll(() =>
    page.evaluate(`(() => {
      const t = document.body.innerText;
      return t.includes(${JSON.stringify(QUESTION)}) || t.includes(${JSON.stringify(LEAD)}) ? { question: t.includes(${JSON.stringify(QUESTION)}), lead: t.includes(${JSON.stringify(LEAD)}) } : null;
    })()`),
  );
  result.inbox = inbox;
  result.after = await page.evaluate(
    `({ hash: location.hash, pressed: [...document.querySelectorAll('[aria-pressed=true]')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()), current: [...document.querySelectorAll('[aria-current=true], [aria-current=page]')].map((b) => (b.getAttribute('aria-label') ?? b.textContent).trim().slice(0, 60)) })`,
  );
  check('进到该项目的收件箱：看得到等你答的 lead 会话', inbox?.lead, {
    inbox,
    after: result.after,
  });
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
