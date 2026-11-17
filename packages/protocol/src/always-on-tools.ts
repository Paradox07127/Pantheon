import type { z } from 'zod';

/** The lead tools of the always_on profile group, by tool name. */
export const alwaysOnTools = {} as const satisfies Record<string, string>;

/** What each always_on tool does; a costly one asks the user before every call. */
export const alwaysOnToolEffects = {} as const satisfies Record<
  keyof typeof alwaysOnTools,
  'read' | 'write' | 'costly'
>;

export const alwaysOnInputSchemas = {} as const satisfies Record<string, z.ZodType>;
