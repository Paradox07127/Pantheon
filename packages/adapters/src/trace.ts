import type { TraceSpan } from '@pantheon/domain';

/** The most base64 one image a tool returned carries in its event. */
export const imageLimit = 4 * 1024 * 1024;

export function tracePayload(value: unknown): Record<string, unknown> {
  let truncated = false;
  let remaining = 16384;
  let nodes = 512;
  const seen = new WeakSet<object>();
  const text = (value: string): string => {
    const kept = value.slice(0, Math.min(4096, remaining));
    remaining -= kept.length;
    if (kept.length < value.length) truncated = true;
    return kept;
  };
  const cap = (entry: unknown, depth: number): unknown => {
    if (nodes-- <= 0 || depth > 8 || remaining <= 0) {
      truncated = true;
      return null;
    }
    if (typeof entry === 'string') return text(entry);
    if (!entry || typeof entry !== 'object') return entry;
    if (seen.has(entry)) {
      truncated = true;
      return null;
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      const result: unknown[] = [];
      for (const field of entry) {
        if (result.length >= 64 || nodes <= 0 || remaining <= 0) {
          truncated = true;
          break;
        }
        result.push(cap(field, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      if (count++ >= 64 || nodes <= 0 || remaining <= 0) {
        truncated = true;
        break;
      }
      const name = text(key);
      Object.defineProperty(result, name, {
        value: cap((entry as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  const fields = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  const payload = cap(fields, 0) as Record<string, unknown>;
  if (truncated) payload.truncated = true;
  return payload;
}

export function toolInputSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const summary =
    input.command ??
    input.cmd ??
    input.file_path ??
    input.path ??
    (Array.isArray(input.changes)
      ? input.changes
          .flatMap((change) => (typeof change?.path === 'string' ? [change.path] : []))
          .join(', ')
      : undefined) ??
    input.query ??
    input.pattern ??
    input.description ??
    input.prompt ??
    input.task_name ??
    input.target;
  const text =
    Array.isArray(summary) && summary.every((part) => typeof part === 'string')
      ? summary.join(' ')
      : summary;
  return typeof text === 'string' && text.length > 0
    ? Array.from(text).slice(0, 200).join('')
    : undefined;
}

export function toolCommand(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const command = input.command ?? input.cmd;
  return Array.isArray(command) && command.every((part) => typeof part === 'string')
    ? command.join(' ')
    : typeof command === 'string'
      ? command
      : undefined;
}

export function reportedToolTokens(value: unknown): TraceSpan['tokens'] {
  if (!value || typeof value !== 'object') return;
  const usage = value as Record<string, unknown>;
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return;
  const cache = usage.cache_read_input_tokens ?? usage.cached_input_tokens;
  return {
    input:
      usage.input_tokens +
      (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) +
      (typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : 0),
    output: usage.output_tokens,
    ...(typeof cache === 'number' ? { cache_read: cache } : {}),
  };
}
