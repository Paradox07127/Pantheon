import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import type { ChecklistItem, FolderFacts, ProjectFacts } from '@pantheon/domain';
import { runGit } from './git.js';
import { inside } from './context.js';

export type { ChecklistItem, FolderFacts, ProjectFacts };

const FILE_LIMIT = 20_000;
const READ_LIMIT = 256 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const SKIPPED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'target',
]);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile']);
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

export function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const top = <T>(counts: Map<string, number>, limit: number, shape: (key: string, n: number) => T) =>
  [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, n]) => shape(key, n));

const increment = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

// Git C-quotes paths with unusual bytes; the quoted form holds octal escapes of UTF-8 bytes.
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  const body = value.slice(1, -1),
    bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') bytes.push(...Buffer.from(body[i]!));
    else if (/[0-7]/.test(body[i + 1] ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else bytes.push(ESCAPES[body[++i]!] ?? body.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

function manifest(name: string, text: string) {
  const scripts: Record<string, string> = {},
    dependencies: string[] = [];
  const lines = text.split(/\r?\n/);
  if (name === 'package.json') {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries((json.scripts ?? {}) as Record<string, unknown>))
        if (typeof value === 'string') scripts[key] = value;
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ])
        dependencies.push(...Object.keys((json[field] ?? {}) as object));
    } catch {
      /* A malformed manifest contributes nothing. */
    }
  } else if (name === 'go.mod') {
    let block = false;
    for (const line of lines) {
      if (/^require\s*\($/.test(line.trim())) block = true;
      else if (block && line.trim() === ')') block = false;
      else {
        const match = block ? /^\s*(\S+)\s+v/.exec(line) : /^require\s+(\S+)\s+v/.exec(line);
        if (match) dependencies.push(match[1]!);
      }
    }
  } else if (name === 'Makefile') {
    lines.forEach((line, index) => {
      const target = /^([A-Za-z0-9][\w./-]*)\s*:(?![:=])/.exec(line);
      if (target)
        scripts[target[1]!] = /^\t/.test(lines[index + 1] ?? '') ? lines[index + 1]!.trim() : '';
    });
  } else {
    // pyproject.toml and Cargo.toml: tables ending in "scripts" or "dependencies", plus PEP 621 arrays.
    let table = '',
      array = false;
    const requirements = (value: string) => {
      for (const [, requirement] of value.matchAll(/["']([^"']+)["']/g))
        dependencies.push(/^[A-Za-z0-9_.-]+/.exec(requirement!)?.[0] ?? requirement!);
    };
    for (const line of lines) {
      if (array) {
        requirements(line);
        array = !line.includes(']');
        continue;
      }
      const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
      if (header) {
        table = header[1]!.trim();
        continue;
      }
      const pair = /^\s*["']?([\w.-]+)["']?\s*=\s*(.*)$/.exec(line);
      if (!pair) continue;
      const key = pair[1]!,
        value = pair[2]!;
      if (/scripts$/.test(table)) scripts[key] = value.trim().replace(/^(["'])(.*)\1$/, '$2');
      else if (/(^|\.)(dev-|build-)?dependencies$/.test(table)) {
        if (key !== 'python') dependencies.push(key);
      } else if (
        (table === 'project' && key === 'dependencies') ||
        table === 'project.optional-dependencies'
      ) {
        requirements(value);
        array = value.trim().startsWith('[') && !value.includes(']');
      }
    }
  }
  return { scripts, dependencies };
}

function ciCommands(text: string): string[] {
  const lines = text.split(/\r?\n/),
    commands: string[] = [];
  for (let i = 0; i < lines.length && commands.length < 10; i++) {
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]!);
    if (!run) continue;
    const value = run[2]!.trim();
    if (!/^[|>][-+]?\d*$/.test(value)) {
      if (value) commands.push(value.replace(/^(["'])(.*)\1$/, '$2'));
      continue;
    }
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() && next.length - next.trimStart().length <= run[1]!.length) break;
      i++;
      if (next.trim() && !next.trim().startsWith('#')) commands.push(next.trim());
    }
  }
  return commands.slice(0, 10);
}

function scanFiles(root: string): { files: string[]; truncated: string[] } {
  const truncated: string[] = [],
    files: string[] = [];
  let capped = false;
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (capped) return;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith('.') &&
          !SKIPPED.has(entry.name) &&
          !existsSync(path.join(root, relative, '.git'))
        )
          walk(relative);
      } else if (entry.isFile()) {
        if (files.length === FILE_LIMIT) capped = true;
        else files.push(relative);
      }
    }
  };
  walk('');
  if (capped) truncated.push(`${root}: stopped scanning after ${FILE_LIMIT} files`);

  return { files, truncated };
}

