import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { LeadFixtureAdapter } from '../fixtures/lead-fixture-adapter.mjs';
import { connect, describeLocator } from '../lib/cdp.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { checkDesktopBuild, launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '主工位可理解与操作';
export const mode = 'ui';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Shorter than the case's own timeout, which kills the worker without running its cleanup. */
const RUN_MS = 85 * 1000;
/** How long one screen may take to show its regions before they count as missing. */
const VIEW_MS = 8000;
export const WINDOW = { width: 1440, height: 900 };
const PROJECT_NAME = 'Notes export';
const SILENT_RUNTIME = 'fixture-silent';
const plan = {
  base_version: 0,
  headline: 'Ship the notes export',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'code',
      title: 'Add the export command',
      goal: 'Add export.txt',
      lane: 'main',
      milestone: 'export',
      depends_on: [],
      source: ['Add an export command'],
      scope: ['export.txt'],
      acceptance: ['test -f export.txt'],
    },
    {
      id: 'notes',
      title: 'Write the export notes',
      goal: 'Write notes.md for the export command',
      lane: 'main',
      milestone: 'export',
      depends_on: [],
      source: ['Write down how the export works'],
      scope: ['notes.md'],
      acceptance: [],
      done_when: 'report',
    },
    {
      id: 'cleanup',
      title: 'Remove the old exporter',
      goal: 'Delete old-export.sh',
      lane: 'main',
      milestone: 'export',
      depends_on: [],
      source: ['Remove the old exporter'],
      scope: ['old-export.sh'],
      acceptance: ['test ! -f old-export.sh'],
    },
  ],
  milestones: [
    {
      id: 'export',
      title: 'Export ready',
      criteria: ['The export command, its notes and the cleanup are done'],
      tasks: ['code', 'notes', 'cleanup'],
    },
  ],
  risks: [],
  assumptions: [],
};
const [CODE, NOTES, BLOCKED] = plan.tasks;

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const done = (task, file, text) =>
  script(
    { write: { path: file, text } },
    { commit: `Add ${file}` },
    { tool: { name: 'report', arguments: { kind: 'done', text: `${task.title} is finished` } } },
  );
const TASK_SESSIONS = [
  { task: CODE, runtime: 'fixture', input: done(CODE, 'export.txt', 'export\n') },
  { task: NOTES, runtime: SILENT_RUNTIME, input: done(NOTES, 'notes.md', '# Export\n') },
  // Waits on the user's approval until the run ends.
  {
    task: BLOCKED,
    runtime: 'fixture',
    input: script({ ask: { tool: 'Bash', input: { command: 'rm old-export.sh' } } }),
  },
];

const NAV = { name: '导航', exact: true };
const SETTINGS = { role: 'dialog', name: '设置', exact: true };
const button = (name, extra = {}) => ({ role: 'button', name, exact: true, ...extra });
const ALERTS = `[...document.querySelectorAll('[role="alert"]')]
  .filter((el) => el.getClientRects().length > 0)
  .map((el) => el.innerText.trim() || 'an empty alert')
  .join(' | ')`;
export const nextFrames =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';
const THEMES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** Runs in the page: for each wanted role, name and text, how many visible elements match. */
function regionsShown(wanted) {
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    switch (el.localName) {
      case 'main':
        return 'main';
      case 'nav':
        return 'navigation';
      case 'aside':
        return 'complementary';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
          ? 'region'
          : null;
      case 'ul':
      case 'ol':
        return 'list';
      case 'h1':
      case 'h2':
      case 'h3':
        return 'heading';
      case 'input':
        return el.type === 'search' ? 'searchbox' : null;
      default:
        return null;
    }
  };
  const nameOf = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids)
      return clean(
        ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    return roleOf(el) === 'heading' ? clean(el.textContent) : '';
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const all = [...document.querySelectorAll('*')];
  const inside = (el, within) =>
    all.some(
      (box) => roleOf(box) === within.role && nameOf(box) === within.name && box.contains(el),
    );
  return wanted.map((want) => ({
    ...want,
    found: all.filter(
      (el) =>
        roleOf(el) === want.role &&
        (want.name === undefined || nameOf(el) === want.name) &&
        visible(el) &&
        (want.text === undefined || clean(el.textContent).includes(want.text)) &&
        (want.within === undefined || inside(el, want.within)),
    ).length,
  }));
}

/**
 * Runs in the page: the WCAG contrast of the visible text and status graphics against the colour
 * behind them, as tests/web/web-contrast.test.ts computes it. Text needs 4.5:1, graphics 3:1.
 */
