import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { t } from '../../i18n';
import { hitGroups, jumpTo, useSearchCursor } from './settings-jump';
import { hitId } from './SettingsNav';
import { SETTINGS_PAGES, useSettingsView } from './view';

/** The text with each [start, end) range set in a <mark>. */
export function HighlightText({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="hit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The settings that match the navigation's query, the page of the best hit first; a click opens one. */
export function SearchResults() {
  const query = useSettingsView((s) => s.query);
  const active = useSearchCursor((s) => s.active);
  const hits = hitGroups(query).flatMap((g) => g.hits);
  const current = Math.min(active, hits.length - 1);
  const count = t(
    {
      id: 'settings.search.resultCount',
      defaultMessage: '{count, plural, one {# result} other {# results}}',
    },
    { count: hits.length },
  );
  return (
    <>
      <div className="ps-live" role="status" aria-live="polite">
        {query !== '' && count}
      </div>
      {query !== '' &&
        (hits.length === 0 ? (
          <div className="empty">
            {t({ id: 'settings.nav.noMatch', defaultMessage: 'No matching settings' })}
          </div>
        ) : (
          <div className="ps-res">
            {/* The status above announces the count. */}
            <span className="ps-res-n" aria-hidden="true">
              {count}
            </span>
            <div
              id="settings-results"
              role="listbox"
              className="ps-grp"
              aria-label={t({ id: 'settings.search.results', defaultMessage: 'Search results' })}
            >
              {hits.map((hit, at) => {
                const page = SETTINGS_PAGES.find((p) => p.key === hit.page)!.label;
                let path: string | null = page;
                if (hit.id === `${hit.page}.page`) path = null;
                else if (hit.section)
                  path = t(
                    { id: 'settings.search.path', defaultMessage: '{page} › {section}' },
                    { page, section: hit.section },
                  );
                return (
                  <div
                    key={hit.id}
                    id={hitId(at)}
                    role="option"
                    aria-selected={at === current}
                    className="ps-opt"
                    onClick={() => jumpTo(hit)}
                  >
                    <span className="ps-opt-nm">
                      <span>
                        <HighlightText text={hit.label} ranges={hit.ranges} />
                      </span>
                      {path !== null && <span className="ps-path">{path}</span>}
                    </span>
                    <ChevronRight className="ic-sm" aria-hidden="true" />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
    </>
  );
}
