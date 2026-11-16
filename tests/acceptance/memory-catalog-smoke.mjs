import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startFixtureDaemon } from './lib/daemon.mjs';
import { launchDesktopApp } from './lib/desktop-app.mjs';
import { connect } from './lib/cdp.mjs';

// Isolated desktop + real daemon, no model runtime or user data. Build the desktop first.
const repoRoot = process.cwd();
const root = mkdtempSync(path.join(repoRoot, 'node_modules/.cache/memory-desktop-'));
const evidenceDir = path.join(repoRoot, '.notes/evidence/project-memory-catalog');
mkdirSync(evidenceDir, { recursive: true });
const source = path.join(root, 'source');
mkdirSync(source);
writeFileSync(path.join(source, 'manual.md'), '# Authoritative fixture manual\n');
const f = await startFixtureDaemon(root);
let app, page;
const deadline = Date.now() + 120000;
const button = (name) => ({
  role: 'button',
  name,
  exact: true,
  within: { role: 'region', name: '项目记忆', exact: true },
});
const click = async (name) => {
  console.log('Click', name);
  await page.click(button(name), Date.now() + 16000);
};
const wait = (expr, description) => page.waitFor(expr, description, Date.now() + 10000);
try {
  const project = await f.call('project.open', { name: 'Memory Catalog QA', roots: [source] });
  const save = async (key, text, extra = {}) => {
    const draft = await f.call('memory.propose', {
      project_id: project.id,
      key,
      kind: 'note',
      text,
      ...extra,
    });
    return f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  };
  for (let i = 0; i < 22; i++)
    await save('archive-note-' + i, '分页正文 ' + i, { title: 'Fixture note ' + i });
  const old = await save('database', '旧数据库内容', { title: '旧存储方案', tags: ['storage'] });
  const current = await save('database', '项目数据库使用 SQLite。必须验证来源。', {
    title: '本地数据库',
    summary: '当前存储决定',
    tags: ['storage'],
    references: [{ kind: 'file', uri: 'manual.md' }],
  });
  await save('analysis', '依据当前数据库的分析正文', {
    title: '数据库分析',
    dependencies: [current.id],
  });
  app = await launchDesktopApp({
    repoRoot,
    dataDir: path.join(root, 'state'),
    deadline,
    size: { width: 1280, height: 800 },
  });
  page = await connect(app.port, deadline, { evidenceDir });
  await page.evaluate("document.documentElement.classList.remove('dark')");
  await page.click({ role: 'button', name: 'Memory Catalog QA', exact: true }, Date.now() + 15000);

  await page.click({ role: 'radio', name: '项目记忆', exact: true }, Date.now() + 10000);
  console.log('MEMORY OPEN');
  await wait('document.querySelectorAll(".memory-row").length === 20', 'paginated directory');
  assert.equal(
    await page.evaluate('document.querySelector(".memory-detail article") === null'),
    true,
  );
  await click('下一页');
  await wait('document.querySelectorAll(".memory-row").length === 4', 'second page');
  await click('上一页');
  await wait('document.querySelectorAll(".memory-row").length === 20', 'first page');
  await page.fill({ role: 'textbox', name: '搜索记忆', exact: true }, '本地数据库');
  await click('搜索');
  await wait('document.querySelectorAll(".memory-row").length === 1', 'Chinese metadata filter');
  await page.click({ role: 'button', name: '本地数据库' });
  await wait(
    'document.querySelector(".memory-detail article")?.textContent.includes("必须验证来源")',
    'lazy detail',
  );
  await page.screenshot('directory-light');
  await page.fill({ role: 'textbox', name: '搜索记忆', exact: true }, '');
  await click('搜索');
  await page.click({ role: 'button', name: '本地数据库' });
  await click('所有版本');
  await page.click({ role: 'button', name: '本地数据库' });
  await click('关系图');
  await wait(
    'document.querySelectorAll(".memory-panel .react-flow__node").length >= 4',
    'version, source and dependent graph',
  );
  assert.equal(
    await page.evaluate(
      `document.querySelector('.memory-panel .react-flow').textContent.includes('替代')`,
    ),
    true,
  );
  await page.screenshot('relationships-light');
  await page.evaluate(
    `document.querySelector('.memory-panel .react-flow__node[data-id="${old.id}"]').focus()`,
  );
  await page.press('Enter');
  await wait(
    `document.querySelector('.memory-detail article')?.textContent.includes('旧数据库内容')`,
    'keyboard graph selection',
  );
  await page.click({ role: 'button', name: '本地数据库' });
  await wait(
    `document.querySelector('.memory-detail article')?.textContent.includes('必须验证来源')`,
    'directory and graph shared selection',
  );
  await click('归档');
  await wait(
    'document.querySelector(".memory-detail article")?.textContent.includes("恢复为草稿")',
    'archived detail',
  );
  await wait(
    `document.querySelector('.memory-panel .react-flow__node') && !document.querySelector('.memory-panel .vis-skel')`,
    'archived graph layout',
  );
  await click('恢复为草稿');
  await wait(
    'document.querySelector(".memory-detail article")?.textContent.includes("确认为当前版本")',
    'restored draft',
  );
  const active = await f.call('memory.search', { project_id: project.id, q: '必须验证来源' });
  assert.equal(active.items.length, 0);
  await click('确认为当前版本');
  await wait(
    'document.querySelector(".memory-detail article")?.textContent.includes("当前有效")',
    'confirmed restored version',
  );
  const activeAfter = await f.call('memory.search', { project_id: project.id, q: '必须验证来源' });
  assert.equal(activeAfter.items.length, 1);
  assert.notEqual(activeAfter.items[0].id, current.id);
  await page.evaluate(
    "document.documentElement.classList.add('dark'); document.body.classList.add('dark')",
  );
  await page.screenshot('relationships-dark');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.screenshot('relationships-dark-wide');
  writeFileSync(
    path.join(evidenceDir, 'desktop-result.json'),
    JSON.stringify(
      {
        passed: true,
        project_id: project.id,
        old_id: old.id,
        restored_id: activeAfter.items[0].id,
        checks: [
          'pagination',
          'Chinese metadata search',
          'lazy detail',
          'version/dependency/source graph',
          'archive',
          'restore-as-draft isolation',
          'confirm',
          'keyboard graph selection',
          'light/dark layouts',
        ],
      },
      null,
      2,
    ),
  );
  console.log('PASS memory desktop lifecycle');
} catch (error) {
  if (page) {
    console.error(
      await page
        .evaluate('document.body.innerText.slice(-6000)', Date.now() + 2000)
        .catch(() => 'page unavailable'),
    );
    await page.screenshot('failure', Date.now() + 2000).catch(() => {});
  }
  throw error;
} finally {
  page?.close();
  if (app) console.log('Desktop cleanup', await app.stop());
  await f.close();
  rmSync(root, { recursive: true, force: true });
}