function measureReadability() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const parsed = new Map();
  // Any CSS colour as sRGB bytes and alpha, through the canvas.
  const rgba = (css) => {
    if (!parsed.has(css)) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      parsed.set(css, [r, g, b, a / 255]);
    }
    return parsed.get(css);
  };
  const over = (top, under) => [
    ...[0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])),
    1,
  ];
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 2);
  const root = getComputedStyle(document.documentElement);
  const canvasColour = over(rgba(root.backgroundColor), [255, 255, 255, 1]);
  const token = (name) => rgba(root.getPropertyValue(name).trim());
  const [body, secondary, muted] = ['--tx', '--tx2', '--mu'].map(token);
  // The fills behind the element over the window's colour; null over an image or gradient.
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return null;
      const fill = rgba(style.backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] === 1) break;
    }
    return layers.reduceRight((under, layer) => over(layer, under), canvasColour);
  };
  // A looping animation's opacity is not its resting look.
  const opacity = (el) => {
    let value = 1;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.animationName === 'none') value *= Number(style.opacity);
    }
    return value;
  };
  const shown = (el, box) => {
    if (box.width === 0 || box.height === 0) return false;
    if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight)
      return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    const x = Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el.contains(hit) || hit.contains(el));
  };
  const where = (el) =>
    [
      el.localName,
      ...(el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2),
    ].join('.');
  const hex = (c) =>
    `#${c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')}`;
  const pairs = new Map();
  const counts = { text: 0, graphic: 0, skipped: 0 };
  const add = (kind, role, min, raw, el, bg, sample) => {
    const fg = over([raw[0], raw[1], raw[2], raw[3] * opacity(el)], bg);
    const ratio = contrast(fg, bg);
    const key = [kind, role, hex(fg), hex(bg)].join(' ');
    const pair = pairs.get(key) ?? {
      kind,
      role,
      min,
      ratio: Math.round(ratio * 100) / 100,
      fg: hex(fg),
      bg: hex(bg),
      count: 0,
      example: sample,
      where: where(el),
    };
    pair.count += 1;
    pairs.set(key, pair);
    counts[kind] += 1;
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('[disabled], [aria-disabled="true"], .skel')) continue;
    const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    if (!shown(el, range.getBoundingClientRect())) continue;
    const style = getComputedStyle(el);
    const raw = rgba(el instanceof SVGElement ? style.fill : style.color);
    if (raw[3] === 0) continue;
    const bg = backdrop(el);
    if (!bg) {
      counts.skipped += 1;
      continue;
    }
    const sample = text.textContent.trim().slice(0, 40);
    // Letters hidden from assistive technology, like a project's monogram, are marks, not text.
    if (el.closest('[aria-hidden="true"]')) {
      add('graphic', 'mark', 3, raw, el, bg, sample);
      continue;
    }
    const role = same(raw, body)
      ? 'body'
      : same(raw, secondary) || same(raw, muted)
        ? 'secondary'
        : 'other';
    add('text', role, 4.5, raw, el, bg, sample);
  }
  const paint = (el) => {
    const style = getComputedStyle(el);
    if (el.matches('svg.si')) return rgba(style.color);
    if (el.matches('.ss-dot')) {
      const fill = rgba(style.backgroundColor);
      return fill[3] > 0 ? fill : rgba(style.borderTopColor);
    }
    for (const shape of el.querySelectorAll('circle, path, rect, polygon, line')) {
      const s = getComputedStyle(shape);
      const stroke = rgba(s.stroke);
      if (s.stroke !== 'none' && stroke[3] > 0) return stroke;
      const fill = rgba(s.fill);
      if (s.fill !== 'none' && fill[3] > 0) return fill;
    }
    return null;
  };
  for (const el of document.querySelectorAll('svg.si, svg.bd-sti, .ss-dot')) {
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    if (!shown(el, el.getBoundingClientRect())) continue;
    const raw = paint(el);
    if (!raw) continue;
    const bg = backdrop(el.parentElement);
    if (!bg) {
      counts.skipped += 1;
      continue;
    }
    const sample = el.getAttribute('aria-label') ?? el.getAttribute('data-state') ?? where(el);
    add('graphic', 'status', 3, raw, el, bg, sample);
  }
  const all = [...pairs.values()];
  return {
    counts,
    pairs: all.length,
    below: all.filter((pair) => pair.ratio < pair.min),
    lowest: Object.fromEntries(
      ['text', 'graphic'].map((kind) => [
        kind,
        all.filter((pair) => pair.kind === kind).sort((a, b) => a.ratio - b.ratio)[0] ?? null,
      ]),
    ),
  };
}

