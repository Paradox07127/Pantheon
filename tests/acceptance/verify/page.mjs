// Opens the app that boot.mjs started. A driver script does:
//   const { run, page, query, call, errors, poll, names, reset, newProject } = await open(process.argv[2]);
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { connect } from '../lib/cdp.mjs';
import { projectShown } from '../lib/desktop-app.mjs';

/** `runDir` holds run.json; screenshots land in its screens/ folder. */
export async function open(runDir, { ms = 60_000 } = {}) {
  const run = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
  const page = await connect(run.port, Date.now() + ms, { evidenceDir: runDir });
  const headers = { Authorization: `Bearer ${run.token}` };

  // Records console errors and uncaught errors from now on; errors() reads them.
  await page.evaluate(`(() => {
    if (window.__verifyErrors) return;
    window.__verifyErrors = [];
    const push = (text) => window.__verifyErrors.push(String(text).slice(0, 500));
    const original = console.error;
    console.error = (...args) => { push(args.map(String).join(' ')); original(...args); };
    // Chromium's note that resize notifications move to the next frame; the board's canvas lays out its
    // cards inside React Flow's resize callback on purpose, so they land before the frame paints.
    addEventListener('error', (e) => /^ResizeObserver loop/.test(e.message) || push(e.message));
    addEventListener('unhandledrejection', (e) => push(e.reason?.message ?? e.reason));
  })()`);

  /** GET /v1/<name>; params become the query string. */
  const query = async (name, params = {}) => {
    const url = `${run.daemon_url}/v1/${name}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };

  /** POST /v1/commands as the user; returns the receipt. */
  const call = async (type, input, revision = null) => {
    const response = await fetch(`${run.daemon_url}/v1/commands`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, revision)),
    });
    const data = await response.json();
    if (response.status !== 200) throw new Error(`${type}: ${JSON.stringify(data)}`);
    return data.receipt;
  };

  const errors = () => page.evaluate('window.__verifyErrors ?? []');

  /** Calls `fn` until it returns a truthy value that is not an empty list, or `ms` passes; returns the last value, never throws on time. */
  const poll = async (fn, ms = 10_000) => {
    let value;
    for (const end = Date.now() + ms; Date.now() < end; await delay(200)) {
      value = await fn();
      // An empty list is truthy; a caller that polls for rows has not got them yet.
      if (Array.isArray(value) ? value.length : value) return value;
    }
    return value;
  };

  /** Every visible control whose accessible name contains `part`, with no cap on the count. */
  const names = (part = '') =>
    page.evaluate(`[...document.querySelectorAll('button, a, input, textarea, select, [role], [aria-label]')]
      .filter((el) => el.getClientRects().length)
      .map((el) => ({
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      }))
      .filter((c) => c.name.includes(${JSON.stringify(part)}))`);

  /** Closes dialogs, menus, popovers and the settings page a previous driver left open. */
  async function reset() {
    await page.press('Escape');
    await page.press('Escape');
    // The settings page may stay open after Escape, or still be leaving through its exit animation.
    const settingsShown = `(() => { const b = document.querySelector('button[aria-label="关闭设置"]'); return !!b && b.getClientRects().length > 0; })()`;
    let shown = await page.evaluate(settingsShown);
    for (const end = Date.now() + 1000; shown && Date.now() < end; await delay(100))
      shown = await page.evaluate(settingsShown);
    if (shown) await page.click({ role: 'button', name: '关闭设置', exact: true });
  }

  /** Shows project `name` in the app, through the sidebar's project switcher. */
  async function useProject(name) {
    const shown = `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(name)})`;
    if (await page.evaluate(shown)) return;
    await reset();
    await page.click({ role: 'button', name: '切换项目', exact: true });
    // Menu items carry the project's avatar letter before its name.
    await page.click({ role: 'menuitemradio', name, exact: false });
    await page.waitFor(projectShown(name), `the sidebar to show project ${name}`);
  }

  /**
   * A new project on its own git repository holding `files` ({ path: text }), opened in the app.
   * Under three files the daemon counts the folder as empty (packages/control/src/baseline.ts:91).
   */
  const newProject = async (name, files = { 'README.md': `# ${name}\n` }) => {
    const repo = path.join(run.workspace, 'projects', name);
    mkdirSync(repo, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
    }
    const env = {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Verify App');
    git('config', 'user.email', 'verify-app@example.invalid');
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'Initial commit');
    const project_id = (await call('project.open', { name, roots: [repo] })).id;
    await useProject(name);
    return { project_id, name, repo };
  };

  // Every driver starts on boot's project with nothing left open by the previous driver.
  await reset();
  await useProject(run.project_name);

  return { run, page, query, call, errors, poll, names, reset, newProject };
}