function textLines(text: string): number {
  return text.split('\n').length - (text === '' || text.endsWith('\n') ? 1 : 0);
}

/** The same file scan as baseline facts outside Git; Git roots count all tracked regular text files. */
export function collectTextCounts(roots: { path: string; git: boolean }[]) {
  const languages: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.py': 'Python',
    '.rs': 'Rust',
    '.go': 'Go',
    '.swift': 'Swift',
    '.c': 'C',
    '.h': 'C',
    '.cpp': 'C++',
    '.hpp': 'C++',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.rb': 'Ruby',
    '.sh': 'Shell',
    '.css': 'CSS',
    '.html': 'HTML',
    '.md': 'Markdown',
    '.json': 'JSON',
    '.yaml': 'YAML',
    '.yml': 'YAML',
    '.toml': 'TOML',
  };
  return Promise.all(
    roots.map(async (root) => {
      const listed = root.git
        ? await runGit(root.path, ['ls-files', '-z'], undefined, true)
        : undefined;
      if (listed && listed.exit_code !== 0)
        throw new Error(
          `Cannot count tracked files in ${root.path}: ${listed.error ?? listed.stderr.toString()}`,
        );
      const files = listed
        ? listed.stdout.toString().split('\0').filter(Boolean)
        : scanFiles(root.path).files;
      return {
        root: root.path,
        files: files.flatMap((relative) => {
          const file = path.join(root.path, relative);
          if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return [];
          const content = readFileSync(file);
          if (content.includes(0)) return [];
          return [
            {
              path: relative,
              lines: textLines(content.toString('utf8')),
              language: languages[path.extname(relative).toLowerCase()] ?? 'other',
            },
          ];
        }),
      };
    }),
  );
}

