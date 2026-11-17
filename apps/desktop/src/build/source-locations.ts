import path from 'node:path';
import MagicString, { type SourceMap } from 'magic-string';
import { parseAst, type Plugin } from 'vite';

const ATTRIBUTE = 'data-pt-src';
const SOURCE_DIRECTORY = 'apps/web/src/';

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isNode(value)) return;
  visit(value);
  for (const key in value) {
    const child = value[key];
    if (typeof child === 'object' && child !== null) walk(child, visit);
  }
}

/** Marks each host element in a web `.tsx` file with the `file:line:column` of its opening `<`. */
export function injectSourceLocations(
  code: string,
  id: string,
  repoRoot: string,
): { code: string; map: SourceMap } | null {
  const file = id.split('?')[0]!;
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  if (
    !relative.startsWith(SOURCE_DIRECTORY) ||
    !relative.endsWith('.tsx') ||
    relative.split('/').includes('node_modules')
  )
    return null;

  const lineStarts = [0];
  for (let index = 0; index < code.length; index++)
    if (code[index] === '\n') lineStarts.push(index + 1);
  const locate = (offset: number): string => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return `${low + 1}:${offset - lineStarts[low]! + 1}`;
  };

  const output = new MagicString(code);
  let changed = false;
  walk(parseAst(code, { lang: 'tsx' }, file), (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    const name = node.name as Node & { name?: string };
    if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name!)) return;
    const attributes = node.attributes as (Node & { name?: { name?: string } })[];
    if (attributes.some((attribute) => attribute.name?.name === ATTRIBUTE)) return;
    output.appendLeft(name.end, ` ${ATTRIBUTE}="${relative}:${locate(node.start)}"`);
    changed = true;
  });
  if (!changed) return null;
  return { code: output.toString(), map: output.generateMap({ hires: true, source: file }) };
}

/** Dev-server only, so packaged builds carry no source paths. */
export function sourceLocations(repoRoot: string): Plugin {
  return {
    name: 'source-locations',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      return injectSourceLocations(code, id, repoRoot);
    },
  };
}
