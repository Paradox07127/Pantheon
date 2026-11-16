import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Editor } from './editors.js';
import { windowsPathFromWsl, wslPathFromWindows } from './wsl.js';

const WEB_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/** The normalized href when the system browser may open it, else null. */
export function webLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return WEB_PROTOCOLS.includes(parsed.protocol) ? parsed.href : null;
}

const real = (file: string): string | null => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};
const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
const within = (file: string, root: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * The real path of an existing regular file inside one of the roots, or null.
 * A relative path is looked up from base (only when base is inside the roots), then from each root.
 */
export function resolveFile(ref: { path: string; base?: string }, roots: string[]): string | null {
  let target = ref.path;
  if (target.startsWith('file:')) {
    try {
      target = fileURLToPath(target);
    } catch {
      return null;
    }
  }
  const realRoots = roots.flatMap((root) => real(root) ?? []);
  const inRoots = (file: string): boolean => realRoots.some((root) => within(file, root));
  let directories: string[] = [];
  if (!path.isAbsolute(target)) {
    const base = ref.base === undefined ? null : real(ref.base);
    directories = [...(base !== null && inRoots(base) ? [base] : []), ...roots];
  }
  const candidates = path.isAbsolute(target)
    ? [target]
    : directories.map((directory) => path.resolve(directory, target));
  for (const candidate of candidates) {
    const file = real(candidate);
    if (file !== null && isFile(file) && inRoots(file)) return file;
  }
  return null;
}

/** resolveFile for the Linux paths of `distro`, looked up through its Windows share; the result is a Linux path. */
export function resolveWslFile(
  ref: { path: string; base?: string },
  roots: string[],
  distro: string,
): string | null {
  const windows = (linuxPath: string) => windowsPathFromWsl(linuxPath, distro);
  let target = ref.path;
  if (target.startsWith('file:')) {
    try {
      target = decodeURIComponent(new URL(target).pathname);
    } catch {
      return null;
    }
  }
  // The share path reads a backslash in a Linux name as a separator, naming another file.
  if (target.includes('\\') || roots.some((root) => root.includes('\\'))) return null;
  const file = resolveFile(
    {
      path: target.startsWith('/') ? windows(target) : target,
      ...(ref.base === undefined ? {} : { base: windows(ref.base) }),
    },
    roots.map(windows),
  );
  const linux = file === null ? undefined : wslPathFromWindows(file, distro);
  if (linux === undefined) return null;
  // Windows compares paths case-insensitively, but folders differing only in case are distinct in WSL.
  const linuxRoots = roots.flatMap((root) => {
    const realRoot = real(windows(root));
    return (realRoot === null ? undefined : wslPathFromWindows(realRoot, distro)) ?? [];
  });
  const inRoots = linuxRoots.some((root) => {
    const relative = path.posix.relative(root, linux);
    return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
  });
  return inRoots ? linux : null;
}

/** Command line tools that open `file:line[:column]`, relative to the .app bundle, with their flags. */
const LINE_TOOLS: Record<string, [tool: string, flags: string[]]> = {
  'Visual Studio Code': ['Contents/Resources/app/bin/code', ['-g']],
  'Visual Studio Code - Insiders': ['Contents/Resources/app/bin/code-insiders', ['-g']],
  Cursor: ['Contents/Resources/app/bin/cursor', ['-g']],
  Windsurf: ['Contents/Resources/app/bin/windsurf', ['-g']],
  Zed: ['Contents/MacOS/cli', []],
  'Sublime Text': ['Contents/SharedSupport/bin/subl', []],
};

export function editorLaunch(
  editor: Editor,
  file: string,
  line?: number,
  column?: number,
): { command: string; args: string[] } {
  if (line !== undefined) {
    // Bare xed follows xcode-select, which may point at the Command Line Tools, which lack xed.
    if (editor.id === 'Xcode') {
      const developer = `DEVELOPER_DIR=${path.join(editor.path, 'Contents/Developer')}`;
      return { command: 'env', args: [developer, 'xed', '-l', String(line), file] };
    }
    const [tool, flags] = LINE_TOOLS[editor.id] ?? [];
    const cli = tool === undefined ? null : path.join(editor.path, tool);
    if (cli !== null && existsSync(cli)) {
      const at = `${file}:${line}${column === undefined ? '' : `:${column}`}`;
      return { command: cli, args: [...(flags ?? []), at] };
    }
  }
  return { command: 'open', args: ['-a', editor.path, file] };
}

export interface Launch {
  command: string;
  args: string[];
  /** Windows: pass args to the process unquoted. */
  verbatim?: boolean;
}

/**
 * The words double-quoted for a cmd.exe command line.
 * Throws on a word cmd.exe cannot take quoted: a quote ends the quoting and %VAR% expands inside it.
 */
export function cmdQuoted(words: string[]): string {
  for (const word of words)
    if (/["%\r\n\0]/.test(word))
      throw new Error(`${JSON.stringify(word)} cannot be passed to cmd.exe`);
  return words.map((word) => `"${word}"`).join(' ');
}

const VSCODE_FAMILY = ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'Windsurf'];
const JETBRAINS = ['IntelliJ IDEA', 'WebStorm', 'PyCharm', 'GoLand'];

/** Opens target, a folder or a file at line and column, with editor; distro is the WSL distro on Windows. */
export function editorCommand(
  platform: NodeJS.Platform,
  editor: Editor,
  target: string,
  line?: number,
  column?: number,
  distro?: string,
): Launch {
  if (platform === 'darwin') return editorLaunch(editor, target, line, column);
  const at = `${target}:${line}${column === undefined ? '' : `:${column}`}`;
  if (platform === 'win32') {
    const words = [editor.path, '--remote', `wsl+${distro}`];
    words.push(...(line === undefined ? [target] : ['-g', at]));
    // cmd.exe /s drops the outer quotes and keeps the inner ones, whatever spaces the paths hold.
    const commandLine = `"${cmdQuoted(words)}"`;
    return { command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', commandLine], verbatim: true };
  }
  if (line === undefined) return { command: editor.path, args: [target] };
  if (VSCODE_FAMILY.includes(editor.id)) return { command: editor.path, args: ['-g', at] };
  if (JETBRAINS.includes(editor.id))
    return { command: editor.path, args: ['--line', String(line), target] };
  return { command: editor.path, args: [at] };
}
