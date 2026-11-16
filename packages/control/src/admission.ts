import {
  DomainError,
  requireThat,
  type HarnessAdapter,
  type RuntimeChoice,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';

export function runtime(
  ctx: ControlContext,
  name: string,
  role: 'writer' | 'reviewer' | 'text',
): HarnessAdapter {
  const adapter = ctx.adapters.get(name);
  requireThat(adapter, 'unsupported_capability', `Runtime ${name} not available`);
  requireThat(
    adapter.report.capabilities[role === 'writer' ? 'write_isolation' : 'text_execution']
      ?.status === 'supported' &&
      (role !== 'reviewer' || adapter.report.capabilities.read_isolation?.status === 'supported'),
    'unsupported_capability',
    `${name}: required execution isolation is not verified`,
  );
  return adapter;
}

/** Uses the fallback only when the existing runtime admission rejects the first choice. */
export function admitWriterChoice(
  ctx: ControlContext,
  choice: RuntimeChoice,
  fallback?: RuntimeChoice,
): RuntimeChoice {
  try {
    runtime(ctx, choice.runtime, 'writer');
    return choice;
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'unsupported_capability' || !fallback)
      throw error;
    runtime(ctx, fallback.runtime, 'writer');
    return fallback;
  }
}
