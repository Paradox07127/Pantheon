import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface ModuleRef {
  file: string;
  line: number;
  statement: string;
  specifier: string;
  typeOnly: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

const STATIC = /^[ \t]*(import|export)(\s+type\b)?([^;'"`]*?)\bfrom\s*(['"])([^'"]+)\4/gm;
const BARE = /^[ \t]*import\s*(['"])([^'"]+)\1/gm;
const DYNAMIC = /\b(?:import|require)\s*\(\s*(['"`])([^'"`]+)\1/g;

function moduleRefs(file: string): ModuleRef[] {
  const text = readFileSync(file, 'utf8');
  const refs: ModuleRef[] = [];
  const add = (match: RegExpExecArray, specifier: string, typeOnly: boolean) =>
    refs.push({
      file: relative(ROOT, file),
      line: text.slice(0, match.index).split('\n').length,
      statement: match[0].trim().replace(/\s+/g, ' '),
      specifier,
      typeOnly,
    });
  for (const m of text.matchAll(STATIC)) add(m, m[5]!, Boolean(m[2]));
  for (const m of text.matchAll(BARE)) add(m, m[2]!, false);
  for (const m of text.matchAll(DYNAMIC)) add(m, m[2]!, false);
  return refs;
}

function refsUnder(...dirs: string[]): ModuleRef[] {
  return dirs.flatMap((dir) => sourceFiles(join(ROOT, dir)).flatMap(moduleRefs));
}

function resolvedPath(ref: ModuleRef): string | undefined {
  if (!ref.specifier.startsWith('.')) return undefined;
  return relative(ROOT, resolve(ROOT, dirname(ref.file), ref.specifier))
    .split(sep)
    .join('/');
}

const describeRef = (ref: ModuleRef) => `${ref.file}:${ref.line}: ${ref.statement}`;

const appDirs = readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `apps/${entry.name}/src`);

describe('package dependency direction', () => {
  it('keeps packages/domain free of workspace packages and of paths outside it', () => {
    const violations = refsUnder('packages/domain/src')
      .filter((ref) => {
        if (ref.specifier.startsWith('@pantheon/')) return true;
        const target = resolvedPath(ref);
        return target !== undefined && !target.startsWith('packages/domain/');
      })
      .map(describeRef);
    expect(violations).toEqual([]);
  });

  it('lets packages/protocol reach @pantheon/domain only through type-only imports and exports', () => {
    const violations = refsUnder('packages/protocol/src')
      .filter(
        (ref) =>
          (ref.specifier === '@pantheon/domain' || ref.specifier.startsWith('@pantheon/domain/')) &&
          !ref.typeOnly,
      )
      .map(describeRef);
    expect(violations).toEqual([]);
  });

  it('keeps apps on the @pantheon/control entry point and out of its internal files', () => {
    const violations = refsUnder(...appDirs)
      .filter((ref) => {
        if (ref.specifier.startsWith('@pantheon/control/')) return true;
        const target = resolvedPath(ref);
        return target !== undefined && target.startsWith('packages/control/');
      })
      .map(describeRef);
    expect(violations).toEqual([]);
  });
});
