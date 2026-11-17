import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  requireThat,
  type Principal,
  type Project,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import type {
  FilesListResult,
  FilesReadResult,
  SessionToolImage,
  SymbolsSearchResult,
} from '@pantheon/protocol';
import {
  inside,
  projectAccess,
  resolvedPath,
  sessionWorkspaceKind,
  type ControlContext,
} from './context.js';
import { artifactLimit } from './files.js';
import { runGit } from './git.js';
import { protectionList } from './protection.js';

// Files the app previews from their bytes rather than their text.
const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

interface WorkspaceScope {
  root: string;
  /** Paths the principal's sandbox may not read. */
  unreadable: string[];
}

/** Refuses a non-user principal any workspace but its own session's: the project root only when that is it. */
export function ownWorkspaceOnly(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
): void {
  projectAccess(ctx, p, projectId, 'project.read');
  if (p.role === 'user') return;
  const own = ctx.store.must<Session>('sessions', p.session_id!);
  requireThat(
    sessionId
      ? sessionId === p.session_id
      : sessionWorkspaceKind(ctx, own) === 'in_place' &&
          ctx.store.must<Workspace>('workspaces', own.workspace_id!).path ===
            ctx.store.must<Project>('projects', projectId).roots[0],
    'permission_denied',
    'A session reads only its own workspace',
  );
}

function workspaceRoot(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
): WorkspaceScope {
  ownWorkspaceOnly(ctx, p, projectId, sessionId);
  let root = ctx.store.must<Project>('projects', projectId).roots[0]!;
  if (sessionId) {
    const session = ctx.store.must<Session>('sessions', sessionId);
    requireThat(
      session.project_id === projectId,
      'permission_denied',
      'Session belongs to another project',
    );
    requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
    root = ctx.store.must<Workspace>('workspaces', session.workspace_id).path;
  }
  // Roots are registered resolved, so a symlink at the root was planted later.
  requireThat(
    lstatSync(root, { throwIfNoEntry: false })?.isDirectory() && realpathSync(root) === root,
    'invalid_state',
    'Workspace root is no longer a real directory',
  );
  const unreadable =
    p.role === 'user' || !ctx.protectionPaths
      ? []
      : protectionList({ ...ctx.protectionPaths, otherWorkspaces: [] })
          .filter((entry) => entry.deny === 'read_write')
          .map((entry) => entry.path);
  return { root, unreadable };
}

function workspacePath({ root, unreadable }: WorkspaceScope, relative: string): string {
  requireThat(
    !path.isAbsolute(relative),
    'invalid_input',
    'Path must be relative to the workspace',
  );
  const file = resolvedPath(path.resolve(root, relative));
  requireThat(inside(root, file), 'invalid_input', 'Path must stay inside the workspace');
  requireThat(
    !unreadable.some((entry) => inside(entry, file)),
    'permission_denied',
    'Path is protected from session reads',
  );
  return file;
}

/** Refuses fd unless the checked file still resolves inside root to the entry fd has open. */
function checkOpened(root: string, file: string, fd: number, unreadable: string[] = []): void {
  const opened = fstatSync(fd),
    current = statSync(file),
    real = realpathSync(file);
  requireThat(
    inside(root, real) && current.dev === opened.dev && current.ino === opened.ino,
    'invalid_input',
    'Path must stay inside the workspace',
  );
  requireThat(
    !unreadable.some((entry) => inside(entry, real)),
    'permission_denied',
    'Path is protected from session reads',
  );
}

