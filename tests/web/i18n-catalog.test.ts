import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extract, type MessageDescriptor } from '@formatjs/cli-lib';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { beforeAll, describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '../../apps/web/src');
const LOCALES_DIR = path.join(SRC, 'i18n/locales');
// Folders whose text is not behind t() yet; a folder leaves the list once it is converted.
const PENDING: string[] = [];
const CONVERTED: string[] = [];
// A language's own name, the same in every catalog.
const ENDONYMS = ['简体中文'];
// Han characters in code that judge data rather than show text, as file:line.
const DATA_HAN = [
  'screens/board/progress-model.ts:[...text].reduce((w, c) => w + (/[　-鿿]/.test(c) ? 12 : 7), 0);',
];

const SOURCES = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
  .map((file) => file.split(path.sep).join('/'))
  .sort();

const catalog = (locale: string): Record<string, string> =>
  Object.assign(
    {},
    ...readdirSync(path.join(LOCALES_DIR, locale))
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(path.join(LOCALES_DIR, locale, file), 'utf8'))),
  );

/** The arguments a message takes, as name:kind, with the plural and select branches walked. */
function argumentsOf(message: string): string[] {
  const found = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
      found.add(`${element.value}:${TYPE[element.type]}`);
      if (element.type === TYPE.plural || element.type === TYPE.select)
        for (const option of Object.values(element.options)) walk(option.value);
      if (element.type === TYPE.tag) walk(element.children);
    }
  };
  walk(parse(message));
  return [...found].sort();
}

/** Lines with Han characters outside comments. */
function hanInCode(text: string): string[] {
  const hits: string[] = [];
  let inBlock = false;
  text.split('\n').forEach((line, index) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end < 0) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\/\*.*?\*\//g, '');
    const open = code.indexOf('/*');
    if (open >= 0) {
      inBlock = true;
      code = code.slice(0, open);
    }
    code = code.replace(/(^|\s)\/\/.*$/, '');
    for (const name of ENDONYMS) code = code.replaceAll(`'${name}'`, "''");
    if (/\p{Script=Han}/u.test(code)) hits.push(`${index + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('message catalogs', () => {
  const messages: (MessageDescriptor & { file: string })[] = [];
  beforeAll(async () => {
    await Promise.all(
      SOURCES.map((file) =>
        extract([path.join(SRC, file)], {
          additionalFunctionNames: ['t'],
          onMsgExtracted: (_path, found) => messages.push(...found.map((m) => ({ ...m, file }))),
        }),
      ),
    );
  });
  const english = () => new Map(messages.map((m) => [m.id, m.defaultMessage ?? '']));

  it('finds the messages of the converted files', () => {
    expect(messages.some((m) => m.file === 'App.tsx')).toBe(true);
    expect(messages.some((m) => m.file === 'screens/settings/view.ts')).toBe(true);
  });

  it('gives each message ID one English text', () => {
    const texts = new Map<string, Set<string>>();
    for (const m of messages) {
      expect(m.defaultMessage, `${m.id} in ${m.file}`).toBeTruthy();
      texts.set(m.id, (texts.get(m.id) ?? new Set()).add(m.defaultMessage!));
    }
    expect([...texts].filter(([, set]) => set.size > 1).map(([id]) => id)).toEqual([]);
  });

  it('has a zh-CN text for every message ID and none for an ID no code uses', () => {
    const ids = [...english().keys()].sort();
    const zh = Object.keys(catalog('zh-CN')).sort();
    expect(
      ids.filter((id) => !zh.includes(id)),
      'missing from zh-CN',
    ).toEqual([]);
    expect(
      zh.filter((id) => !ids.includes(id)),
      'unused in zh-CN',
    ).toEqual([]);
  });

  it('takes the same arguments in zh-CN as in English', () => {
    const zh = catalog('zh-CN');
    const differ = [...english()]
      .filter(([id]) => id in zh)
      .filter(([id, text]) => argumentsOf(text).join() !== argumentsOf(zh[id]!).join())
      .map(([id]) => id);
    expect(differ).toEqual([]);
  });
});

describe('interface text', () => {
  it('keeps Chinese out of the code of converted folders', () => {
    const checked = SOURCES.filter(
      (file) =>
        CONVERTED.includes(file) || !PENDING.some((folder) => file.startsWith(`${folder}/`)),
    );
    expect(checked).toContain('App.tsx');
    const hits = checked.flatMap((file) =>
      hanInCode(readFileSync(path.join(SRC, file), 'utf8'))
        .filter((hit) => !DATA_HAN.includes(`${file}:${hit.slice(hit.indexOf(': ') + 2)}`))
        .map((hit) => `${file}:${hit}`),
    );
    expect(hits).toEqual([]);
  });
});
