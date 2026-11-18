import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { CodeDependencies } from '@pantheon/domain';

export type { CodeDependencies };
/** One resolved import: a source file to a file or package directory, both relative to the root. */
export interface FileEdge {
  from: string;
  to: string;
  line: number;
}

const SPLIT_ABOVE = 40;
const EDGES_SHOWN = 60;
const MEASURED: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
};
const NOT_MEASURED: Record<string, string> = {
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.hh': 'C++',
};
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const QUOTED = String.raw`(["'\x60][^"'\x60\n]*["'\x60])`;
const SCRIPT_IMPORTS = [
  new RegExp(
    String.raw`(?<![\w$.])(?:import|export)\s+(?:type\s+)?[\w$\s,{}*]*?\bfrom\s*${QUOTED}`,
    'dg',
  ),
  new RegExp(String.raw`(?<![\w$.])import\s*${QUOTED}`, 'dg'),
  new RegExp(String.raw`(?<![\w$.])(?:import|require)\s*\(\s*${QUOTED}\s*\)`, 'dg'),
];

interface Syntax {
  line: string;
  block: boolean;
  quotes: string;
  triple?: boolean;
}
const C_LIKE = { line: '//', block: true };
const SYNTAX: Record<string, Syntax> = {
  TypeScript: { ...C_LIKE, quotes: '"\'`' },
  JavaScript: { ...C_LIKE, quotes: '"\'`' },
  Go: { ...C_LIKE, quotes: '"\'`' },
  Rust: { ...C_LIKE, quotes: '"' },
  Python: { line: '#', block: false, quotes: '"\'', triple: true },
};

const isTest = (relative: string) => {
  const base = path.posix.basename(relative);
  return (
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.go$/.test(base) ||
    /(^|\/)(tests|__tests__)\//.test(relative)
  );
};

/** A posix path relative to the root, "" for the root and undefined outside it. */
function join(...parts: string[]): string | undefined {
  const joined = path.posix.join(...parts).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined))
    return undefined;
  return joined === '.' ? '' : joined;
}

const shown = (dir: string) => dir || '.';
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function readHead(file: string, limit: number): string {
  try {
    const descriptor = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(fstatSync(descriptor).size, limit));
      return buffer.toString('utf8', 0, readSync(descriptor, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return '';
  }
}

/** Comments become spaces; with blankStrings, so do string bodies. Offsets and line numbers stay. */
function blank(text: string, syntax: Syntax, blankStrings = true): string {
  const parts: string[] = [];
  const spaces = (from: number, to: number) => text.slice(from, to).replace(/[^\n]/g, ' ');
  let from = 0;
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (text.startsWith(syntax.line, i) || (syntax.block && text.startsWith('/*', i))) {
      const close = text[i + 1] === '*' && syntax.block ? '*/' : '\n';
      const found = text.indexOf(close, i + 2);
      const end = found < 0 ? text.length : close === '\n' ? found : found + 2;
      parts.push(text.slice(from, i), spaces(i, end));
      i = from = end;
    } else if (syntax.quotes.includes(char)) {
      const close = syntax.triple && text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      let end = i + close.length;
      while (end < text.length && !text.startsWith(close, end)) {
        if (text[end] === '\\') end++;
        else if (text[end] === '\n' && close.length === 1 && char !== '`') break;
        end++;
      }
      end = Math.min(end, text.length);
      const body = i + close.length;
      parts.push(text.slice(from, body), blankStrings ? spaces(body, end) : text.slice(body, end));
      from = end;
      i = text.startsWith(close, end) ? end + close.length : end;
    } else i++;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

function jsonc(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      blank(text, SYNTAX.JavaScript!, false).replace(/,(\s*[}\]])/g, '$1'),
    );
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Line, key and value of each assignment in a TOML file, with the table it sits in. */
function* toml(text: string) {
  let table = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(lines[i]!);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const pair = /^\s*["']?([\w.-]+?)["']?\s*=\s*(.*)$/.exec(lines[i]!);
    if (!pair) continue;
    let value = pair[2]!;
    // Arrays and inline tables may span lines.
    while (
      (value.split('[').length > value.split(']').length ||
        value.split('{').length > value.split('}').length) &&
      i + 1 < lines.length
    )
      value += `\n${lines[++i]}`;
    yield { table, key: pair[1]!, value };
  }
}