/** Runs in the page: the runtime tabs of the extension settings, with the reason each shows. */
function runtimeTabs() {
  return [...document.querySelectorAll('button.ps-tab')].map((tab) => {
    const why = tab.querySelector('.ps-why');
    const box = why?.getBoundingClientRect();
    return {
      runtime: tab.querySelector('.ps-rt')?.textContent.trim() ?? '',
      disabled: tab.disabled || tab.getAttribute('aria-disabled') === 'true',
      reason: why?.textContent.trim() ?? '',
      reason_visible: !!box && box.width > 0 && box.height > 0,
    };
  });
}

/** Runs in the page: the run's totals and the run tree's cards, once the totals are read. */
function runUsage(silentTitle) {
  const stats = document.querySelector('dl.rt-stats');
  if (!stats || stats.getAttribute('aria-busy') === 'true') return false;
  const facts = [...stats.querySelectorAll(':scope > div')].map((row) => ({
    label: row.querySelector('dt')?.textContent.trim() ?? '',
    value: row.querySelector('dd')?.textContent.trim() ?? '',
    note: row.querySelector('dd')?.getAttribute('aria-label') ?? null,
  }));
  if (facts.some((fact) => fact.value === '' && !fact.note)) return false;
  const nodes = [...document.querySelectorAll('.rt-node')].map((node) => ({
    title: node.querySelector('.rt-card-t')?.textContent.trim() ?? '',
    text: node.textContent.replace(/\s+/g, ' ').trim(),
  }));
  if (!nodes.some((node) => node.title === silentTitle)) return false;
  return { label: stats.getAttribute('aria-label'), facts, nodes };
}

/** Runs in the page: the usage tab's key figures and every label or line naming the runtime. */
function boardUsage(runtime) {
  const overview = document.querySelector('section[aria-label="用量概览"]');
  if (!overview) return false;
  const tiles = [...overview.querySelectorAll('.bd-kpi')].map((tile) => ({
    label: tile.querySelector('.bd-kpi-k')?.textContent.trim() ?? '',
    value: tile.querySelector('.bd-kpi-v b')?.textContent.trim() ?? '',
  }));
  if (!tiles.length) return false;
  const panel = overview.closest('[role="tabpanel"]') ?? document.body;
  const labels = [...panel.querySelectorAll('[aria-label]')].map((el) =>
    el.getAttribute('aria-label'),
  );
  const lines = panel.innerText.split('\n').map((line) => line.trim());
  return {
    tiles,
    totals: labels.filter((label) => label.includes('合计')),
    runtime_labels: labels.filter((label) => label.includes(runtime)),
    runtime_lines: lines.filter((line) => line.includes(runtime)),
  };
}

