import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setLocaleSync, t } from '@/i18n';
import { setMenuLocale } from '../../apps/desktop/src/main/locales.js';

const CATALOG_DIR = path.resolve(import.meta.dirname, '../../apps/web/src/i18n/locales/zh-CN');

/** Every zh-CN catalog file merged, as loadLocale merges them. */
export function zhCatalog(): Record<string, string> {
  return Object.assign(
    {},
    ...readdirSync(CATALOG_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(path.join(CATALOG_DIR, file), 'utf8'))),
  );
}

const catalog = zhCatalog();

/** The zh-CN text of `id`; a missing id throws, so every check on it fails. */
export function zh(id: string): string {
  const text = catalog[id];
  if (text === undefined) throw new Error(`no zh-CN text for ${id}`);
  return text;
}

/** The zh-CN message `id` formatted with `values` through `t`. */
export const zhf = (id: string, values: Record<string, string | number>): string =>
  t({ id, defaultMessage: zh(id) }, values);

// The tests were written against the Chinese text.
setLocaleSync('zh-CN', zhCatalog());
setMenuLocale('zh-CN');
