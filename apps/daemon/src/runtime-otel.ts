import { createHash } from 'node:crypto';
import { RUNTIME_EVENT_KINDS } from '@pantheon/control';
import type { Event } from '@pantheon/domain';
import type { Store } from '@pantheon/store';

const INTERVAL_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const BATCH = 128;
const KINDS = new Set<string>([
  ...RUNTIME_EVENT_KINDS,
  'task.dispatch_failed',
  'task.stop_requested',
  'approval.delivered',
  'approval.delivery_failed',
  'session.gate_run_requested',
  'session.gate_run_completed',
  'session.gate_run_failed',
  'retrospective.recorded',
  'trace.evidence_read',
  'session.runtime_reported',
  'session.runtime_report_evaluated',
  'session.runtime_report_remembered',
]);
const hashId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
type Attribute = {
  key: string;
  value: { stringValue: string } | { intValue: string } | { boolValue: boolean };
};
const string = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(value) },
});

/** Allowlisted lifecycle metadata. Inputs, outputs, native transcript text and paths stay local. */
export function runtimeLogBatch(events: readonly Event[]) {
  const logRecords = events
    .filter((event) => KINDS.has(event.kind))
    .map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const attrs = [
        string('pantheon.project.id', event.project_id),
        string('pantheon.aggregate.id', event.aggregate_id),
        string('pantheon.event.id', event.event_id),
        integer('pantheon.event.sequence', event.sequence),
        string('pantheon.clock.source', 'daemon'),
      ];
      const turn =
        event.kind.startsWith('turn.') || event.kind === 'session.turn.delivery'
          ? event.aggregate_id
          : payload.turn_id;
      if (typeof turn === 'string' && /^[a-z0-9-]{1,80}$/i.test(turn))
        attrs.push(string('pantheon.turn.id', turn));
      for (const key of ['duration_ms', 'waited_ms'] as const) {
        const value = payload[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          attrs.push(integer(`pantheon.${key}`, value));
      }
      for (const key of ['session_id', 'tool_call_id'] as const) {
        const value = payload[key];
        if (typeof value === 'string' && /^[a-z0-9_.:-]{1,128}$/i.test(value))
          attrs.push(string(`pantheon.${key}`, value));
      }
      if (event.kind === 'agent.background.changed' && Array.isArray(payload.tasks))
        attrs.push(integer('pantheon.background.count', payload.tasks.length));
      if (event.kind === 'trace.evidence_read') {
        if (
          payload.view === 'summary' ||
          payload.view === 'findings' ||
          payload.view === 'workflow'
        )
          attrs.push(string('pantheon.analysis.view', payload.view));
        if (
          typeof payload.bytes === 'number' &&
          Number.isSafeInteger(payload.bytes) &&
          payload.bytes >= 0
        )
          attrs.push(integer('pantheon.analysis.response_bytes', payload.bytes));
      }
      if (
        event.kind === 'session.runtime_reported' &&
        (payload.disposition === 'experiment' ||
          payload.disposition === 'measure' ||
          payload.disposition === 'none')
      )
        attrs.push(string('pantheon.analysis.disposition', payload.disposition));
      if (
        event.kind === 'session.runtime_report_evaluated' &&
        (payload.outcome === 'improved' ||
          payload.outcome === 'unchanged' ||
          payload.outcome === 'regressed')
      )
        attrs.push(string('pantheon.analysis.outcome', payload.outcome));
      if (typeof payload.ok === 'boolean')
        attrs.push({ key: 'pantheon.tool.ok', value: { boolValue: payload.ok } });
      return {
        timeUnixNano: String(BigInt(event.created_at) * 1_000_000n),
        eventName: event.kind,
        body: { stringValue: event.kind },
        attributes: attrs,
        ...(typeof turn === 'string' && /^[a-z0-9-]{1,80}$/i.test(turn)
          ? { traceId: hashId(`pantheon.turn:${turn}`) }
          : {}),
      };
    });
  return logRecords.length
    ? {
        resourceLogs: [
          {
            resource: { attributes: [string('service.name', 'pantheon-daemon')] },
            scopeLogs: [{ scope: { name: 'pantheon.runtime' }, logRecords }],
          },
        ],
      }
    : null;
}

/** A bounded asynchronous tail. Reconnect retries the same batch; restart begins at the live cursor. */
export function startRuntimeOtel(store: Store, base: string, onError: (error: Error) => void) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('PANTHEON_OTLP_HTTP_ENDPOINT must be an HTTP(S) base URL without credentials');
  url.pathname = url.pathname.replace(/\/$/, '') + '/v1/logs';
  const kinds = [...KINDS];
  let cursor = store.cursor(),
    closed = false,
    nextAttempt = 0,
    retry = INTERVAL_MS;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  const pump = async () => {
    while (!closed) {
      // A short read has seen every row up to head, so the next read starts past a tail of other kinds.
      const head = store.cursor();
      const events = store.events(cursor, undefined, BATCH, kinds);
      const batch = events.length ? runtimeLogBatch(events) : null;
      if (batch) {
        const request = (controller = new AbortController());
        const timeout = setTimeout(() => request.abort(), 3000);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch),
            signal: request.signal,
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('OTLP collector rejected the batch');
          }
          const result = (await response.json().catch(() => ({}))) as {
            partialSuccess?: { rejectedLogRecords?: string | number };
          };
          if (Number(result?.partialSuccess?.rejectedLogRecords) > 0)
            onError(new Error('Pantheon OTLP collector partially rejected a runtime batch'));
        } finally {
          clearTimeout(timeout);
          controller = undefined;
        }
      }
      retry = INTERVAL_MS;
      if (events.length < BATCH) {
        cursor = head;
        return;
      }
      cursor = events.at(-1)!.sequence;
    }
  };
  const timer = setInterval(() => {
    if (closed || inFlight || Date.now() < nextAttempt) return;
    inFlight = pump()
      .catch(() => {
        if (!closed && retry === INTERVAL_MS)
          onError(new Error('Pantheon runtime OTLP export failed; retrying'));
        nextAttempt = Date.now() + retry;
        retry = Math.min(MAX_RETRY_MS, retry * 2);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, INTERVAL_MS);
  timer.unref();
  return async () => {
    closed = true;
    clearInterval(timer);
    controller?.abort();
    await inFlight;
  };
}
