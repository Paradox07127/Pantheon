import { useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import type { MemoryDirectory, MemoryRecord } from '@pantheon/domain';
import { Menu, MenuCheckboxItem, MenuSeparator } from '../../components/Menu';
import { useMemoryView } from '../../data/memory-view';
import { t } from '../../i18n';
import { kindIcon } from './memory-kind';
import {
  NewMemoryDialog,
  saveMemory,
  type MemoryProposal,
  type SaveOptions,
} from './NewMemoryDialog';
import './entries-page.css';

export type EntriesState = 'active' | 'draft' | 'archived';

export interface EntriesFilters {
  state: EntriesState;
  kind?: MemoryRecord['kind'];
  /** Entries must carry every one of these tags; empty filters none. */
  tag: string[];
}

/** The search field of the top bar; `/` focuses it. */
export const ENTRIES_SEARCH_ID = 'memory-entries-search';

const STATES: { state: EntriesState; label: () => string }[] = [
  {
    state: 'active',
    label: () => t({ id: 'memory.entries.state.active', defaultMessage: 'Current' }),
  },
  {
    state: 'draft',
    label: () => t({ id: 'memory.entries.state.draft', defaultMessage: 'Pending review' }),
  },
  {
    state: 'archived',
    label: () => t({ id: 'memory.entries.state.archived', defaultMessage: 'Archived' }),
  },
];

const KINDS: { kind: MemoryRecord['kind']; label: () => string }[] = [
  {
    kind: 'decision',
    label: () => t({ id: 'memory.entries.kind.decision', defaultMessage: 'Decisions' }),
  },
  {
    kind: 'report',
    label: () => t({ id: 'memory.entries.kind.report', defaultMessage: 'Reports' }),
  },
  {
    kind: 'note',
    label: () => t({ id: 'memory.entries.kind.note', defaultMessage: 'Notes' }),
  },
];

/** Saves the memory and selects it, also when only its confirmation failed. */
export async function saveAndSelect(
  input: MemoryProposal,
  confirm: boolean,
  options?: SaveOptions,
) {
  const outcome = await saveMemory(input, confirm, options);
  if (outcome.id) useMemoryView.getState().select(outcome.id);
  return outcome;
}

/** The entries filter row: state, kind and tag, and how many entries match. */
export function EntriesBar({
  filters,
  counts,
  facets,
  total,
  onChange,
}: {
  filters: EntriesFilters;
  counts: MemoryDirectory['counts'] | null;
  facets: MemoryDirectory['facets'];
  total: number | null;
  onChange: (next: EntriesFilters) => void;
}) {
  const [tagFind, setTagFind] = useState('');
  const facetTags = [
    ...filters.tag
      .filter((tag) => !facets.tags.some((facet) => facet.tag === tag))
      .map((tag) => ({ tag, count: undefined })),
    ...facets.tags,
  ];
  const tags = facetTags.filter((facet) =>
    facet.tag.toLowerCase().includes(tagFind.trim().toLowerCase()),
  );
  const tagLabel = t({ id: 'memory.entries.tag', defaultMessage: 'Tag' });
  return (
    <div className="mep-bar">
      <RadioGroup<EntriesState>
        className="tb-seg"
        aria-label={t({ id: 'memory.entries.state', defaultMessage: 'State' })}
        value={filters.state}
        onValueChange={(state) => onChange({ ...filters, state })}
      >
        {STATES.map((s) => (
          <Radio.Root key={s.state} value={s.state}>
            {s.label()}
            {counts && <span className="mep-ct">{counts[s.state]}</span>}
          </Radio.Root>
        ))}
      </RadioGroup>
      <span className="mep-vsep" aria-hidden="true" />
      <div
        className="mep-kinds"
        role="group"
        aria-label={t({ id: 'memory.entries.kind', defaultMessage: 'Kind' })}
      >
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className="btn ghost sm"
            aria-pressed={filters.kind === kind}
            onClick={() => onChange({ ...filters, kind: filters.kind === kind ? undefined : kind })}
          >
            {kindIcon(kind)}
            {label()}
          </button>
        ))}
      </div>
      <span className="mep-vsep" aria-hidden="true" />
      <Menu
        label={tagLabel}
        trigger={
          <button type="button" className="btn ghost sm" aria-pressed={filters.tag.length > 0}>
            {filters.tag.length === 0 ? (
              tagLabel
            ) : (
              <span className="mep-tgsel">{filters.tag[0]}</span>
            )}
            {filters.tag.length > 1 && (
              <span className="mep-ct">
                {t(
                  { id: 'memory.entries.moreTags', defaultMessage: '+{count}' },
                  { count: filters.tag.length - 1 },
                )}
              </span>
            )}
            <ChevronDown aria-hidden="true" />
          </button>
        }
      >
        <label className="field mep-tagf">
          <Search aria-hidden="true" />
          <input
            type="text"
            maxLength={60}
            aria-label={t({ id: 'memory.entries.findTag', defaultMessage: 'Filter tags' })}
            placeholder={tagLabel}
            value={tagFind}
            onChange={(e) => setTagFind(e.target.value)}
            // Typing stays in the field instead of moving the menu's highlight.
            onKeyDown={(e) => {
              if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
                e.stopPropagation();
            }}
          />
        </label>
        <MenuCheckboxItem
          checked={filters.tag.length === 0}
          onChange={() => onChange({ ...filters, tag: [] })}
        >
          {t({ id: 'memory.entries.allTags', defaultMessage: 'All tags' })}
        </MenuCheckboxItem>
        {tags.length > 0 && <MenuSeparator />}
        {tags.map(({ tag, count }) => (
          <MenuCheckboxItem
            key={tag}
            checked={filters.tag.includes(tag)}
            onChange={(on) =>
              onChange({
                ...filters,
                tag: on ? [...filters.tag, tag] : filters.tag.filter((x) => x !== tag),
              })
            }
          >
            <span className="mep-tg">
              <span className="mep-tgn">{tag}</span>
              {count !== undefined && <span className="mep-ct">{count}</span>}
            </span>
          </MenuCheckboxItem>
        ))}
      </Menu>
      {total !== null && (
        <span className="mep-total">
          {t(
            {
              id: 'memory.entries.total',
              defaultMessage: '{count, plural, one {# entry} other {# entries}}',
            },
            { count: total },
          )}
        </span>
      )}
    </div>
  );
}

/** The entries tab's top bar controls: the search field and the button that records a memory. */
export function EntriesTopControls({ projectId }: { projectId: string }) {
  const query = useMemoryView((s) => s.query);
  const setQuery = useMemoryView((s) => s.setQuery);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="tb-end">
      <label className="field mep-find">
        <Search aria-hidden="true" />
        <input
          ref={field}
          id={ENTRIES_SEARCH_ID}
          type="search"
          maxLength={200}
          aria-label={t({ id: 'memory.entries.search', defaultMessage: 'Search memory' })}
          aria-keyshortcuts="/"
          placeholder={t({
            id: 'memory.entries.searchPlaceholder',
            defaultMessage: 'Search titles, bodies and keys',
          })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="ib mep-clear"
            aria-label={t({ id: 'memory.entries.clearSearch', defaultMessage: 'Clear search' })}
            onClick={() => {
              setQuery('');
              field.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </button>
        ) : (
          <span className="kbd" aria-hidden="true">
            /
          </span>
        )}
      </label>
      <button type="button" className="btn pri" aria-keyshortcuts="N" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t({ id: 'memory.entries.new', defaultMessage: 'New memory' })}
      </button>
      <NewMemoryDialog
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        onSubmit={saveAndSelect}
      />
    </div>
  );
}