/** A regular file whose real path stays inside the root. */
function rootFile(root: string, relative: string): boolean {
  if (path.isAbsolute(relative)) return false;
  try {
    const file = realpathSync(path.resolve(root, relative));
    return inside(realpathSync(root), file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

function outline(text: string) {
  const headings: string[] = [],
    items: ChecklistItem[] = [],
    repeats = new Map<string, number>();
  let fence = false,
    section: string | undefined;
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = /^\s*(```|~~~)/.test(line);
    if (marker) fence = !fence;
    if (fence || marker) return;
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      section = heading[2]!;
      if (heading[1]!.length <= 2) headings.push(section);
      return;
    }
    const item = /^\s*[-*] \[( |x|X)\] (.*)$/.exec(line);
    if (!item) return;
    const itemText = item[2]!.trim();
    // A repeated text adds its occurrence in the file; the first keeps the hash of the text alone.
    const occurrence = increment(repeats, itemText).get(itemText)!;
    items.push({
      line: index + 1,
      done: item[1] !== ' ',
      text: itemText,
      ...(section === undefined ? {} : { section }),
      hash: createHash('sha256')
        .update(occurrence === 1 ? itemText : `${itemText}\n${occurrence}`)
        .digest('hex')
        .slice(0, 12),
    });
  });
  return { headings, items };
}

async function collectFolder(
  root: string,
  git: boolean,
  now: number,
  taskLists: string[] = [],
): Promise<FolderFacts> {
  const output = async (args: string[]) => {
    const result = await runGit(root, args, undefined, true);
    return result.exit_code === 0 ? result.stdout.toString('utf8') : '';
  };
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 89);
  const [listing = '', statusText = '', recent = '', history = '', documented = '', changed = ''] =
    git
      ? await Promise.all([
          output(['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']),
          output(['status', '--porcelain=v2', '--branch', '--', '.']),
          output(['log', '-30', '--format=%H%x1f%ct%x1f%s', '--', '.']),
          output([
            'log',
            `--since=@${Math.floor(first.getTime() / 1000)}`,
            '--numstat',
            '--no-renames',
            '--relative',
            '--format=%x1e%ct',
            '--',
            '.',
          ]),
          output([
            'log',
            '--name-only',
            '--no-renames',
            '--relative',
            '--format=%x1e%ct',
            '--',
            '*.md',
            '*README*',
          ]),
          output(['diff', 'HEAD', '--name-only', '-z', '--relative', '--', '.']),
        ])
      : [];
  // Git folders list tracked and unignored files, tagged "? " when untracked; nested repositories end in a slash.
  const listed = git
    ? listing
        .split('\0')
        .filter(Boolean)
        .map((entry) => ({ tracked: !entry.startsWith('? '), path: entry.slice(2) }))
    : [];
  const { files, truncated } = git
    ? {
        files: [
          ...new Set(
            listed
              .map((entry) => entry.path)
              .filter(
                (relative) =>
                  relative &&
                  !relative.endsWith('/') &&
                  lstatSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile(),
              ),
          ),
        ],
        truncated: [] as string[],
      }
    : scanFiles(root);

  const read = (relative: string) => {
    const file = path.join(root, relative);
    const { size, mtimeMs } = statSync(file);
    const buffer = Buffer.alloc(Math.min(size, READ_LIMIT));
    const descriptor = openSync(file, 'r');
    try {
      readSync(descriptor, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(descriptor);
    }
    if (size > READ_LIMIT) truncated.push(`${relative}: read only the first ${READ_LIMIT} bytes`);
    return { text: buffer.toString('utf8'), mtime: mtimeMs };
  };

  const facts: FolderFacts = {
    root,
    git,
    commits_per_day: [],
    hotspots: [],
    recent_commits: [],
    file_types: [],
    directories: [],
    manifests: [],
    agent_instructions: [],
    docs: [],
    checklists: [],
    tests: { files: 0, configs: [] },
    ci: [],
    truncated,
  };

  const committed = new Map<string, number>();
  // In a git folder, code composition counts tracked files only; ignored evidence and build output would swamp it.
  let tracked: Set<string> | undefined;
  if (git) {
    tracked = new Set(listed.filter((entry) => entry.tracked).map((entry) => entry.path));
    const status = statusText.split('\n').filter(Boolean);
    const header = (key: string) =>
      status.find((line) => line.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length);
    const branch = header('head');
    if (branch !== undefined && branch !== '(detached)') facts.branch = branch;
    if (header('upstream') !== undefined) {
      const distance = /^\+(\d+) -(\d+)$/.exec(header('ab') ?? '');
      facts.ahead = Number(distance?.[1] ?? 0);
      facts.behind = Number(distance?.[2] ?? 0);
    }
    facts.dirty_files = status.filter((line) => !line.startsWith('# ')).length;

    facts.recent_commits = recent
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, subject] = line.split('\x1f');
        return { sha: sha!, subject: subject ?? '', at: Number(at) * 1000 };
      });
    const oid = header('oid');
    facts.head = oid && oid !== '(initial)' ? oid : undefined;
    facts.last_commit_at = facts.recent_commits[0]?.at;

    const perDay = new Map<string, number>();
    for (
      const day = new Date(first);
      facts.commits_per_day.length < 90;
      day.setDate(day.getDate() + 1)
    )
      facts.commits_per_day.push({ date: localDate(day.getTime()), count: 0 });
    const touched = new Map<string, number>();
    for (const commit of history.split('\x1e').slice(1)) {
      const [time, ...changes] = commit.split('\n');
      const at = Number(time) * 1000;
      increment(perDay, localDate(at));
      if (at < now - 30 * DAY) continue;
      for (const change of changes) {
        const file = change.split('\t')[2];
        if (file) increment(touched, unquote(file));
      }
    }
    for (const day of facts.commits_per_day) day.count = perDay.get(day.date) ?? 0;
    facts.hotspots = top(touched, 10, (file, commits) => ({ path: file, commits }));

    let time = 0;
    for (const line of documented.split('\n')) {
      if (line.startsWith('\x1e')) time = Number(line.slice(1)) * 1000;
      else if (line && !committed.has(unquote(line))) committed.set(unquote(line), time);
    }
    // A tracked file with uncommitted changes is as new as the file itself.
    for (const file of changed.split('\0')) committed.delete(file);
  }

  const types = new Map<string, number>(),
    directories = new Map<string, number>();
  for (const relative of files) {
    const base = path.posix.basename(relative),
      ext = path.posix.extname(relative).toLowerCase(),
      parts = relative.split('/');
    if (!tracked || tracked.has(relative)) {
      increment(types, ext);
      if (parts.length > 1) increment(directories, parts[0]!);
      if (parts.length > 2) increment(directories, `${parts[0]}/${parts[1]}`);
      if (
        /\.(test|spec)\.[^.]+$/.test(base) ||
        /^test_.*\.py$/.test(base) ||
        /_test\.go$/.test(base)
      )
        facts.tests.files++;
    }
    if (/^((vitest|jest|playwright)\.config\.\w+|pytest\.ini)$/.test(base))
      facts.tests.configs.push(relative);

    const manifestFile = MANIFESTS.has(base),
      instructions =
        base === 'CLAUDE.md' ||
        base === 'AGENTS.md' ||
        relative === '.cursorrules' ||
        relative.startsWith('.cursor/rules/') ||
        relative === '.github/copilot-instructions.md',
      doc = /^README/i.test(base) || (relative.startsWith('docs/') && ext === '.md'),
      workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative);
    if (!manifestFile && !instructions && !doc && !workflow && ext !== '.md') continue;
    const { text, mtime } = read(relative);
    const modified_at = committed.get(relative) ?? mtime;
    if (manifestFile) facts.manifests.push({ path: relative, ...manifest(base, text) });
    if (instructions)
      facts.agent_instructions.push({
        path: relative,
        lines: textLines(text),
      });
    if (workflow) facts.ci.push({ path: relative, commands: ciCommands(text) });
    const { headings, items } = outline(text);
    if (doc) facts.docs.push({ path: relative, headings, modified_at });
    if (ext === '.md' && items.length)
      facts.checklists.push({ path: relative, modified_at, items });
  }
  // A listed task file may sit in an ignored folder; it adds its checklist and nothing else.
  for (const relative of new Set(taskLists)) {
    if (facts.checklists.some((list) => list.path === relative) || !rootFile(root, relative))
      continue;
    const { text, mtime } = read(relative);
    const { items } = outline(text);
    if (items.length) facts.checklists.push({ path: relative, modified_at: mtime, items });
  }
  facts.file_types = top(types, 12, (ext, count) => ({ ext, count }));
  facts.directories = [...directories]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([directory, count]) => ({ path: directory, files: count }));
  return facts;
}

export async function collectFacts(
  roots: { path: string; git: boolean; task_lists?: string[] }[],
  now = Date.now(),
): Promise<ProjectFacts> {
  return {
    collected_at: now,
    folders: await Promise.all(
      roots.map((root) => collectFolder(root.path, root.git, now, root.task_lists)),
    ),
  };
}
