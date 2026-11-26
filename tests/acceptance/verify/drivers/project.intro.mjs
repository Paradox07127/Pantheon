import { open } from '../page.mjs';
const { run, page, query, errors, poll } = await open(process.argv[2]);
const result = { id: 'project.intro', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The fixture runtime cannot write an intro, so boot's project has none.
const intro = await query('project.intro.read', { project_id: run.project_id });
result.intro = intro;
const firstParagraph = intro.intro?.summary?.split(/\n\s*\n/)[0]?.trim() ?? null;

await page.click({ role: 'button', name: '项目', exact: true });
const readCard = () =>
  page.evaluate(`(() => {
    const card = [...document.querySelectorAll('section[aria-label="项目介绍"]')].find((e) => e.getClientRects().length);
    if (!card) return null;
    const button = [...card.querySelectorAll('button[aria-expanded]')].find((b) => b.getClientRects().length);
    const head = button?.closest('.pj-ch');
    return {
      label: button?.textContent.trim() ?? null,
      expanded: button?.getAttribute('aria-expanded') ?? null,
      body: [...card.children].filter((c) => c !== head).map((c) => c.innerText.trim()).join('\\n'),
    };
  })()`);
let card = await poll(readCard, 10_000);
if (card?.expanded === 'true') {
  await page.click({ role: 'button', name: '收起', exact: true });
  card = await poll(async () => {
    const v = await readCard();
    return v?.expanded === 'false' && v;
  });
}
result.collapsed = card;
check(
  '默认收起：按钮 "展开"，aria-expanded=false',
  card?.label === '展开' && card.expanded === 'false',
  card,
);
check(
  '后端对照：收起时只显示 intro.summary 的第一段(没有介绍时为空)',
  firstParagraph === null ? card?.body === '' : card?.body === firstParagraph,
  { body: card?.body, firstParagraph },
);
check('对照组：收起时的正文不是别的文字', card?.body !== 'absent-intro-text', card?.body);
result.shot = await page.screenshot(result.id);

await page.click({ role: 'button', name: '展开', exact: true });
const open1 =
  (await poll(async () => {
    const v = await readCard();
    return v?.expanded === 'true' && v;
  }, 5_000)) || (await readCard());
result.expanded = open1;
check(
  '点 "展开" 后 aria-expanded=true，按钮变 "收起"',
  open1?.expanded === 'true' && open1.label === '收起',
  open1,
);
check(
  '展开后在 "项目介绍" 里原地显示介绍视图(没有介绍时是它的空状态)',
  open1?.body.length > 0,
  open1?.body,
);
result.shot2 = await page.screenshot(`${result.id}-expanded`);

await page.click({ role: 'button', name: '收起', exact: true });
const closed =
  (await poll(async () => {
    const v = await readCard();
    return v?.expanded === 'false' && v;
  }, 5_000)) || (await readCard());
result.closedAgain = closed;
check(
  '点 "收起" 后 aria-expanded=false，按钮变回 "展开"',
  closed?.expanded === 'false' && closed.label === '展开',
  closed,
);
check('对照组：收起后的读法对 "true" 判 false', closed?.expanded !== 'true', closed?.expanded);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
