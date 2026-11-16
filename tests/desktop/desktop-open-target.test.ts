import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { editorLaunch, resolveFile, webLink } from '../../apps/desktop/src/main/open-target.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-open-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const file = (at: string, text = ''): string => {
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, text);
  return at;
};

describe('webLink', () => {
  it('allows http, https and mailto links', () => {
    expect(webLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(webLink('http://example.com')).toBe('http://example.com/');
    expect(webLink('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('refuses other protocols and unparsable input', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'vscode://file/a',
      'smb://host/share',
      'not a url',
    ])
      expect(webLink(url)).toBeNull();
  });
});

describe('resolveFile', () => {
  it('finds a relative path inside a root', () => {
    const root = tempDir();
    const target = file(path.join(root, 'src/a.ts'));
    expect(resolveFile({ path: 'src/a.ts' }, [root])).toBe(target);
  });

  it('prefers the base directory over the roots', () => {
    const root = tempDir();
    file(path.join(root, 'a.ts'));
    const inBase = file(path.join(root, 'pkg/a.ts'));
    expect(resolveFile({ path: 'a.ts', base: path.join(root, 'pkg') }, [root])).toBe(inBase);
  });

  it('ignores a base outside the roots', () => {
    const root = tempDir();
    const outside = tempDir();
    file(path.join(outside, 'a.ts'));
    const inRoot = file(path.join(root, 'a.ts'));
    expect(resolveFile({ path: 'a.ts', base: outside }, [root])).toBe(inRoot);
    expect(resolveFile({ path: 'b.ts', base: outside }, [root])).toBeNull();
  });

  it('refuses a path that climbs out of the roots', () => {
    const parent = tempDir();
    const root = path.join(parent, 'root');
    mkdirSync(root);
    const escaped = file(path.join(parent, 'secret.txt'));
    expect(resolveFile({ path: '../secret.txt' }, [root])).toBeNull();
    expect(resolveFile({ path: escaped }, [root])).toBeNull();
  });

  it('finds names that start with two dots inside a root', () => {
    const root = tempDir();
    const config = file(path.join(root, '..config'));
    const asset = file(path.join(root, '..assets/a.txt'));
    expect(resolveFile({ path: '..config' }, [root])).toBe(config);
    expect(resolveFile({ path: '..assets/a.txt' }, [root])).toBe(asset);
  });

  it('skips a symlink out of the roots in the first root for the file in the second', () => {
    const first = tempDir();
    const second = tempDir();
    const outside = tempDir();
    symlinkSync(file(path.join(outside, 'a.ts')), path.join(first, 'a.ts'));
    const inSecond = file(path.join(second, 'a.ts'));
    expect(resolveFile({ path: 'a.ts' }, [first, second])).toBe(inSecond);
  });

  it('refuses a symlink that points outside the roots', () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = file(path.join(outside, 'secret.txt'));
    symlinkSync(secret, path.join(root, 'link.txt'));
    expect(resolveFile({ path: 'link.txt' }, [root])).toBeNull();
  });

  it('refuses directories and missing files', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'dir'));
    expect(resolveFile({ path: 'dir' }, [root])).toBeNull();
    expect(resolveFile({ path: 'missing.ts' }, [root])).toBeNull();
  });

  it('accepts absolute paths and file URLs inside a root', () => {
    const root = tempDir();
    const target = file(path.join(root, 'a b.ts'));
    expect(resolveFile({ path: target }, [root])).toBe(target);
    expect(resolveFile({ path: pathToFileURL(target).href }, [root])).toBe(target);
  });
});

describe('editorLaunch', () => {
  const editor = (dir: string, id: string) => ({ id, name: id, path: path.join(dir, `${id}.app`) });

  it('jumps to the line and column with the VS Code command line tool', () => {
    const dir = tempDir();
    const vscode = editor(dir, 'Visual Studio Code');
    const cli = file(path.join(vscode.path, 'Contents/Resources/app/bin/code'));
    expect(editorLaunch(vscode, '/p/a.ts', 42, 7)).toEqual({
      command: cli,
      args: ['-g', '/p/a.ts:42:7'],
    });
  });

  it('falls back to open -a when the command line tool is missing', () => {
    const dir = tempDir();
    const cursor = editor(dir, 'Cursor');
    mkdirSync(cursor.path);
    expect(editorLaunch(cursor, '/p/a.ts', 42)).toEqual({
      command: 'open',
      args: ['-a', cursor.path, '/p/a.ts'],
    });
  });

  it('jumps to the line in Xcode with the chosen Xcode’s xed', () => {
    const xcode = editor(tempDir(), 'Xcode');
    expect(editorLaunch(xcode, '/p/a.swift', 42)).toEqual({
      command: 'env',
      args: [
        `DEVELOPER_DIR=${path.join(xcode.path, 'Contents/Developer')}`,
        'xed',
        '-l',
        '42',
        '/p/a.swift',
      ],
    });
  });

  it('opens with open -a when no line is given', () => {
    const dir = tempDir();
    const vscode = editor(dir, 'Visual Studio Code');
    file(path.join(vscode.path, 'Contents/Resources/app/bin/code'));
    expect(editorLaunch(vscode, '/p/a.ts')).toEqual({
      command: 'open',
      args: ['-a', vscode.path, '/p/a.ts'],
    });
  });
});