const tomlString = (value: string) => /^\s*["']([^"']*)["']/.exec(value)?.[1];
const tomlField = (value: string, field: string) =>
  new RegExp(String.raw`\b${field}\s*=\s*["']([^"']*)["']`).exec(value)?.[1];

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}
function lineAt(starts: number[], offset: number): number {
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Paths of a Rust use tree, with groups expanded and aliases, globs and inner self dropped. */
function useTree(tree: string): string[][] {
  const flat = tree.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
  const brace = flat.indexOf('{');
  if (brace < 0)
    return [
      flat
        .split('::')
        .filter(
          (segment, index) => segment && segment !== '*' && (index === 0 || segment !== 'self'),
        ),
    ];
  const head = flat.slice(0, brace).replace(/::$/, '');
  const body = flat.slice(brace + 1, flat.lastIndexOf('}'));
  const items: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if ((body[i] === ',' || i === body.length) && depth === 0) {
      if (i > start) items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return items.flatMap((item) => useTree(head ? `${head}::${item}` : item));
}

interface Package {
  name: string;
  depends: Set<string>;
}

/** Package graph, file import edges and their module edges, measured from manifests and source text. */
export function measureCodeDeps(
  root: string,
  files: string[],
  readLimit: number,
): { deps: CodeDependencies; edges: FileEdge[] } {
  const known = new Set(files.filter((file) => !isTest(file)));
  const goDirectories = new Set<string>();
  const pythonDirectories = new Set<string>();
  for (const file of known) {
    const directory = path.posix.dirname(file);
    if (file.endsWith('.go')) goDirectories.add(directory === '.' ? '' : directory);
    if (file.endsWith('.py'))
      for (let dir = directory; dir !== '.'; dir = path.posix.dirname(dir))
        pythonDirectories.add(dir);
  }
  const texts = new Map<string, string>();
  const text = (relative: string) => {
    let value = texts.get(relative);
    if (value === undefined)
      texts.set(relative, (value = readHead(path.join(root, relative), readLimit)));
    return value;
  };
  const manifests = (name: string) =>
    [...known].filter((file) => path.posix.basename(file) === name).sort();
  const dirOf = (file: string) => join(path.posix.dirname(file))!;

  const packages = new Map<string, Package>();
  const addPackage = (dir: string, name: string) => {
    if (!packages.has(dir)) packages.set(dir, { name, depends: new Set() });
  };
  const pending: { dir: string; to: () => string | undefined }[] = [];

  // npm, pnpm and yarn: a dependency that names another package of the repository.
  const npmNames = new Map<string, string>();
  for (const file of manifests('package.json')) {
    const json = jsonc(text(file));
    if (typeof json.name !== 'string') continue;
    const dir = dirOf(file);
    addPackage(dir, json.name);
    npmNames.set(json.name, dir);
    for (const field of DEPENDENCY_FIELDS)
      for (const name of Object.keys((json[field] ?? {}) as object))
        pending.push({ dir, to: () => npmNames.get(name) });
  }

  // Cargo: path dependencies, also through workspace dependencies; a rename keeps the real crate under another name.
  const crates = new Map<string, string>();
  const crateAliases = new Map<string, Map<string, string>>();
  const workspaceCrates = new Map<string, string>();
  const cargoDeps: { dir: string; key: string; path?: string; workspace: boolean }[] = [];
  for (const file of manifests('Cargo.toml')) {
    const dir = dirOf(file);
    let name: string | undefined;
    const tables = new Map<string, { path?: string; workspace: boolean }>();
    for (const { table, key, value } of toml(text(file))) {
      if (table === 'package' && key === 'name') name = tomlString(value);
      const inline = /(^|\.)(dev-|build-)?dependencies$/.test(table);
      const nested = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(table);
      if (nested) {
        const entry = tables.get(table) ?? { workspace: false };
        if (key === 'path') entry.path = tomlString(value);
        if (key === 'workspace') entry.workspace = value.trim() === 'true';
        tables.set(table, entry);
        if (!entry.path && !entry.workspace) continue;
        const target = entry.path ? join(dir, entry.path) : undefined;
        if (table.startsWith('workspace.')) {
          if (target !== undefined) workspaceCrates.set(nested[1]!, target);
        } else cargoDeps.push({ dir, key: nested[1]!, path: target, workspace: entry.workspace });
      } else if (inline) {
        const [local, inherited] = key.split('.');
        const target = tomlField(value, 'path');
        const resolved = target === undefined ? undefined : join(dir, target);
        if (table === 'workspace.dependencies') {
          if (resolved !== undefined) workspaceCrates.set(local!, resolved);
          continue;
        }
        cargoDeps.push({
          dir,
          key: local!,
          path: resolved,
          workspace: inherited === 'workspace' || /\bworkspace\s*=\s*true/.test(value),
        });
      }
    }
    if (name === undefined) continue;
    addPackage(dir, name);
    crates.set(name.replace(/-/g, '_'), dir);
  }
  for (const dependency of cargoDeps) {
    const target =
      dependency.path ?? (dependency.workspace ? workspaceCrates.get(dependency.key) : undefined);
    if (target === undefined) continue;
    pending.push({ dir: dependency.dir, to: () => target });
    const aliases = crateAliases.get(dependency.dir) ?? new Map<string, string>();
    aliases.set(dependency.key.replace(/-/g, '_'), target);
    crateAliases.set(dependency.dir, aliases);
  }

  // Go: each go.mod is a module; a require of another repository module or a replace to a local path.
  const goModules: { path: string; dir: string }[] = [];
  const goReplaces = new Map<string, Map<string, string>>();
  const goRequires: { dir: string; module: string }[] = [];
  for (const file of manifests('go.mod')) {
    const dir = dirOf(file);
    const replaces = new Map<string, string>();
    let block = '';
    for (const raw of blank(text(file), { line: '//', block: false, quotes: '' }).split('\n')) {
      const line = raw.trim();
      const opened = /^(require|replace)\s*\($/.exec(line);
      if (opened) {
        block = opened[1]!;
        continue;
      }
      if (line === ')') {
        block = '';
        continue;
      }
      const module = /^module\s+(\S+)/.exec(line);
      if (module) goModules.push({ path: module[1]!.replace(/"/g, ''), dir });
      const statement = block ? `${block} ${line}` : line;
      const required = /^require\s+(\S+)\s+v/.exec(statement);
      if (required) goRequires.push({ dir, module: required[1]! });
      const replaced = /^replace\s+(\S+)(?:\s+\S+)?\s*=>\s*(\.{1,2}\/\S*)/.exec(statement);
      if (replaced) {
        const target = join(dir, replaced[2]!);
        if (target !== undefined) replaces.set(replaced[1]!, target);
      }
    }
    goReplaces.set(dir, replaces);
    const name = goModules.find((entry) => entry.dir === dir)?.path;
    if (name) addPackage(dir, name);
  }
  for (const { dir, module } of goRequires)
    pending.push({
      dir,
      to: () =>
        goReplaces.get(dir)?.get(module) ?? goModules.find((entry) => entry.path === module)?.dir,
    });

  // Python: [project] or Poetry names, matched by normalized name or a path source.
  const pythonNames = new Map<string, string>();
  const pythonRoots = ['', 'src'];
  for (const file of manifests('pyproject.toml')) {
    const dir = dirOf(file);
    let name: string | undefined;
    const wanted: string[] = [];
    for (const { table, key, value } of toml(text(file))) {
      if ((table === 'project' || table === 'tool.poetry') && key === 'name')
        name = tomlString(value);
      else if (
        (table === 'project' && key === 'dependencies') ||
        table === 'project.optional-dependencies' ||
        table === 'dependency-groups'
      )
        for (const [, requirement] of value.matchAll(/["']([^"']+)["']/g))
          wanted.push(/^[A-Za-z0-9_.-]+/.exec(requirement!)?.[0] ?? requirement!);
      else if (/^tool\.poetry\.(.+\.)?dependencies$/.test(table) && key !== 'python')
        wanted.push(key);
      if (/^tool\.(uv\.sources|poetry\.(.+\.)?dependencies)$/.test(table)) {
        const source = tomlField(value, 'path');
        const target = source === undefined ? undefined : join(dir, source);
        if (target !== undefined)
          pending.push({ dir, to: () => (packages.has(target) ? target : undefined) });
      }
    }
    if (name === undefined) continue;
    addPackage(dir, name);
    pythonNames.set(pythonName(name), dir);
    pythonRoots.push(dir, join(dir, 'src')!);
    for (const requirement of wanted)
      pending.push({ dir, to: () => pythonNames.get(pythonName(requirement)) });
  }

  for (const { dir, to } of pending) {
    const target = to();
    if (target !== undefined && target !== dir && packages.has(target))
      packages.get(dir)!.depends.add(target);
  }

  // TypeScript configuration: the nearest tsconfig.json, its relative extends chain, paths and baseUrl.
  type Aliases = { baseUrl?: string; paths?: { map: Record<string, string[]>; dir: string } };
  const configs = new Map<string, Aliases>();
  const tsconfig = (file: string, seen: Set<string>): Aliases => {
    const cached = configs.get(file);
    if (cached) return cached;
    const json = jsonc(text(file));
    const dir = dirOf(file);
    let aliases: Aliases = {};
    for (const parent of [json.extends].flat()) {
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
      const target = join(dir, parent.endsWith('.json') ? parent : `${parent}.json`);
      if (target !== undefined && known.has(target) && !seen.has(target))
        aliases = { ...aliases, ...tsconfig(target, new Set([...seen, target])) };
    }
    const options = (json.compilerOptions ?? {}) as { baseUrl?: unknown; paths?: unknown };
    if (typeof options.baseUrl === 'string') aliases.baseUrl = join(dir, options.baseUrl);
    if (options.paths && typeof options.paths === 'object')
      aliases.paths = { map: options.paths as Record<string, string[]>, dir };
    configs.set(file, aliases);
    return aliases;
  };
  const nearestConfig = (file: string): Aliases => {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      const config = join(dir, 'tsconfig.json')!;
      if (known.has(config)) return tsconfig(config, new Set([config]));
      if (dir === '') return {};
    }
  };
  const scriptFile = (base: string | undefined) => {
    if (base === undefined) return undefined;
    const extension = path.posix.extname(base);
    const candidates = [base];
    if (/^\.[cm]?jsx?$/.test(extension))
      candidates.push(base.slice(0, -extension.length) + extension.replace('js', 'ts'));
    for (const suffix of SCRIPT_EXTENSIONS) candidates.push(base + suffix);
    for (const suffix of SCRIPT_EXTENSIONS) candidates.push(`${base}/index${suffix}`);
    return candidates.find((candidate) => known.has(candidate));
  };
  const npmByLength = [...npmNames].sort((a, b) => b[0].length - a[0].length);
  const resolveScript = (file: string, specifier: string): string | undefined => {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.')
      return scriptFile(join(dirOf(file), specifier));
    if (specifier.startsWith('/')) return undefined;
    const { baseUrl, paths } = nearestConfig(file);
    if (paths) {
      const prefixLength = (pattern: string) =>
        pattern.includes('*') ? pattern.indexOf('*') : pattern.length;
      const patterns = Object.entries(paths.map).sort(
        (a, b) => prefixLength(b[0]) - prefixLength(a[0]),
      );
      for (const [pattern, targets] of patterns) {
        const star = pattern.indexOf('*');
        const [prefix, suffix] =
          star < 0 ? [pattern, ''] : [pattern.slice(0, star), pattern.slice(star + 1)];
        const matches =
          star < 0
            ? specifier === pattern
            : specifier.startsWith(prefix) &&
              specifier.endsWith(suffix) &&
              specifier.length >= prefix.length + suffix.length;
        if (!matches) continue;
        const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
        for (const target of [targets].flat()) {
          if (typeof target !== 'string') continue;
          const found = scriptFile(join(baseUrl ?? paths.dir, target.replace('*', middle)));
          if (found) return found;
        }
      }
    }
    for (const [name, dir] of npmByLength) {
      if (specifier === name) return dir;
      if (!specifier.startsWith(`${name}/`)) continue;
      const subpath = specifier.slice(name.length + 1);
      return scriptFile(join(dir, subpath)) ?? scriptFile(join(dir, 'src', subpath)) ?? dir;
    }
    return baseUrl === undefined ? undefined : scriptFile(join(baseUrl, specifier));
  };

  // Python: absolute imports against the top-level roots, relative imports against the package of the file.
  const pythonModule = (base: string, segments: string[], minimum: number) => {
    for (let count = segments.length; count >= minimum; count--) {
      const module = join(base, ...segments.slice(0, count));
      if (module === undefined) return undefined;
      if (count > 0 && known.has(`${module}.py`)) return `${module}.py`;
      const init = join(module, '__init__.py')!;
      if (known.has(init)) return init;
      if (count > 0 && pythonDirectories.has(module)) return module;
    }
    return undefined;
  };
  const roots = [...new Set(pythonRoots)];
  const resolvePython = (file: string, dots: number, segments: string[]) => {
    if (dots) {
      let base: string | undefined = dirOf(file);
      for (let i = 1; i < dots && base !== undefined; i++)
        base = base === '' ? undefined : dirOf(base);
      return base === undefined ? undefined : pythonModule(base, segments, 0);
    }
    for (const base of roots) {
      const found = pythonModule(base, segments, 1);
      if (found) return found;
    }
    return undefined;
  };

  // Go: the longest module path or local replace that prefixes the import path.
  const nearestGoModule = (file: string) => {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      if (goReplaces.has(dir)) return dir;
      if (dir === '') return undefined;
    }
  };
  const resolveGo = (file: string, importPath: string) => {
    const own = nearestGoModule(file);
    const candidates = [
      ...goModules,
      ...[...(own === undefined ? [] : (goReplaces.get(own) ?? []))].map(([modulePath, dir]) => ({
        path: modulePath,
        dir,
      })),
    ].filter((entry) => importPath === entry.path || importPath.startsWith(`${entry.path}/`));
    const best = candidates.sort((a, b) => b.path.length - a.path.length)[0];
    if (!best) return undefined;
    const target = join(best.dir, importPath.slice(best.path.length + 1));
    return target !== undefined && goDirectories.has(target) ? target : undefined;
  };

  // Rust: a module is a file; walk the segments of a path while a file matches.
  const crateDirs = [...packages.keys()].filter((dir) => known.has(join(dir, 'Cargo.toml')!));
  const ownerCrate = (file: string) =>
    crateDirs
      .filter((dir) => dir === '' || file.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
  const moduleFile = (dir: string) =>
    [`${dir}.rs`, `${dir}/mod.rs`, `${dir}/lib.rs`, `${dir}/main.rs`]
      .map((candidate) => join(candidate))
      .find((candidate) => candidate !== undefined && known.has(candidate));
  const rustModuleDir = (file: string) =>
    /^(mod|lib|main)\.rs$/.test(path.posix.basename(file))
      ? dirOf(file)
      : join(dirOf(file), path.posix.basename(file, '.rs'))!;
  const crateRoot = (file: string, crate: string) => {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      if (known.has(join(dir, 'lib.rs')!) || known.has(join(dir, 'main.rs')!)) return dir;
      if (dir === crate || dir === '') return join(crate, 'src')!;
    }
  };
  const libRoot = (crate: string) => join(crate, 'src')!;
  const walkRust = (dir: string, segments: string[]) => {
    let target = moduleFile(dir);
    for (const segment of segments) {
      const next = [`${dir}/${segment}.rs`, `${dir}/${segment}/mod.rs`]
        .map((candidate) => join(candidate)!)
        .find((candidate) => known.has(candidate));
      if (!next) break;
      target = next;
      dir = join(dir, segment)!;
    }
    return target;
  };
  const resolveRust = (file: string, segments: string[]) => {
    const [first, ...rest] = segments;
    if (first === undefined) return undefined;
    const crate = ownerCrate(file);
    if (first === 'crate') return walkRust(crateRoot(file, crate ?? ''), rest);
    if (first === 'self') return walkRust(rustModuleDir(file), rest);
    if (first === 'super') {
      let dir = rustModuleDir(file),
        index = 0;
      while (segments[index] === 'super') {
        dir = dirOf(dir);
        index++;
      }
      return walkRust(dir, segments.slice(index));
    }
    const other =
      (crate === undefined ? undefined : crateAliases.get(crate)?.get(first)) ?? crates.get(first);
    if (other !== undefined) return walkRust(libRoot(other), rest);
    const local = rustModuleDir(file);
    return [`${local}/${first}.rs`, `${local}/${first}/mod.rs`].some((candidate) =>
      known.has(join(candidate)!),
    )
      ? walkRust(local, segments)
      : undefined;
  };

  const edges: FileEdge[] = [];
  const languages = new Set<string>();
  const unmeasured = new Map<string, number>();
  const sources: string[] = [];
  let external = 0;
  for (const file of [...known].sort()) {
    const extension = path.posix.extname(file).toLowerCase();
    const language = MEASURED[extension];
    if (!language) {
      const other = NOT_MEASURED[extension];
      if (other) unmeasured.set(other, (unmeasured.get(other) ?? 0) + 1);
      continue;
    }
    languages.add(language);
    sources.push(file);
    const original = text(file);
    if (!/\b(import|require|export|from|use|mod|extern)\b/.test(original)) continue;
    const code = blank(original, SYNTAX[language]!);
    const starts = lineStarts(code);
    const found: { to: string | undefined; offset: number }[] = [];
    const specifier = (match: RegExpExecArray, group: number) => {
      const [start, end] = match.indices![group]!;
      return original.slice(start + 1, end - 1);
    };
    if (language === 'TypeScript' || language === 'JavaScript')
      for (const pattern of SCRIPT_IMPORTS)
        for (const match of code.matchAll(pattern))
          found.push({ to: resolveScript(file, specifier(match, 1)), offset: match.index });
    else if (language === 'Python') {
      for (const match of code.matchAll(
        /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm,
      ))
        for (const name of match[1]!.split(','))
          found.push({
            to: resolvePython(file, 0, name.trim().split(/\s+/)[0]!.split('.')),
            offset: match.index,
          });
      for (const match of code.matchAll(
        /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm,
      )) {
        const dots = match[1]!.length;
        const module = match[2] ? match[2].split('.') : [];
        const targets = new Set(
          match[3]!
            .replace(/[()\\]/g, ' ')
            .split(',')
            .map((name) => name.trim().split(/\s+/)[0]!)
            .filter((name) => name && name !== '*')
            .map((name) => resolvePython(file, dots, [...module, name])),
        );
        if (!targets.size) targets.add(resolvePython(file, dots, module));
        for (const to of targets) found.push({ to, offset: match.index });
      }
    } else if (language === 'Go') {
      for (const match of code.matchAll(/(?<![\w.])import\s*\(([^)]*)\)/dg)) {
        const [start] = match.indices![1]!;
        for (const inner of match[1]!.matchAll(/(?:[\w.]+\s+)?(["`][^"`\n]*["`])/dg)) {
          const [from, to] = inner.indices![1]!;
          found.push({
            to: resolveGo(file, original.slice(start + from + 1, start + to - 1)),
            offset: start + from,
          });
        }
      }
      for (const match of code.matchAll(/(?<![\w.])import\s+(?:[\w.]+\s+)?(["`][^"`\n]*["`])/dg))
        found.push({ to: resolveGo(file, specifier(match, 1)), offset: match.index });
    } else {
      for (const match of code.matchAll(
        /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm,
      )) {
        const dir = rustModuleDir(file);
        found.push({
          to: [`${dir}/${match[1]}.rs`, `${dir}/${match[1]}/mod.rs`]
            .map((candidate) => join(candidate)!)
            .find((candidate) => known.has(candidate)),
          offset: match.index,
        });
      }
      for (const match of code.matchAll(
        /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+(?:::)?([^;]+);/gm,
      ))
        for (const segments of useTree(match[1]!))
          found.push({ to: resolveRust(file, segments), offset: match.index });
      for (const match of code.matchAll(
        /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?extern[ \t]+crate[ \t]+(\w+)/gm,
      ))
        found.push({ to: resolveRust(file, [match[1]!]), offset: match.index });
    }
    const seen = new Set<string>();
    for (const { to, offset } of found) {
      if (to === undefined) {
        external++;
        continue;
      }
      const line = lineAt(starts, offset);
      if (to === file || seen.has(`${to}\0${line}`)) continue;
      seen.add(`${to}\0${line}`);
      edges.push({ from: file, to, line });
    }
  }
  edges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line || (a.to < b.to ? -1 : 1),
  );

  // Modules: a package, split below its source root when it has many source files; elsewhere two directory levels.
  const packageDirs = [...packages.keys()].sort((a, b) => b.length - a.length);
  const owner = (target: string) =>
    packageDirs.find((dir) => dir === '' || target === dir || target.startsWith(`${dir}/`));
  const counts = new Map<string, number>();
  for (const file of sources) {
    const dir = owner(file);
    if (dir !== undefined) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const sourceRoots = new Map<string, string>();
  const sourceRoot = (dir: string) => {
    let found = sourceRoots.get(dir);
    if (found === undefined) {
      found =
        ['src', 'lib']
          .map((name) => join(dir, name)!)
          .find((candidate) =>
            sources.some((file) => file.startsWith(`${candidate}/`) && owner(file) === dir),
          ) ?? dir;
      sourceRoots.set(dir, found);
    }
    return found;
  };
  const moduleOf = (target: string, isFile: boolean) => {
    const dir = owner(target);
    if (dir === undefined)
      return shown((isFile ? dirOf(target) : target).split('/').slice(0, 2).join('/'));
    if ((counts.get(dir) ?? 0) <= SPLIT_ABOVE) return shown(dir);
    const base = sourceRoot(dir);
    const below =
      base === ''
        ? target
        : target.startsWith(`${base}/`)
          ? target.slice(base.length + 1)
          : undefined;
    const parts = below?.split('/') ?? [];
    return parts.length > (isFile ? 1 : 0) ? join(base, parts[0]!)! : shown(dir);
  };
  const modules = new Map<string, CodeDependencies['modules'][number]>();
  for (const edge of edges) {
    const from = moduleOf(edge.from, true),
      to = moduleOf(edge.to, known.has(edge.to));
    if (from === to) continue;
    const key = `${from}\0${to}`;
    const entry = modules.get(key);
    if (entry) entry.imports++;
    else modules.set(key, { from, to, imports: 1, sample: `file:${edge.from}:${edge.line}` });
  }

  return {
    deps: {
      packages: [...packages]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([dir, entry]) => ({
          dir: shown(dir),
          name: entry.name,
          depends_on: [...entry.depends].sort().map(shown),
        })),
      modules: [...modules.values()].sort(
        (a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
      ),
      languages: [...languages].sort(),
      not_measured: [...unmeasured]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([language, files]) => ({ language, files })),
      external_imports: external,
    },
    edges,
  };
}

/** The lines a brief shows for one root's measured code dependencies; none when nothing was measured. */
export function renderCodeDeps(deps: CodeDependencies | undefined): string[] {
  if (!deps || (!deps.packages.length && !deps.modules.length && !deps.not_measured.length))
    return [];
  const modules = [...deps.modules].sort((a, b) => b.imports - a.imports);
  const lines = ['Pantheon measured these from manifests and import statements, without a model.'];
  if (deps.packages.length)
    lines.push(
      'Packages:',
      ...deps.packages.map(
        (entry) =>
          `- ${entry.dir} (${entry.name})${entry.depends_on.length ? ` -> ${entry.depends_on.join(', ')}` : ''}`,
      ),
    );
  if (modules.length)
    lines.push(
      'Module edges, most imports first:',
      ...modules
        .slice(0, EDGES_SHOWN)
        .map((edge) => `- ${edge.from} -> ${edge.to}: ${edge.imports} imports (${edge.sample})`),
    );
  if (modules.length > EDGES_SHOWN)
    lines.push(
      `- ${modules.length - EDGES_SHOWN} more module edges with fewer imports are not listed.`,
    );
  if (deps.not_measured.length)
    lines.push(
      `Not measured: ${deps.not_measured.map((entry) => `${entry.language} (${entry.files} files)`).join(', ')}.`,
    );
  return lines;
}
