import { t, type Message } from '../../i18n';
import { PAGE_NAME, SETTINGS_INDEX, type SettingRecord } from './settings-index';
import { SETTINGS_PAGES, type SettingsPage } from './view';

export interface SettingHit {
  id: string;
  page: SettingsPage;
  /** The label in the loaded language. */
  label: string;
  /** The name of the group on the page that holds the setting, in the loaded language. */
  section?: string;
  score: number;
  /** The query matched only the page or section name, so the hit opens the page. */
  pageOnly: boolean;
  /** The parts of the label that hold a query word, as [start, end) for <mark>. */
  ranges: [number, number][];
}

const SPLIT = /[\s\p{P}]+/u;
const HAN = /\p{Script=Han}/u;

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
const words = (text: string) => text.split(SPLIT).filter(Boolean);
// The text in the loaded language and in English.
const both = (message: Message) => [...new Set([fold(t(message)), fold(message.defaultMessage)])];

/** Whether the term starts a word of the text, or for Chinese stands anywhere in it. */
const holds = (text: string, term: string) =>
  HAN.test(term) ? text.includes(term) : words(text).some((w) => w.startsWith(term));

function labelScore(label: string, term: string, short: boolean): number {
  if (label === term) return 100;
  if (label.startsWith(term)) return 80;
  if (short) return 0;
  if (words(label).some((w) => w.startsWith(term))) return 80;
  return label.includes(term) ? 60 : 0;
}

const subsequence = (text: string, term: string) => {
  let at = 0;
  for (const c of text) if (c === term[at]) at++;
  return at === term.length;
};

const ORDER = new Map(SETTINGS_PAGES.map((p, i) => [p.key, i]));

/** The best score of one query word in the record, and whether only the page or section held it. */
function termScore(record: SettingRecord, term: string): { score: number; pageOnly: boolean } {
  const han = HAN.test(term);
  const short = !han && term.length < 2;
  const single = han && term.length === 1;
  const isPage = record.label === PAGE_NAME[record.page];
  const label = Math.max(0, ...both(record.label).map((l) => labelScore(l, term, short)));
  if (label) return { score: label, pageOnly: isPage };
  if (short) return { score: 0, pageOnly: false };
  const places = isPage
    ? []
    : [PAGE_NAME[record.page], ...(record.section ? [record.section] : [])];
  if (!single && places.some((m) => both(m).some((text) => holds(text, term))))
    return { score: 40, pageOnly: true };
  if (record.keywords && both(record.keywords).some((text) => holds(text, term)))
    return { score: 30, pageOnly: isPage };
  if (single) return { score: 0, pageOnly: false };
  if (record.options?.().some((o) => holds(fold(o), term))) return { score: 20, pageOnly: isPage };
  if (!han && term.length >= 3 && subsequence(fold(record.label.defaultMessage), term))
    return { score: 10, pageOnly: isPage };
  return { score: 0, pageOnly: false };
}

/** The label folded unit by unit, with each folded unit's index in the label. */
function foldMap(label: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let i = 0;
  for (const c of label) {
    const f = fold(c);
    text += f;
    for (let k = 0; k < f.length; k++) at.push(i);
    i += c.length;
  }
  at.push(i);
  return { text, at };
}

/** Where each term stands in the label, at a word start when it can, merged and in order. */
function rangesIn(label: string, terms: string[]): [number, number][] {
  const { text, at } = foldMap(label);
  const found: [number, number][] = [];
  for (const term of terms) {
    let start = -1;
    for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + 1)) {
      if (start < 0) start = i;
      if (i === 0 || SPLIT.test(text[i - 1]!)) {
        start = i;
        break;
      }
    }
    if (start >= 0) found.push([at[start]!, at[start + term.length]!]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** The settings that hold every word of the query, best first; none for an empty query. */
export function searchSettings(query: string): SettingHit[] {
  const terms = words(fold(query));
  if (terms.length === 0) return [];
  const hits: (SettingHit & { order: number })[] = [];
  SETTINGS_INDEX.forEach((record, order) => {
    const scores = terms.map((term) => termScore(record, term));
    if (scores.some((s) => s.score === 0)) return;
    const label = t(record.label);
    const whole = both(record.label).some((l) => words(l).join(' ') === terms.join(' '));
    hits.push({
      id: record.id,
      page: record.page,
      label,
      section: record.section && t(record.section),
      // A record scores as its weakest word, so every word has to hold up.
      score: whole ? 100 : Math.min(...scores.map((s) => s.score)),
      pageOnly: scores.every((s) => s.pageOnly),
      ranges: rangesIn(label, terms),
      order,
    });
  });
  return hits
    .sort(
      (a, b) => b.score - a.score || ORDER.get(a.page)! - ORDER.get(b.page)! || a.order - b.order,
    )
    .map(({ order: _order, ...hit }) => hit);
}
