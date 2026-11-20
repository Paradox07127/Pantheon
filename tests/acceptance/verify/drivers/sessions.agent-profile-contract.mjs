import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 170_000,
});
const result = { id: 'sessions.agent-profile-contract', checks: [] };
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
  const { project_id } = await newProject(`verify-agent-contract-${stamp}`, {
    'README.md': '# agent contract\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "agent-contract-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const triageOf = async () =>
    (await query('agent.list', { project_id })).find((a) => a.template === 'triage');
  const triage = await triageOf();
  // The wake note quotes the prompt; the closing quote lands on the line after the script.
  const SWEEP = `Sweep ${stamp}`;
  const prompt = `${SWEEP}\nfixture-script\n${JSON.stringify([{ say: 'Sweep ran.' }, { wait: 6000 }])}\nend`;
  await call('agent.update', {
    agent_id: triage.id,
    revision: triage.revision,
    routines: [{ id: 'sweep', prompt, every_minutes: 60, enabled: true }],
  });
  const wakesOf = () => query('agent.wakes', { agent_id: triage.id, limit: '10' });
  const settled = () =>
    poll(async () => {
      const list = await wakesOf();
      return list.length && list.every((w) => !['queued', 'running'].includes(w.state)) && list;
    }, 30_000);
  await call('agent.routine.run', { agent_id: triage.id, routine_id: 'sweep' });
  const first = await settled();
  check('前置：一次例行运行结束', first?.[0]?.state === 'completed', first?.[0]?.state);

  // 1. Sidebar agents zone > Triage > its profile.
  const NAME = '问题处理';
  const ZONE = { role: 'group', name: '本项目', exact: true };
  const rowSel = `nav.ss-list [role=group][aria-label="本项目"] .ss-rr[data-stop="resident:${triage.id}"]`;
  await poll(() => page.evaluate(`!!document.querySelector(${JSON.stringify(rowSel)})`));
  await page.click({ role: 'button', name: `${NAME}，`, exact: false, within: ZONE });
  const { x, y } = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(rowSel)});
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  const mouse = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
  const LABEL = `${NAME}的资料`;
  const ASIDE = `aside.ag-insp[aria-label=${JSON.stringify(LABEL)}]`;
  const sectionState = `(() => {
    const a = document.querySelector(${JSON.stringify(ASIDE)});
    if (!a) return 'none';
    return [...a.querySelectorAll('section')].map((s) => {
      const cap = document.getElementById(s.getAttribute('aria-labelledby'))?.textContent ?? '?';
      return cap + (s.querySelector('[aria-busy=true]') ? '…' : '');
    }).join('|');
  })()`;
  await watch(sectionState);
  await page.click({ role: 'menuitem', name: '资料', exact: true });
  const opened = await poll(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(ASIDE)})`),
  );
  check(`打开了 "${LABEL}"`, opened, await names('的资料'));

  const panel = () =>
    page.evaluate(`(() => {
      const a = document.querySelector(${JSON.stringify(ASIDE)});
      if (!a) return null;
      const sec = (cap) => [...a.querySelectorAll('section')].find((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === cap);
      const week = sec('本周');
      const contract = sec('约定');
      return {
        sections: [...a.querySelectorAll('section')].map((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent ?? null),
        busy: !!a.querySelector('[aria-busy=true]'),
        budget: a.querySelector('input.ag-num')?.value ?? null,
        spent: contract?.querySelector('.ag-sp .ag-num')?.textContent ?? null,
        meter: contract?.querySelector('[role=img].meter')?.getAttribute('aria-label') ?? null,
        held: contract?.innerText.includes('唤醒已暂停') ?? null,
        loudest: [...(contract?.querySelectorAll('[role=radio]') ?? [])].filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent),
        quiet: contract?.querySelector('input[type=checkbox]')?.checked ?? null,
        wakes: [...(sec('最近唤醒')?.querySelectorAll('button') ?? [])].map((b) => ({ name: b.getAttribute('aria-label'), text: b.innerText.replace(/\\s+/g, ' ') })),
        runs: [...(sec('例行运行')?.querySelectorAll('[role=group]') ?? [])].map((g) => ({ name: g.getAttribute('aria-label'), run: g.querySelector('button')?.textContent, disabled: g.querySelector('button')?.disabled, text: g.innerText.replace(/\\s+/g, ' ') })),
        weekWakes: week?.querySelector('.ag-lw .ag-big')?.textContent ?? null,
        weekText: week?.innerText.replace(/\\s+/g, ' ') ?? null,
      };
    })()`);
  const loaded = await poll(async () => {
    const p = await panel();
    return p && !p.busy && p.weekWakes !== null && p;
  });
  const shown = loaded || (await panel());
  result.panel = shown;
  const ORDER = ['约定', '最近唤醒', '例行运行', '本周'];
  const at = ORDER.map((cap) => shown?.sections.indexOf(cap));
  check(
    '分区依次有 约定、最近唤醒、例行运行、本周',
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    shown?.sections,
  );
  const firstStates = await states();
  result.first_open_states = firstStates;
  // A section may go from loading to loaded; a drawn section must not disappear or move afterwards.
  const drawn = firstStates.filter((s) => s !== 'none').map((s) => s.replace(/…/g, '').split('|'));
  const shrank = drawn.some((list, i) => i > 0 && drawn[i - 1].some((cap) => !list.includes(cap)));
  check('首次打开不闪：画出的分区没有再消失', !shrank, firstStates);

  // 2. Contract, against agent.list and agent.ledger.
  const ledger = (await query('agent.ledger', { agent_id: triage.id, weeks: '1' }))[0];
  result.ledger = ledger;
  check(
    '约定 "本周已花" 等于 agent.ledger 的 input_tokens',
    shown?.spent === String(ledger.input_tokens),
    {
      shown: shown?.spent,
      ledger: ledger.input_tokens,
    },
  );
  await page.fill({ role: 'textbox', name: '每周预算', exact: true }, '5000');
  await page.press('Tab');
  const budget = await poll(async () => (await triageOf()).contract?.weekly_input_tokens === 5000);
  check(
    '填 "每周预算" 5000 后 agent.list 的 contract.weekly_input_tokens=5000',
    budget,
    (await triageOf()).contract,
  );
  const meter = await poll(async () => (await panel())?.meter);
  check('有了预算后显示 "已花每周预算的 N%" 的计量条', meter === '已花每周预算的 0%', meter);
  await page.click({ role: 'radio', name: '通知', exact: true });
  const loud = await poll(async () => (await triageOf()).contract?.loudest === 'notify');
  check('点 最响级别 "通知" 后 contract.loudest=notify', loud, (await triageOf()).contract);
  const loudShown = await poll(async () => (await panel())?.loudest.join() === '通知');
  check('最响级别选中 "通知"', loudShown, (await panel())?.loudest);
  await page.click({ role: 'checkbox', name: '免打扰时段', exact: true });
  const quiet = await poll(async () => (await triageOf()).contract?.quiet_hours);
  check(
    '打开 免打扰时段 后 contract.quiet_hours 是 22:00-08:00',
    quiet?.from === '22:00' && quiet?.to === '08:00',
    quiet,
  );
  const kept = (await triageOf()).contract;
  check(
    '三项各自保存，互不覆盖',
    kept?.weekly_input_tokens === 5000 && kept?.loudest === 'notify',
    kept,
  );
  const now = await panel();
  check(
    '"唤醒已暂停" 与预算一致：本周已花 < 预算时不显示',
    now?.held === false && ledger.input_tokens < 5000,
    { held: now?.held, spent: ledger.input_tokens },
  );

  // 3. Recent wakes and the week, against agent.wakes and agent.ledger.
  const wakes = await wakesOf();
  check(
    '最近唤醒 的行数等于 agent.wakes(最多 5)',
    now?.wakes.length === Math.min(5, wakes.length),
    {
      ui: now?.wakes.length,
      daemon: wakes.length,
    },
  );
  check(
    '唤醒行写原因 "例行任务" 和例行任务名',
    now?.wakes[0]?.text.includes('例行任务') && now.wakes[0].text.includes(SWEEP),
    now?.wakes[0],
  );
  check('本周 的唤醒数等于 agent.ledger 的 wakes', now?.weekWakes === String(ledger.wakes), {
    ui: now?.weekWakes,
    ledger: ledger.wakes,
  });
  check('对照组：本周唤醒数不是 0', now?.weekWakes !== '0', now?.weekWakes);

  // 4. Routine runs: run now from the profile.
  const run = now?.runs.find((r) => r.name === SWEEP);
  check(
    '例行运行 有组 "{例行任务名}"，带可点的 "立即运行"',
    run && run.run === '立即运行' && !run.disabled,
    now?.runs,
  );
  check(
    '例行运行 里没有 暂停/恢复',
    now?.runs.every((r) => !/暂停|恢复/.test(r.text.replace('已暂停', ''))),
    now?.runs,
  );
  await page.click({
    role: 'button',
    name: '立即运行',
    exact: true,
    within: { role: 'group', name: SWEEP, exact: true },
  });
  // A wake soon after the last one starts later; the samples keep what the row showed meanwhile.
  const clicked = Date.now();
  const samples = [];
  const during = await poll(async () => {
    const latest = (await wakesOf())[0];
    const r = (await panel())?.runs.find((x) => x.name === SWEEP);
    const sample = { ms: Date.now() - clicked, wake: latest?.state, disabled: r?.disabled };
    if (JSON.stringify({ ...samples.at(-1), ms: 0 }) !== JSON.stringify({ ...sample, ms: 0 }))
      samples.push(sample);
    if (!['queued', 'running'].includes(latest?.state) || latest.turn_id === first[0].turn_id)
      return null;
    return r?.disabled ? sample : null;
  }, 90_000);
  result.run_now_samples = samples;
  check('运行中 "立即运行" 禁用(agent.wakes 同时为 queued/running)', during, samples);
  const second = await settled();
  const wakesShown = await poll(async () => {
    const p = await panel();
    return p?.wakes.length === Math.min(5, second?.length ?? 0) && p;
  });
  check('再运行一次后 最近唤醒 多一行', wakesShown, {
    ui: (await panel())?.wakes.length,
    daemon: second?.length,
  });
  const week2 = (await query('agent.ledger', { agent_id: triage.id, weeks: '1' }))[0];
  const weekShown = await poll(async () => (await panel())?.weekWakes === String(week2.wakes));
  check('本周 唤醒数跟着变，等于 agent.ledger', weekShown, {
    ui: (await panel())?.weekWakes,
    ledger: week2.wakes,
  });

  // 5. Weekly budget used up: fixture turns report no input tokens, so spent stays 0 and the cap is at least 1.
  result.held_blocked =
    'agent.ledger input_tokens is 0 for fixture turns and weekly_input_tokens must be positive; "唤醒已暂停" cannot be reached';
  result.shot = await page.screenshot(result.id);
  await page.click({ role: 'button', name: '关闭资料', exact: true });
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
