import { editToolInputSchemas, type SessionStepDiff } from '@pantheon/protocol';

type FileDiff = SessionStepDiff['files'][number];

const fileHeader = (file: string, added: boolean) =>
  `diff --git a/${file} b/${file}\n--- ${added ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n`;

/** Line positions are relative to the recorded fragment, not the unknown surrounding file. */
function replacementHunk(before: string, after: string): string {
  const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const oldLines = lines(before),
    newLines = lines(after);
  const body = (text: string, rows: string[], prefix: string) =>
    rows.length === 0
      ? ''
      : rows.map((line) => `${prefix}${line}\n`).join('') +
        (text.endsWith('\n') ? '' : '\\ No newline at end of file\n');
  return (
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n` +
    body(before, oldLines, '-') +
    body(after, newLines, '+')
  );
}

function unifiedPatch(file: string, patch: string, oldFile = file): string {
  if (patch.startsWith('diff --git ')) return patch;
  const old = /^--- a\/(.+)$/m.exec(patch)?.[1] ?? oldFile;
  const next = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? file;
  const header = `diff --git a/${old} b/${next}\n`;
  if (patch.startsWith('--- ')) return header + patch;
  const headers = header + `--- a/${oldFile}\n+++ b/${file}\n`;
  if (patch.startsWith('@@')) return headers + patch;
  const rows = patch.replace(/\n$/, '').split('\n');
  const oldCount = rows.filter((row) => row.startsWith('-') || row.startsWith(' ')).length;
  const newCount = rows.filter((row) => row.startsWith('+') || row.startsWith(' ')).length;
  return (
    headers +
    `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n` +
    patch +
    (patch.endsWith('\n') ? '' : '\n')
  );
}

/** Converts the patch tool's file sections and unnumbered hunks without consulting a checkout. */
function patchFiles(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: { path: string; kind: string; moved?: string; hunks: string[][] } | undefined;
  const finish = () => {
    if (!file) return;
    const target = file.moved ?? file.path;
    let oldLine = 1,
      newLine = 1;
    const hunks = file.hunks
      .map((rows) => {
        const oldCount = rows.filter((row) => row[0] !== '+').length;
        const newCount = rows.filter((row) => row[0] !== '-').length;
        const header = `@@ -${oldCount ? oldLine : 0},${oldCount} +${newCount ? newLine : 0},${newCount} @@\n`;
        oldLine += oldCount;
        newLine += newCount;
        return header + rows.map((row) => `${row}\n`).join('');
      })
      .join('');
    files.push({
      path: target,
      patch: hunks
        ? `diff --git a/${file.path} b/${target}\n--- ${file.kind === 'Add' ? '/dev/null' : `a/${file.path}`}\n+++ ${file.kind === 'Delete' ? '/dev/null' : `b/${target}`}\n${hunks}`
        : null,
      truncated: false,
    });
  };
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      finish();
      file = { kind: header[1]!, path: header[2]!, hunks: [] };
    } else if (file && line.startsWith('*** Move to: '))
      file.moved = line.slice('*** Move to: '.length);
    else if (file && line.startsWith('@@')) file.hunks.push([]);
    else if (file && /^[ +\-]/.test(line)) {
      if (!file.hunks.length) file.hunks.push([]);
      file.hunks.at(-1)!.push(line);
    }
  }
  finish();
  return files;
}

/** Validates each runtime tool's input at the replay boundary, before constructing diffs. */
export function stepFiles(name: string, input: unknown): FileDiff[] {
  let files: FileDiff[] = [];
  switch (name.split('.').at(-1)) {
    case 'Edit': {
      const parsed = editToolInputSchemas.Edit.safeParse(input);
      if (!parsed.success) return [];
      const edit = parsed.data;
      files = [
        {
          path: edit.file_path,
          patch:
            fileHeader(edit.file_path, edit.old_string === '') +
            replacementHunk(edit.old_string, edit.new_string),
          truncated: edit.truncated ?? false,
        },
      ];
      break;
    }
    case 'MultiEdit': {
      const parsed = editToolInputSchemas.MultiEdit.safeParse(input);
      if (!parsed.success) return [];
      const edit = parsed.data;
      files = [
        {
          path: edit.file_path,
          patch: edit.edits.length
            ? fileHeader(edit.file_path, edit.edits[0]!.old_string === '') +
              edit.edits
                .map((change) => replacementHunk(change.old_string, change.new_string))
                .join('')
            : '',
          truncated: edit.truncated ?? false,
        },
      ];
      break;
    }
    case 'Write': {
      const parsed = editToolInputSchemas.Write.safeParse(input);
      if (!parsed.success) return [];
      const edit = parsed.data;
      files = [
        {
          path: edit.file_path,
          patch: fileHeader(edit.file_path, true) + replacementHunk('', edit.content),
          truncated: edit.truncated ?? false,
        },
      ];
      break;
    }
    case 'fileChange': {
      const parsed = editToolInputSchemas.fileChange.safeParse(input);
      if (!parsed.success) return [];
      files = parsed.data.changes.map((change) => ({
        path: change.path,
        patch: unifiedPatch(change.path, change.diff),
        truncated: parsed.data.truncated ?? false,
      }));
      break;
    }
    case 'file_change': {
      const parsed = editToolInputSchemas.file_change.safeParse(input);
      if (!parsed.success) return [];
      files = Object.entries(parsed.data.changes).map(([file, change]) => ({
        path: change.move_path ?? file,
        patch: unifiedPatch(change.move_path ?? file, change.unified_diff, file),
        truncated: false,
      }));
      break;
    }
    case 'apply_patch': {
      const parsed = editToolInputSchemas.apply_patch.safeParse(input);
      if (!parsed.success) return [];
      const edit = parsed.data;
      files = patchFiles(typeof edit === 'string' ? edit : edit.value);
      if (typeof edit !== 'string' && edit.truncated)
        for (const file of files) file.truncated = true;
      break;
    }
  }
  let remaining = 400 * 1024;
  return files.map((file) => {
    const bytes = Buffer.byteLength(file.patch ?? '');
    if (file.truncated || bytes > remaining) return { ...file, patch: null, truncated: true };
    remaining -= bytes;
    return file;
  });
}
