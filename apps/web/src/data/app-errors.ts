import type { DesktopBridge } from '@pantheon/protocol';

/** A problem the running app ran into: a failed command, an uncaught error or a console error. */
export interface AppError {
  /** Increases with each entry recorded. */
  id: number;
  /** ISO time it was recorded. */
  at: string;
  source: 'command' | 'error' | 'rejection' | 'console';
  message: string;
  /** Where it was thrown, or the script position when no error came with it. */
  stack?: string;
  command?: string;
  code?: string;
  status?: number;
  details?: unknown;
  input?: unknown;
}

const LIMIT = 50;
const TEXT_LIMIT = 500;
const STACK_LIMIT = 4000;

let entries: AppError[] = [];
let nextId = 1;
let target: Promise<Awaited<ReturnType<DesktopBridge['debugTarget']>>> = Promise.resolve(null);

const clip = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.slice(0, TEXT_LIMIT)
    : Array.isArray(value)
      ? value.map(clip)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item)]))
        : value;

/** Keeps the entry, its stack cut to 4000 characters and other strings to 500, with the newest 50 before it. */
export function recordAppError({ stack, ...entry }: Omit<AppError, 'id' | 'at'>): AppError {
  const kept = {
    ...(clip({ id: nextId++, at: new Date().toISOString(), ...entry }) as AppError),
    ...(stack === undefined ? {} : { stack: stack.slice(0, STACK_LIMIT) }),
  };
  entries = [...entries, kept].slice(-LIMIT);
  return kept;
}

const consoleText = (arg: unknown): string => {
  if (arg instanceof Error || !arg || typeof arg !== 'object') return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
};

/** The recorded problems, oldest first. */
export const appErrors = (): readonly AppError[] => entries;

/** Records uncaught errors, unhandled rejections and console errors from here on; call once. */
export function captureAppErrors(): void {
  window.addEventListener('error', (event) =>
    recordAppError({
      source: 'error',
      message: String(event.error ?? event.message),
      stack:
        event.error instanceof Error && event.error.stack
          ? event.error.stack
          : `${event.filename}:${event.lineno}:${event.colno}`,
    }),
  );
  window.addEventListener('unhandledrejection', (event) =>
    recordAppError({
      source: 'rejection',
      message: String(event.reason),
      ...(event.reason instanceof Error && event.reason.stack ? { stack: event.reason.stack } : {}),
    }),
  );
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const thrown = args.find((arg): arg is Error => arg instanceof Error && !!arg.stack);
    recordAppError({
      source: 'console',
      message: args.map(consoleText).join(' '),
      ...(thrown ? { stack: thrown.stack } : {}),
    });
    consoleError(...args);
  };
  // A debug session reads this over CDP.
  Object.defineProperty(window, '__pantheonAppErrors', {
    configurable: true,
    get: () => entries.map((entry) => ({ ...entry })),
  });
  if (window.pantheon) target = window.pantheon.debugTarget().catch(() => null);
}

/** Where a debug session can reach this app, as read once by `captureAppErrors`; null in a packaged build. */
export const debugTarget = () => target;
