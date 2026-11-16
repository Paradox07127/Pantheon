import type { DesktopBridge } from '@pantheon/protocol';

/** A problem the running app ran into: a failed command, an uncaught error or a console error. */
export interface AppError {
  /** ISO time it was recorded. */
  at: string;
  source: 'command' | 'error' | 'rejection' | 'console';
  message: string;
  command?: string;
  code?: string;
  input?: unknown;
}

const LIMIT = 50;
const TEXT_LIMIT = 500;

let entries: AppError[] = [];
let target: Promise<Awaited<ReturnType<DesktopBridge['debugTarget']>>> = Promise.resolve(null);

const clip = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.slice(0, TEXT_LIMIT)
    : Array.isArray(value)
      ? value.map(clip)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item)]))
        : value;

/** Keeps the entry, its strings cut to 500 characters, with the newest 50 before it. */
export function recordAppError(entry: Omit<AppError, 'at'>): void {
  const kept = clip({ at: new Date().toISOString(), ...entry }) as AppError;
  entries = [...entries, kept].slice(-LIMIT);
}

/** The recorded problems, oldest first. */
export const appErrors = (): readonly AppError[] => entries;

/** Records uncaught errors, unhandled rejections and console errors from here on; call once. */
export function captureAppErrors(): void {
  window.addEventListener('error', (event) =>
    recordAppError({ source: 'error', message: String(event.error ?? event.message) }),
  );
  window.addEventListener('unhandledrejection', (event) =>
    recordAppError({ source: 'rejection', message: String(event.reason) }),
  );
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    recordAppError({ source: 'console', message: args.map(String).join(' ') });
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