/** Runs in the page: the centre of a connectable handle of the flow node, once it is drawn. */
function handleCentre(nodeId, kind) {
  const node = [...document.querySelectorAll('.bd-em-canvas .bd-fc .react-flow__node')].find(
    (el) => el.dataset.id === nodeId,
  );
  node?.scrollIntoView({ block: 'nearest' });
  const box = node
    ?.querySelector(`.react-flow__handle.${kind}.connectable`)
    ?.getBoundingClientRect();
  return !!box && box.width > 0 && { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Starts a montage of `rows` rows of two tiles in the page. */
const montageStart = (rows, w, h) => `(() => {
  const canvas = new OffscreenCanvas(${w * 2}, ${h * rows});
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  globalThis.__acceptanceMontage = { canvas, context };
  return true;
})()`;
const montageTile = (data, x, y, w, h, label) => `(async () => {
  const { context } = globalThis.__acceptanceMontage;
  const image = await createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  context.drawImage(image, ${x}, ${y}, ${w}, ${h});
  context.fillStyle = 'rgba(0, 0, 0, 0.75)';
  context.fillRect(${x}, ${y}, ${w}, 24);
  context.fillStyle = '#ffffff';
  context.font = '14px sans-serif';
  context.fillText(${JSON.stringify(label)}, ${x + 8}, ${y + 17});
  return true;
})()`;
const montageEnd = `(async () => {
  const { canvas } = globalThis.__acceptanceMontage;
  delete globalThis.__acceptanceMontage;
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
})()`;

const PLAIN_NUMBER = /^\d[\d.]*[kM]?$/;
const PARTIAL = /已知|未知|不完整|—/;
const ZERO_TOKENS = /(^|[^\d.])0 tokens/;
const zeroIn = (text) => text.split(/[\s，,；;：:/()（）]+/).includes('0');

export async function run({ workspace, evidenceDir, humanReview }) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const stateDir = path.join(workspace, 'state');
  const repo = path.join(workspace, 'repo');
  const observations = {},
    receipts = [],
    cdpLog = [],
    screens = [],
    tiles = [],
    views = {},
    readability = [],
    timings = { steps: [] },
    ids = {};
  const evidence = {};
  let fixture, daemon, app, page, projectId, failure, current, capability, usage, review, flowEdit;

  const left = (until = deadline) => until - Date.now();
  const get = async (method, params = {}) => {
    if (left() <= 0) throw new Error(`Timed out: GET ${method}`);
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(Math.min(15000, left())),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const call = async (type, input, revision = null) => {
    if (left() <= 0) throw new Error(`Timed out: ${type}`);
    const response = await fetch(`${daemon.url}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, revision)),
      signal: AbortSignal.timeout(Math.min(15000, left())),
    });
    const data = await response.json();
    receipts.push({ step: current, type, status: response.status, data });
    if (response.status !== 200) throw new Error(`${type}: ${JSON.stringify(data)}`);
    return data.receipt;
  };
  const board = () => get('board', { project_id: projectId });
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const poll = async (check, description, until = deadline) => {
    for (;;) {
      const value = await check();
      if (value) return value;
      if (left(until) <= 0) throw new Error(`Timed out: ${description}`);
      await delay(Math.min(200, Math.max(0, left(until))));
    }
  };

  const logged = async (op, target, action) => {
    const entry = { step: current, op, target };
    const begun = Date.now();
    try {
      const value = await action();
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: 'ok' });
      return value;
    } catch (error) {
      cdpLog.push({ ...entry, ms: Date.now() - begun, result: error.message.slice(0, 2000) });
      throw error;
    }
  };
  const click = (locator) => logged('click', describeLocator(locator), () => page.click(locator));
  const waitUi = (expression, description, until = deadline) =>
    logged('waitFor', description, () =>
      page.waitFor(expression, description, until, { failWhen: ALERTS }),
    );
  const read = (expression, description) =>
    logged('evaluate', description, () => page.evaluate(expression));
  const shot = async (name) => {
    const taken = await logged('screenshot', name, () => page.screenshot(name));
    screens.push({ step: current, ...taken });
    return taken;
  };
  const regions = (wanted) => `(${regionsShown})(${JSON.stringify(wanted)})`;
  /** Waits a while for every wanted region; returns each with how many visible elements match. */
  const expectRegions = async (wanted, description) => {
    try {
      return await waitUi(
        `(() => { const found = ${regions(wanted)}; return found.every((r) => r.found > 0) && found; })()`,
        description,
        Math.min(deadline, Date.now() + VIEW_MS),
      );
    } catch (error) {
      if (page.failure) throw error;
      const found = await read(regions(wanted), description);
      return found.map((r) => ({ ...r, error: error.message.split('\n')[0] }));
    }
  };
  const setTheme = async (value) => {
    await logged('emulate', `prefers-color-scheme ${value}`, () =>
      page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value }],
      }),
    );
    await waitUi(
      `document.documentElement.classList.contains('dark') === ${value === 'dark'}`,
      `the app to take the ${value} theme`,
    );
  };
  // A pointer left on a control shows its tooltip in the shot.
  const parkPointer = () =>
    logged('mouseMoved', 'the bottom-right corner', async () => {
      const [w, h] = await page.evaluate('[innerWidth, innerHeight]');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: w - 4, y: h - 4 });
    });
  /** Presses the left button at `from`, moves it in steps to `to` and lets go there. */
  const drag = (from, to, target) =>
    logged('drag', target, async () => {
      const mouse = (type, { x, y }, extra) =>
        page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
      await mouse('mouseMoved', from, { button: 'none' });
      await mouse('mousePressed', from, { buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++)
        await mouse(
          'mouseMoved',
          { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 },
          { buttons: 1 },
        );
      await mouse('mouseReleased', to, { buttons: 0, clickCount: 1 });
    });

  const flush = () =>
    writeEvidence(evidenceDir, {
      'views.json': views,
      'readability.json': readability,
      'cdp-log.json': cdpLog,
      'timings.json': timings,
      'receipts.json': receipts,
    });
  const step = async (name, action) => {
    current = name;
    const begun = Date.now();
    try {
      await action();
    } finally {
      timings.steps.push({ name, ms: Date.now() - begun });
      await flush();
    }
  };

  // A finished session sits in the settled group, which starts folded.
  const openSession = async (title) => {
    await logged('click', 'the folded settled group header', () =>
      page.evaluate(
        `document.querySelector('nav[aria-label="会话"] section[aria-label="已了结"] > button[aria-expanded="false"]')?.click()`,
      ),
    );
    await click({ role: 'button', name: `${title}，`, within: NAV });
  };

  const STOPS = [
    {
      key: 'sessions',
      name: '会话',
      open: () => openSession(ids.leadTitle),
      regions: () => [
        { role: 'main', name: '对话' },
        { role: 'navigation', name: '会话' },
      ],
    },
    {
      key: 'board',
      name: '项目看板',
      open: () => click(button('项目看板', { within: NAV })),
      regions: () => [
        { role: 'main' },
        { role: 'region', name: '结论', text: plan.headline },
        { role: 'tablist', name: '项目看板' },
      ],
    },
    {
      key: 'runtime',
      name: '运行',
      open: () => click(button('运行', { within: NAV })),
      regions: () => [
        { role: 'main' },
        { role: 'region', name: '活跃任务' },
        { role: 'radiogroup', name: '视图' },
      ],
    },
    {
      key: 'flow',
      name: '流程图',
      open: () => click(button('流程图', { within: NAV })),
      regions: () => [
        { role: 'main' },
        { role: 'radiogroup', name: '视图' },
        { role: 'region', name: '流程图' },
      ],
    },
    {
      key: 'trace',
      name: '轨迹',
      open: () => click(button('轨迹', { within: NAV })),
      regions: () => [{ role: 'main' }, { role: 'list', name: '会话' }],
    },
    {
      // The session list's inbox group stands in for the inbox screen; the waiting session is in it.
      key: 'inbox',
      name: '收件箱',
      open: () => openSession(ids.leadTitle),
      regions: () => [
        { role: 'navigation', name: '会话' },
        { role: 'region', name: '收件箱', within: { role: 'navigation', name: '会话' } },
      ],
    },
    {
      key: 'projects',
      name: '全部项目',
      open: () => click(button('全部项目')),
      regions: () => [
        { role: 'main' },
        { role: 'heading', name: '全部项目' },
        { role: 'searchbox', name: '搜索项目' },
      ],
    },
    {
      key: 'settings',
      name: '设置',
      open: async () => {
        await click(button('设置', { within: NAV }));
        await click(button('扩展', { within: { name: '设置分区', exact: true } }));
      },
      regions: () => [
        { role: 'navigation', name: '设置分区', within: SETTINGS },
        { role: 'main', name: '扩展', within: SETTINGS },
        { role: 'group', name: '运行时', within: SETTINGS },
      ],
      close: () => click(button('关闭设置', { within: SETTINGS })),
    },
    {
      key: 'needs-you',
      name: '需要你',
      open: async () => {
        await click(button('运行', { within: NAV }));
        await waitUi(
          `(() => { const strip = document.querySelector('section.bf-strip[aria-label="需要你"]'); if (!strip) return false; strip.scrollIntoView({ block: 'nearest' }); return ${nextFrames}; })()`,
          'the needs-you strip to scroll into view',
        );
      },
      regions: () => [{ role: 'region', name: '需要你', text: BLOCKED.title }],
    },
  ];

  try {
    await step('seed', async () => {
      const build = await checkDesktopBuild(repoRoot);
      timings.build = build;
      if (!build.fresh)
        throw new Error(
          `apps/desktop/out is older than its inputs (newest input ${JSON.stringify(build.newest_input)}, oldest output ${JSON.stringify(build.oldest_output)}); run pnpm build && pnpm --filter @pantheon/desktop bundle first`,
        );
      const noHooks = path.join(workspace, 'no-hooks');
      for (const dir of [
        repo,
        noHooks,
        path.join(workspace, 'workspaces'),
        path.join(workspace, 'backups'),
      ])
        await mkdir(dir, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 'Workbench Screens');
      git(repo, 'config', 'user.email', 'workbench-screens@example.invalid');
      git(repo, 'config', 'commit.gpgsign', 'false');
      git(repo, 'config', 'core.hooksPath', noHooks);
      await writeFile(path.join(repo, 'README.md'), 'Notes export\n');
      await writeFile(path.join(repo, 'old-export.sh'), 'echo old\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'Initial commit');
      // Every turn of the reporting runtime reports its tokens; the silent one reports none.
      // The lead on the reporting runtime answers the notes it is woken with.
      const reporting = new LeadFixtureAdapter(40, false, true);
      const silent = new FixtureAdapter();
      silent.name = SILENT_RUNTIME;
      silent.report = { ...silent.report, runtime: SILENT_RUNTIME };
      await mkdir(path.join(workspace, 'home'), { recursive: true });
      fixture = await startNativeDaemon(workspace, [reporting, silent], {
        intervalMs: 200,
        home: path.join(workspace, 'home'),
      });
      ({ daemon } = fixture);
      projectId = (await call('project.open', { name: PROJECT_NAME, roots: [repo] })).id;
    });

    await step('launch', async () => {
      app = await launchDesktopApp({ repoRoot, dataDir: stateDir, deadline, size: WINDOW });
      timings.app = { pid: app.pid, port: app.port };
      page = await logged('connect', `DevTools port ${app.port}`, () =>
        connect(app.port, deadline, { evidenceDir }),
      );
      timings.viewport = await page.evaluate('({ width: innerWidth, height: innerHeight })');
    });

    await step('plan-and-tasks', async () => {
      ids.lead = (
        await call('session.create', {
          project_id: projectId,
          runtime: 'fixture',
          input: script({ tool: { name: 'update_board', arguments: plan } }),
        })
      ).id;
      await poll(async () => {
        const turns = (await board()).session_turns.filter((t) => t.session_id === ids.lead);
        if (turns.some((t) => ended(t) && t.state !== 'completed'))
          throw new Error(`The lead's turn ended ${turns.map((t) => t.state).join(', ')}`);
        return turns.length > 0 && turns.every(ended);
      }, 'the lead to write the plan');
      for (const { task, runtime, input } of TASK_SESSIONS)
        ids[task.id] = (
          await call('session.create', {
            project_id: projectId,
            runtime,
            task_id: `${ids.lead}:${task.id}`,
            input,
          })
        ).id;
      const settled = await poll(async () => {
        const [snapshot, list] = await Promise.all([
          board(),
          get('session.list', { project_id: projectId }),
        ]);
        const finished = [CODE, NOTES].every((task) => {
          const turns = snapshot.session_turns.filter((t) => t.session_id === ids[task.id]);
          if (turns.some((t) => ended(t) && t.state !== 'completed'))
            throw new Error(`A turn of ${task.title} ended ${turns.map((t) => t.state)}`);
          return turns.length > 0 && turns.every(ended);
        });
        const waiting = list.find((s) => s.id === ids[BLOCKED.id])?.waiting > 0;
        return finished && waiting && list;
      }, 'the code and notes sessions to finish and the cleanup session to wait on approval');
      ids.leadTitle = settled.find((s) => s.id === ids.lead).title;
      await waitUi(projectShown(PROJECT_NAME), 'the sidebar to name the project');
    });

    // Each screen, its regions, and a shot and a contrast reading in each theme.
    for (const [row, stop] of STOPS.entries())
      await step(`view-${stop.key}`, async () => {
        await stop.open();
        const view = { name: stop.name, regions: await expectRegions(stop.regions(), stop.name) };
        views[stop.key] = view;
        if (stop.key === 'settings') {
          capability = await waitUi(
            `(() => { const tabs = (${runtimeTabs})(); return tabs.length > 0 && tabs.every((t) => t.reason !== '读取本机清单') && tabs; })()`,
            'the runtime tabs to finish reading their inventories',
          );
        }
        for (const [col, theme] of THEMES.entries()) {
          await setTheme(theme.value);
          await parkPointer();
          const taken = await shot(`${stop.key}-${theme.value}`);
          const measured = await read(
            `(${measureReadability})()`,
            `contrast on ${stop.name} in the ${theme.value} theme`,
          );
          readability.push({ view: stop.key, theme: theme.value, file: taken.file, ...measured });
          tiles.push({ row, col, file: taken.file, label: `${stop.name} · ${theme.label}` });
        }
        await stop.close?.();
      });

    await step('task-and-back', async () => {
      await openSession(CODE.title);
      const opened = await expectRegions(
        [{ role: 'main', name: '对话' }],
        `the session of ${CODE.title}`,
      );
      await click(button('项目看板', { within: NAV }));
      const back = await expectRegions(
        [
          { role: 'region', name: '结论', text: plan.headline },
          { role: 'tablist', name: '项目看板' },
        ],
        'the board after the task session',
      );
      const shown = await read(
        `({
          project: (document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').trim(),
          current: [...document.querySelectorAll('aside[aria-label="导航"] [aria-current="page"]')].map((el) => el.textContent.trim()),
          location: (document.querySelector('header.tb h1')?.textContent ?? '').trim(),
        })`,
        'the project and screen the app shows',
      );
      views['task-and-back'] = {
        opened,
        back,
        shown,
        same_board:
          [...opened, ...back].every((r) => r.found > 0) &&
          shown.project.includes(PROJECT_NAME) &&
          shown.current.includes('项目看板'),
      };
    });

    await step('usage', async () => {
      await click(button('运行', { within: NAV }));
      // With nothing running the screen follows the run into its progress view, which has no cards.
      await click({ role: 'radio', name: '运行树', exact: true });
      const runtime = await waitUi(
        `(${runUsage})(${JSON.stringify(NOTES.title)})`,
        'the run totals and the card of the silent session',
        Math.min(deadline, Date.now() + VIEW_MS),
      );
      await shot('runtime-tree');
      await click(button('工程看板', { within: NAV }));
      await click({ role: 'tab', name: '用量', exact: true });
      const boardRead = await waitUi(
        `(${boardUsage})(${JSON.stringify(SILENT_RUNTIME)})`,
        'the usage tab of the board',
        Math.min(deadline, Date.now() + VIEW_MS),
      );
      await parkPointer();
      await shot('board-usage');
      const tokens = runtime.facts.find((fact) => fact.label === 'tokens');
      const silentCard = runtime.nodes.find((node) => node.title === NOTES.title);
      const tokenTile = boardRead.tiles.find((tile) => tile.label.includes('tokens'));
      const checks = {
        runtime_card_zero: ZERO_TOKENS.test(silentCard.text),
        runtime_total_plain:
          !!tokens &&
          PLAIN_NUMBER.test(tokens.value) &&
          !PARTIAL.test(`${runtime.label} ${tokens.label} ${tokens.note ?? ''}`),
        board_runtime_zero: [...boardRead.runtime_labels, ...boardRead.runtime_lines].some(zeroIn),
        board_total_plain:
          !!tokenTile && PLAIN_NUMBER.test(tokenTile.value) && !PARTIAL.test(tokenTile.label),
      };
      usage = { runtime, board: boardRead, checks };
      observations.usage = { unknown_rendered_as_zero: Object.values(checks).some(Boolean) };
    });

    // The user makes the waiting cleanup task depend on the code task on the chart; both
    // sessions are unfinished, so the edit waits for the lead, which applies it when woken.
    await step('flow-edit', async () => {
      const from = `${ids.lead}:${CODE.id}`;
      const to = `${ids.lead}:${BLOCKED.id}`;
      const until = Math.min(deadline, Date.now() + 20000);
      const view = () => get('board.view', { project_id: projectId, days: '7' });
      const pendingOn = (model, editId) =>
        model.leads
          ?.find((l) => l.session_id === ids.lead)
          ?.pending_edits?.some((e) => e.id === editId) ?? false;
      await click(button('项目看板', { within: NAV }));
      await click({ role: 'radio', name: '任务', exact: true });
      await click({ role: 'radio', name: '流程图', exact: true });
      // With changes left unsent the edit button's name counts them.
      await click(button('编辑', { exact: false }));
      const source = await waitUi(
        `(${handleCentre})(${JSON.stringify(from)}, 'source')`,
        `the source handle of ${CODE.title}`,
      );
      const target = await waitUi(
        `(${handleCentre})(${JSON.stringify(to)}, 'target')`,
        `the target handle of ${BLOCKED.title}`,
      );
      await drag(source, target, `${CODE.title} onto ${BLOCKED.title} in the flow chart`);
      // The new edge is a draft until it is sent from the unsent changes of the task column.
      await waitUi(
        `(() => { const send = document.querySelector('.bd-em-bar .btn.pri'); send?.click(); return !!send; })()`,
        'the send button of the unsent changes',
      );
      const note = await poll(
        async () =>
          (await events()).find(
            (e) =>
              e.kind === 'lead.note_added' &&
              e.payload.edit?.ops.some(
                (op) => op.type === 'set_dependencies' && op.task_id === BLOCKED.id,
              ),
          )?.payload,
        'the lead to be told of the dependency the user added',
        until,
      );
      const editId = note.edit.edit_id;
      const pendingSeen = pendingOn(await view(), editId);
      const settled = await poll(
        async () => {
          const model = await view();
          return !pendingOn(model, editId) && model;
        },
        `the lead to resolve user edit ${editId}`,
        until,
      );
      const all = await events();
      const resolve = all.find(
        (e) =>
          e.kind === 'agent.tool.started' &&
          e.payload.name === 'edit_board' &&
          e.payload.input?.ops?.some(
            (op) => op.type === 'resolve_edit' && op.edit_id === editId && op.decision === 'apply',
          ),
      );
      const resolved = all.find(
        (e) =>
          e.kind === 'agent.tool.completed' &&
          e.payload.tool_call_id === resolve?.payload.tool_call_id,
      );
      const task = settled.tasks.find((t) => t.id === to);
      const edgeLabel = `${CODE.title} 到 ${BLOCKED.title}`;
      const edgeShown = await waitUi(
        `[...document.querySelectorAll('.react-flow__edge:not(.draft)')].some((el) => el.getAttribute('aria-label') === ${JSON.stringify(edgeLabel)})`,
        'the new dependency in the flow chart',
        Math.min(deadline, Date.now() + VIEW_MS),
      ).catch(() => false);
      flowEdit = {
        edit_id: editId,
        held_for_lead: note.edit.applied === false,
        pending_seen_on_board: pendingSeen,
        resolve_call: resolve?.payload ?? null,
        resolve_result: resolved?.payload ?? null,
        pending_after: pendingOn(settled, editId),
        depends_on_after: task?.depends_on ?? null,
        pending_edit_flag_after: task?.pending_edit ?? null,
        edge_shown: edgeShown === true,
      };
      flowEdit.applied_by_lead =
        flowEdit.held_for_lead &&
        resolved?.payload.ok === true &&
        !flowEdit.pending_after &&
        !!task?.depends_on?.includes(CODE.id);
    });
  } catch (error) {
    failure = new Error(`${current}: ${error.message}`, { cause: error });
  }

  current = 'review';
  const stopKeys = STOPS.map((stop) => stop.key);
  observations.ui = {
    required_views_present:
      stopKeys.every((key) => views[key]?.regions.every((r) => r.found > 0)) &&
      views['task-and-back']?.same_board === true,
    capability_reason_visible:
      !!capability &&
      capability.some(
        (tab) =>
          tab.disabled && tab.reason_visible && tab.reason !== '' && tab.reason !== '读取失败',
      ),
    light_dark_readable:
      readability.length === STOPS.length * THEMES.length &&
      readability.every((r) => r.counts.text > 0 && r.below.length === 0),
  };
  observations.flow_edit = { applied_by_lead: flowEdit?.applied_by_lead === true };
  if (page && !page.failure && tiles.length > 0)
    try {
      const w = 720;
      const h = Math.round((w * timings.viewport.height) / timings.viewport.width);
      await page.evaluate(montageStart(STOPS.length, w, h), Date.now() + 10000);
      for (const tile of tiles) {
        const data = (await readFile(path.join(evidenceDir, tile.file))).toString('base64');
        await page.evaluate(
          montageTile(data, tile.col * w, tile.row * h, w, h, tile.label),
          Date.now() + 10000,
        );
      }
      evidence['ui-screenshots.png'] = Buffer.from(
        await page.evaluate(montageEnd, Date.now() + 15000),
        'base64',
      );
      const [written] = await writeEvidence(evidenceDir, {
        'ui-screenshots.png': evidence['ui-screenshots.png'],
      });
      // The montage differs every run, so the reviewer gets what is left of the run to answer.
      const result = await humanReview([{ name: 'ui-screenshots.png', path: written.path }], {
        waitMs: Math.max(0, left()),
      });
      review = { ok: result.ok, reasons: result.reasons, receipt: result.receipt ?? null };
    } catch (error) {
      evidence['montage-error.txt'] = String(error?.stack ?? error);
    }
  observations.human = { review_recorded: review?.ok === true };

  // Cleanup runs on every path, each part bounded.
  current = 'shutdown';
  const shutdown = {};
  if (failure && page && !page.failure)
    try {
      screens.push(await page.screenshot('failure', Date.now() + 5000));
    } catch {}
  page?.close();
  if (app) shutdown.app = await app.stop(Date.now() + 20000);
  if (fixture) {
    await fixture.close();
    shutdown.daemon_manifest_removed = await stat(path.join(stateDir, 'daemon.json')).then(
      () => false,
      (error) => error.code === 'ENOENT',
    );
  }
  timings.total_ms = Date.now() - startedAt;
  Object.assign(evidence, {
    'human-review.json': {
      request: { items: ['ui-screenshots.png'], tiles },
      ...(review ?? { ok: false, reasons: ['no montage was made'], receipt: null }),
    },
    'screens.json': screens,
    'views.json': views,
    'readability.json': readability,
    'capability.json': capability ?? null,
    'usage.json': usage ?? null,
    'flow-edit.json': flowEdit ?? null,
    'shutdown.json': shutdown,
    'cdp-log.json': cdpLog,
    'timings.json': timings,
    'receipts.json': receipts,
  });
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'observations-so-far.json': observations,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`fixture@${new FixtureAdapter().report.version}`],
  };
}
