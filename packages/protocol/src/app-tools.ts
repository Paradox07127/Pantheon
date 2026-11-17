import type { z } from 'zod';

/** The lead tools of the app profile group, by tool name. */
export const appTools = {} as const satisfies Record<string, string>;

/** What each app tool does; a costly one asks the user before every call. */
export const appToolEffects = {} as const satisfies Record<
  keyof typeof appTools,
  'read' | 'write' | 'costly'
>;

export const appInputSchemas = {} as const satisfies Record<string, z.ZodType>;
