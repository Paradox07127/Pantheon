import { useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ContextBreakdown as Breakdown } from '@pantheon/domain';
import type { RuntimeStatus } from '@pantheon/protocol';
import { ModelMark, RuntimeGlyph, runtimeColor, runtimeName } from '../../components/RuntimeGlyph';
import { currentLocale, t } from '../../i18n';
import { tokenText } from '../board/panels-model';
import { quotaUsed, quotaWindowName, quotaWindowText } from '../board/usage-model';
import './runtime-events.css';
import './overview.css';

/** Segments of the bar before the smaller ones join as one. */
const SEGMENTS = 5;

interface Row {
  key: string;
  label: string;
  tokens: number;
  kind: Breakdown['categories'][number]['kind'];
}

/** A list the runtime itemised, which opens to its items. */
interface Group {
  key: string;
  label: string;
  parts: { key: string; label: string; tokens: number }[];
}

// Labels are getters, so each is read in the language loaded by then.
const CATEGORY: Record<string, string> = {
  get system_prompt() {
    return t({ id: 'sessions.compose.context.systemPrompt', defaultMessage: 'System prompt' });
  },
  get system_tools() {
    return t({ id: 'sessions.compose.context.systemTools', defaultMessage: 'System tools' });
  },
  get mcp_tools() {
    return t({ id: 'sessions.compose.context.mcpTools', defaultMessage: 'MCP tools' });
  },
  get mcp_instructions() {
    return t({
      id: 'sessions.compose.context.mcpInstructions',
      defaultMessage: 'MCP instructions',
    });
  },
  get mcp_tools_deferred() {
    return t({
      id: 'sessions.compose.context.mcpToolsDeferred',
      defaultMessage: 'MCP tools (deferred)',
    });
  },
  get system_tools_deferred() {
    return t({
      id: 'sessions.compose.context.systemToolsDeferred',
      defaultMessage: 'System tools (deferred)',
    });
  },
  get custom_agents() {
    return t({ id: 'sessions.compose.context.customAgents', defaultMessage: 'Custom agents' });
  },
  get memory_files() {
    return t({ id: 'sessions.compose.context.memoryFiles', defaultMessage: 'Memory files' });
  },
  get skills() {
    return t({ id: 'sessions.compose.context.skills', defaultMessage: 'Skills' });
  },
  get messages() {
    return t({ id: 'sessions.compose.context.messages', defaultMessage: 'Messages' });
  },
  get autocompact_buffer() {
    return t({
      id: 'sessions.compose.context.autocompactBuffer',
      defaultMessage: 'Autocompact buffer',
    });
  },
  get compact_buffer() {
    return t({ id: 'sessions.compose.context.compactBuffer', defaultMessage: 'Compact buffer' });
  },
  get free_space() {
    return t({ id: 'sessions.compose.context.free', defaultMessage: 'Free space' });
  },
};

const field = (usage: unknown, key: string): unknown =>
  usage && typeof usage === 'object' ? (usage as Record<string, unknown>)[key] : undefined;