export function openInside(
  root: string,
  file: string,
  flags: number,
  unreadable: string[] = [],
): number {
  const fd = openSync(file, flags);
  try {
    checkOpened(root, file, fd, unreadable);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export function filesList(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
  relative = '',
): Promise<FilesListResult> {
  const scope = workspaceRoot(ctx, p, projectId, sessionId),
    root = scope.root;
  const directory = workspacePath(scope, relative);
  const fd = openInside(
    root,
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
    scope.unreadable,
  );
  return listing(root, directory, fd, scope.unreadable).finally(() => closeSync(fd));
}

async function listing(
  root: string,
  directory: string,
  fd: number,
  unreadable: string[],
): Promise<FilesListResult> {
  const children = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.name !== '.git',
  );
  checkOpened(root, directory, fd, unreadable);
  if (!children.length) return { entries: [], truncated: false };
  const ignored = await runGit(
    root,
    ['check-ignore', '-z', '--stdin'],
    Buffer.from(
      children.map((entry) => path.relative(root, path.join(directory, entry.name))).join('\0') +
        '\0',
    ),
    true,
  );
  requireThat(
    ignored.exit_code === 0 || ignored.exit_code === 1,
    'workspace_read_failed',
    'Ignored files could not be checked',
  );
  const excluded = new Set(ignored.stdout.toString().split('\0'));
  const listed = children.filter(
    (entry) => !excluded.has(path.relative(root, path.join(directory, entry.name))),
  );
  // A link to a folder inside the workspace opens as that folder.
  const folders = new Set(
    listed
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        const target = path.join(directory, entry.name);
        try {
          return statSync(target).isDirectory() && inside(root, realpathSync(target));
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name),
  );
  listed.sort(
    (a, b) =>
      Number(folders.has(b.name)) - Number(folders.has(a.name)) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const entries = listed.slice(0, 1000).flatMap((entry): FilesListResult['entries'] => {
    if (folders.has(entry.name)) return [{ name: entry.name, kind: 'dir' }];
    try {
      const size = lstatSync(path.join(directory, entry.name)).size;
      return [{ name: entry.name, kind: 'file', size }];
    } catch (error) {
      // An entry removed since the directory was read is no longer listed.
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    }
  });
  checkOpened(root, directory, fd, unreadable);
  return { entries, truncated: listed.length > 1000 };
}

export function filesRead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
  relative: string,
): FilesReadResult {
  const scope = workspaceRoot(ctx, p, projectId, sessionId),
    root = scope.root;
  const file = workspacePath(scope, relative);
  // Without O_NONBLOCK, opening a FIFO waits for a writer before fstat can refuse it.
  const fd = openInside(root, file, constants.O_RDONLY | constants.O_NONBLOCK, scope.unreadable);
  try {
    const stat = fstatSync(fd);
    requireThat(stat.isFile(), 'invalid_input', 'Path must name a file');
    const mime = MEDIA[path.extname(relative).toLowerCase()];
    if (mime && stat.size > artifactLimit)
      return { path: relative, mime, size: stat.size, truncated: true };
    const limit = mime ? artifactLimit : 256 * 1024;
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    let length = 0,
      count: number;
    while (
      length < bytes.length &&
      (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0
    )
      length += count;
    const data = bytes.subarray(0, length);
    if (mime)
      return {
        path: relative,
        mime,
        data: data.toString('base64'),
        size: stat.size,
        truncated: false,
      };
    const result = { path: relative, size: stat.size, truncated: stat.size > limit };
    if (data.subarray(0, 8 * 1024).includes(0)) return { ...result, binary: true };
    const decoder = new StringDecoder('utf8');
    return { ...result, text: result.truncated ? decoder.write(data) : data.toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

/** An image a tool call of the session returned, found through the recorded event that names its hash. */
export function sessionToolImage(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
  hash: string,
): SessionToolImage {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  if (p.role !== 'user')
    requireThat(
      sessionId === p.session_id,
      'permission_denied',
      'A session reads only its own workspace',
    );
  const row = ctx.store.db
    .prepare(
      "SELECT payload FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind='agent.tool.completed' AND aggregate_id=? AND instr(payload, ?) > 0 LIMIT 1",
    )
    .get(session.project_id, sessionId, `"hash":"${hash}"`) as { payload: string } | undefined;
  const image = row
    ? (JSON.parse(row.payload) as { images?: { mime: string; hash: string }[] }).images?.find(
        (each) => each.hash === hash,
      )
    : undefined;
  requireThat(image, 'not_found', `Session ${sessionId} returned no image ${hash}`);
  requireThat(ctx.files.valid(hash), 'invalid_state', `Image ${hash} is missing or corrupt`);
  const bytes = readFileSync(path.join(ctx.files.directory, hash));
  return { mime: image.mime, data: bytes.toString('base64'), size: bytes.length };
}

function declarationPattern(extension: string): RegExp | undefined {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(extension)
    ? /^\s*(?:(?:export|default|declare|abstract|async)\s+)*(function|class|interface|type)\s+([\w$]+)/
    : extension === '.py'
      ? /^\s*(?:async\s+)?(def|class)\s+(\w+)/
      : extension === '.go'
        ? /^\s*(func|type)\s+(?:\([^)]*\)\s+)?(\w+)/
        : extension === '.rs'
          ? /^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|type)\s+(\w+)/
          : extension === '.swift'
            ? /^\s*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating)\s+)*(func|class|struct|enum|protocol|typealias)\s+(\w+)/
            : undefined;
}

// Source files read at once; they are still searched, and their errors thrown, in listing order.
const READ_BATCH = 64;
// Larger source files, usually generated, are not searched, which bounds the memory a batch holds.
const SOURCE_LIMIT = 1024 * 1024;

/** Access errors throw synchronously; a file error rejects only when the search reaches that file. */
export function symbolsSearch(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
  q: string,
): Promise<SymbolsSearchResult> {
  return workspaceSymbols(workspaceRoot(ctx, p, projectId, sessionId), q);
}

async function workspaceSymbols(scope: WorkspaceScope, q: string): Promise<SymbolsSearchResult> {
  const root = scope.root;
  const listed = await runGit(
    root,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    undefined,
    true,
  );
  requireThat(listed.exit_code === 0, 'workspace_read_failed', 'Files could not be listed');
  const files = [...new Set(listed.stdout.toString().split('\0').filter(Boolean))];
  const symbols: SymbolsSearchResult['symbols'] = [];
  const needle = q.toLowerCase();
  // Names are ASCII word characters, so a file declaring a match holds the needle up to ASCII case.
  const mentioned = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sources = files.flatMap((relative) => {
    const pattern = declarationPattern(path.extname(relative));
    return pattern && !relative.split('/').includes('.git') ? [{ relative, pattern }] : [];
  });
  const read = async (relative: string) => {
    const file = workspacePath(scope, relative);
    if (!(await lstat(file).catch(() => undefined))?.isFile()) return undefined;
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      checkOpened(root, file, handle.fd, scope.unreadable);
      const size = (await handle.stat()).size;
      if (size > SOURCE_LIMIT) return undefined;
      // Reads no more than the measured size, even from a file growing meanwhile.
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(size), 0, size, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  for (let start = 0; start < sources.length; start += READ_BATCH) {
    const batch = sources.slice(start, start + READ_BATCH);
    const reads = batch.map(({ relative }) =>
      read(relative).then(
        (bytes) => ({ bytes }),
        (error: unknown) => ({ error }),
      ),
    );
    for (const [position, { relative, pattern }] of batch.entries()) {
      const loaded = await reads[position]!;
      if ('error' in loaded) throw loaded.error;
      const bytes = loaded.bytes;
      if (!bytes || bytes.subarray(0, 8 * 1024).includes(0)) continue;
      const text = bytes.toString('utf8');
      if (!mentioned.test(text)) continue;
      for (const [index, line] of text.split('\n').entries()) {
        const match = pattern.exec(line);
        if (!match || !match[2]!.toLowerCase().includes(needle)) continue;
        const declaration = match[1]!;
        const kind = ['func', 'fn', 'def'].includes(declaration)
          ? 'function'
          : declaration === 'typealias'
            ? 'type'
            : declaration === 'protocol'
              ? 'interface'
              : declaration;
        symbols.push({ name: match[2]!, kind, path: relative, line: index + 1 });
        if (symbols.length === 50) return { symbols };
      }
    }
  }
  return { symbols };
}
