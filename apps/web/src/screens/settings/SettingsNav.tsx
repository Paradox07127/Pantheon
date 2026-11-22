import {
  Bell,
  Bot,
  Database,
  ExternalLink,
  FileDiff,
  Folder,
  Folders,
  GitBranch,
  Info,
  Keyboard,
  Link,
  Lock,
  MessageSquare,
  Puzzle,
  Route,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { t } from '../../i18n';
import { hitGroups, jumpTo, useSearchCursor } from './settings-jump';
import {
  navPage,
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  useSettingsView,
  type SettingsPage,
  type SettingsSection,
} from './view';
import './settings.css';

const PAGE_ICONS: Record<SettingsPage, LucideIcon> = {
  general: Settings2,
  appearance: Sun,
  sessionDisplay: MessageSquare,
  diff: FileDiff,
  harness: Bot,
  editor: ExternalLink,
  connections: Link,
  devices: Server,
  notifications: Bell,
  shortcuts: Keyboard,
  data: Database,
  about: Info,
  gates: ShieldCheck,
  worktrees: GitBranch,
  permissions: Lock,
  defaults: Route,
  project: Folder,
  extensions: Puzzle,
  projects: Folders,
};

export const thisComputer = () => t({ id: 'settings.nav.app', defaultMessage: 'This computer' });
export const allProjects = () => t({ id: 'settings.nav.projects', defaultMessage: 'All projects' });

export const matchCount = (count: number) =>
  t(
    {
      id: 'settings.nav.matches',
      defaultMessage: '{count, plural, one {# match} other {# matches}}',
    },
    { count },
  );

/** The id of the search result at the index, for the field's active descendant. */
export const hitId = (index: number) => `settings-hit-${index}`;

export function SettingsNav({ page }: { page: SettingsPage }) {
  const setPage = useSettingsView((s) => s.setPage);
  const query = useSettingsView((s) => s.query);
  const setQuery = useSettingsView((s) => s.setQuery);
  const active = useSearchCursor((s) => s.active);
  const setActive = useSearchCursor((s) => s.setActive);
  const searching = query !== '';
  const groups = hitGroups(query);
  const results = groups.flatMap((g) => g.hits);
  const current = Math.min(active, results.length - 1);
  const counts = new Map<SettingsPage, number>();
  for (const g of groups)
    counts.set(navPage(g.page), (counts.get(navPage(g.page)) ?? 0) + g.hits.length);
  const searchLabel = t({ id: 'settings.nav.search', defaultMessage: 'Search settings' });
  const group = (key: SettingsSection, title: string) => (
    <div key={key} role="group" aria-label={title} className="ps-group">
      <h4>{title}</h4>
      {SETTINGS_PAGES.filter((p) => p.section === key && p.group !== 'project').map((p) => {
        const count = counts.get(p.key) ?? 0;
        const Icon = PAGE_ICONS[p.key];
        return (
          <button
            key={p.key}
            type="button"
            className="ps-page"
            aria-current={p.key === page ? 'page' : undefined}
            data-dim={searching && count === 0 ? '' : undefined}
            onClick={() => setPage(p.key)}
          >
            <span className="ps-ico">
              <Icon aria-hidden="true" />
            </span>
            {p.label}
            {searching && count > 0 && <span className="ps-cnt">{matchCount(count)}</span>}
          </button>
        );
      })}
    </div>
  );
  return (
    <nav
      className="ps-side"
      aria-label={t({ id: 'settings.nav.label', defaultMessage: 'Settings sections' })}
    >
      <label className="ps-find">
        <Search aria-hidden="true" />
        <input
          type="search"
          role="combobox"
          aria-label={searchLabel}
          placeholder={searchLabel}
          aria-expanded={searching}
          aria-controls="settings-results"
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? hitId(current) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // An empty field lets Escape through to close the window.
              if (!searching) return;
              e.preventDefault();
              e.stopPropagation();
              setQuery('');
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (results.length === 0) return;
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive(Math.max(0, Math.min(results.length - 1, current + step)));
            } else if (e.key === 'Enter' && current >= 0) {
              e.preventDefault();
              jumpTo(results[current]!);
            }
          }}
        />
        <kbd className="kbd" aria-hidden="true">
          /
        </kbd>
      </label>
      {SETTINGS_SECTIONS.map((s) => group(s.key, s.label))}
    </nav>
  );
}