const count = (usage: unknown, key: string): number | null => {
  const value = field(usage, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** The breakdown's rows: those in use, the largest first, then the buffer, the free space and the out-of-window ones. */
function breakdownRows(breakdown: Breakdown): Row[] {
  const rows = breakdown.categories.map((c): Row => ({
    key: c.id,
    label: CATEGORY[c.id] ?? c.id,
    tokens: c.tokens,
    kind: c.kind,
  }));
  return [
    ...rows.filter((r) => r.kind === 'used').sort((a, b) => b.tokens - a.tokens),
    ...rows.filter((r) => r.kind === 'buffer'),
    ...rows.filter((r) => r.kind === 'free'),
    ...rows.filter((r) => r.kind === 'deferred'),
  ];
}

/** The lists the breakdown itemises, those with items. */
function breakdownGroups(breakdown: Breakdown): Group[] {
  const groups: Group[] = [
    {
      key: 'mcp_tools',
      label: CATEGORY.mcp_tools!,
      parts: breakdown.mcp_tools
        .filter((tool) => tool.loaded)
        .map((tool) => ({
          key: `${tool.server}/${tool.name}`,
          label: tool.name,
          tokens: tool.tokens,
        })),
    },
    {
      key: 'memory_files',
      label: CATEGORY.memory_files!,
      parts: breakdown.memory_files.map((file) => ({
        key: file.path,
        label: file.path,
        tokens: file.tokens,
      })),
    },
    {
      key: 'custom_agents',
      label: CATEGORY.custom_agents!,
      parts: breakdown.agents.map((agent) => ({
        key: `${agent.source}/${agent.type}`,
        label: agent.type,
        tokens: agent.tokens,
      })),
    },
  ];
  return groups.filter((group) => group.parts.length > 0);
}

/**
 * The token counts a runtime without a breakdown reported, summed over the turn's requests, so none
 * is a part of the window; cached and reasoning tokens apart.
 */
function usageRows(usage: unknown): Row[] {
  if (field(usage, 'tokens_unreported') === true) return [];
  const input = count(usage, 'input_tokens');
  const cached = count(usage, 'cached_input_tokens');
  const output = count(usage, 'output_tokens');
  const reasoning = count(usage, 'reasoning_output_tokens');
  const rows: Row[] = [];
  if (input !== null)
    rows.push({
      key: 'input',
      kind: 'deferred',
      label: t({ id: 'sessions.compose.context.input', defaultMessage: 'Input' }),
      tokens: input - (cached ?? 0),
    });
  if (cached !== null)
    rows.push({
      key: 'cached',
      kind: 'deferred',
      label: t({ id: 'sessions.compose.context.cached', defaultMessage: 'Cached input' }),
      tokens: cached,
    });
  if (output !== null)
    rows.push({
      key: 'output',
      kind: 'deferred',
      label: t({ id: 'sessions.compose.context.output', defaultMessage: 'Output' }),
      tokens: output - (reasoning ?? 0),
    });
  if (reasoning !== null)
    rows.push({
      key: 'reasoning',
      kind: 'deferred',
      label: t({ id: 'sessions.compose.context.reasoning', defaultMessage: 'Reasoning' }),
      tokens: reasoning,
    });
  return rows;
}

/** What fills the context window, by category, then the runtime's quota windows when reported. */
export function ContextBreakdown({
  usage,
  runtime,
  model = null,
  quota,
}: {
  usage: unknown;
  runtime?: string;
  model?: string | null;
  quota?: RuntimeStatus['quota'];
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const breakdown = field(usage, 'context_breakdown') as Breakdown | undefined;
  const rows = breakdown ? breakdownRows(breakdown) : usageRows(usage);
  const groups = breakdown ? breakdownGroups(breakdown) : [];
  const used = count(usage, 'context_tokens');
  const window = count(usage, 'context_window');
  const autoCompact = count(usage, 'auto_compact_at_tokens');
  const percent = new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const share = (tokens: number) => (window ? percent.format(tokens / window) : '');
  // The largest rows in use get a segment each, the buffer a grey one; free space is the rest.
  const ranked = rows.filter((r) => r.kind === 'used');
  const own = ranked.length > SEGMENTS ? ranked.slice(0, SEGMENTS - 1) : ranked;
  const rest = ranked.slice(own.length);
  const restTokens = rest.reduce((sum, r) => sum + r.tokens, 0);
  // Without a breakdown the latest request's context fills the bar, split as the turn's tokens are.
  const split = breakdown || used === null ? [] : rows.filter((r) => r.tokens > 0);
  const splitTokens = split.reduce((sum, r) => sum + r.tokens, 0);
  const whole = split.length
    ? split.map((r) => ({
        key: r.key,
        label: r.label,
        tokens: r.tokens,
        grow: (used! * r.tokens) / splitTokens,
      }))
    : !breakdown && used !== null
      ? [{ key: 'used', label: '', tokens: used, grow: used }]
      : [];
  const stepped = breakdown ? own : split;
  const step = (key: string) => {
    const at = stepped.findIndex((r) => r.key === key);
    return at >= 0 ? String(at + 1) : 'other';
  };
  const segments = [
    ...whole.map((s) => ({ ...s, step: s.key === 'used' ? '1' : step(s.key) })),
    ...own.map((r) => ({
      key: r.key,
      label: r.label,
      tokens: r.tokens,
      grow: r.tokens,
      step: step(r.key),
    })),
    ...(rest.length
      ? [
          {
            key: 'other',
            label: t({ id: 'sessions.compose.context.other', defaultMessage: 'Other' }),
            tokens: restTokens,
            grow: restTokens,
            step: 'other',
          },
        ]
      : []),
    ...rows
      .filter((r) => r.kind === 'buffer')
      .map((r) => ({
        key: r.key,
        label: r.label,
        tokens: r.tokens,
        grow: r.tokens,
        step: 'buffer',
      })),
  ];
  const filledTokens = segments.reduce((sum, s) => sum + s.grow, 0);
  const free = window ? Math.max(window - filledTokens, 0) : 0;
  const listed = [
    ...segments.map((s) => (s.label ? `${s.label} ${tokenText(s.tokens)}` : tokenText(s.tokens))),
    ...(free
      ? [
          `${t({ id: 'sessions.compose.context.free', defaultMessage: 'Free space' })} ${tokenText(free)}`,
        ]
      : []),
  ];
  const swatch = (row: Row) =>
    row.kind === 'free'
      ? 'free'
      : row.kind === 'buffer'
        ? 'buffer'
        : row.kind === 'deferred' && !split.includes(row)
          ? 'deferred'
          : step(row.key);
  // Rows in use, then the buffer and free space, then those out of the window, each a block.
  const blocks = [
    rows.filter((r) => r.kind === 'used'),
    rows.filter((r) => r.kind === 'buffer' || r.kind === 'free'),
    rows.filter((r) => r.kind === 'deferred'),
  ].filter((block) => block.length > 0);
  const toggle = (key: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const now = Date.now();
  return (
    <div className="cp-cx">
      {runtime && (
        <div className="cp-cxh">
          <span className="cp-cxi">
            {model ? (
              <>
                <span role="img" aria-label={runtimeName(runtime)}>
                  <RuntimeGlyph runtime={runtime} size={14} />
                </span>
                <ModelMark model={model} beside={runtime} size={14} />
                <span className="cp-cxl">{model}</span>
              </>
            ) : (
              <>
                <RuntimeGlyph runtime={runtime} size={14} />
                <span className="cp-cxl">{runtimeName(runtime)}</span>
              </>
            )}
          </span>
        </div>
      )}
      <div className="cp-cxu">
        {used !== null && window ? (
          <span>
            {t(
              { id: 'sessions.compose.context.used', defaultMessage: '{share} used' },
              { share: percent.format(used / window) },
            )}
          </span>
        ) : null}
        <span className="mono">
          {used === null ? '—' : tokenText(used)} / {window ? tokenText(window) : '—'}
        </span>
      </div>
      <span
        className="cp-cxb"
        role="img"
        aria-label={t(
          { id: 'sessions.compose.context.bar', defaultMessage: 'Context: {parts}' },
          { parts: listed.join(t({ id: 'sessions.run.separator', defaultMessage: ', ' })) },
        )}
      >
        {segments.map((s) => (
          <i key={s.key} data-step={s.step} style={{ flexGrow: s.grow }} />
        ))}
        {free > 0 && <i data-step="free" style={{ flexGrow: free }} />}
        {autoCompact !== null && window ? (
          <b
            className="cp-cxm"
            style={{ left: `${Math.min(autoCompact / window, 1) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
      </span>
      {autoCompact !== null && (
        <span className="cp-cxa">
          {t(
            {
              id: 'sessions.compose.context.autoCompactAt',
              defaultMessage: 'Auto-compacts at {tokens}',
            },
            { tokens: tokenText(autoCompact) },
          )}
        </span>
      )}
      <table className="cp-cxt">
        {blocks.map((block) => (
          <tbody key={block[0]!.key}>
            {block.map((row) => (
              <tr key={row.key} data-deferred={row.kind === 'deferred' || undefined}>
                <td>
                  <i className="cp-cxs" data-step={swatch(row)} aria-hidden="true" />
                </td>
                <td>{row.label}</td>
                <td className="mono">{tokenText(row.tokens)}</td>
                <td className="mono">{row.kind === 'deferred' ? '—' : share(row.tokens)}</td>
              </tr>
            ))}
          </tbody>
        ))}
        {groups.length > 0 && (
          <tbody>
            {groups.flatMap((group) => {
              const expanded = open.has(group.key);
              return [
                <tr key={group.key} data-group>
                  <td colSpan={3}>
                    <button
                      type="button"
                      className="cp-cxx"
                      aria-expanded={expanded}
                      onClick={() => toggle(group.key)}
                    >
                      <ChevronRight className="ic-sm" aria-hidden="true" />
                      {group.label}
                    </button>
                  </td>
                  <td className="mono">{group.parts.length}</td>
                </tr>,
                ...(expanded
                  ? group.parts.map((part) => (
                      <tr key={`${group.key}:${part.key}`} data-part>
                        <td />
                        <td className="mono">{part.label}</td>
                        <td className="mono">{tokenText(part.tokens)}</td>
                        <td />
                      </tr>
                    ))
                  : []),
              ];
            })}
          </tbody>
        )}
      </table>
      {runtime && quota?.windows.length ? (
        <div className="cp-cxq">
          {quota.windows.map((w) => (
            <div key={w.window} className="cp-cxw">
              <span>{quotaWindowText(w, now)}</span>
              <span className="mono">{`${Math.round(w.used_percent)}%`}</span>
              <div
                className="meter"
                role="meter"
                aria-label={t(
                  {
                    id: 'sessions.compose.context.quotaMeter',
                    defaultMessage: '{window} quota used',
                  },
                  { window: quotaWindowName(w.window) },
                )}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={w.used_percent}
                style={{ '--v': `${quotaUsed(w)}%`, '--c': runtimeColor(runtime) } as CSSProperties}
              >
                <i />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
