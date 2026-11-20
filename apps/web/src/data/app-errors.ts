import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';

/** A problem the running app ran into: an uncaught error, an unhandled rejection or a console error. */
interface AppError {
  message: string;
  /** Where it was thrown, or the script position when no error came with it. */
  stack?: string;
}

const TEXT_LIMIT = 500;
const STACK_LIMIT = 4000;

/** The message cut to 500 characters and the stack to 4000. */
const appError = (message: string, stack?: string): AppError => ({
  message: message.slice(0, TEXT_LIMIT),
  ...(stack === undefined ? {} : { stack: stack.slice(0, STACK_LIMIT) }),
});

const consoleText = (arg: unknown): string => {
  if (arg instanceof Error || !arg || typeof arg !== 'object') return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
};

// Per minute: one report per message and 30 in all, so a render loop of console errors cannot flood the daemon.
const REPORT_MS = 60_000;
const REPORT_LIMIT = 30;
/** When each message was last reported, by kind and message with its numbers blanked. */
const reported = new Map<string, number>();
let reportTimes: number[] = [];

/** Sends the entry to the daemon's signals, unless the same message or too many went within the minute. */
function report(kind: 'error' | 'unhandled_rejection' | 'console', entry: AppError): void {
  const bridge = window.pantheon;
  if (!bridge || !entry.message) return;
  const now = Date.now(),
    key = `${kind}\n${entry.message.replace(/\d+/g, '0')}`;
  for (const [each, at] of reported) if (now - at >= REPORT_MS) reported.delete(each);
  reportTimes = reportTimes.filter((at) => now - at < REPORT_MS);
  if (reported.has(key) || reportTimes.length >= REPORT_LIMIT) return;
  reported.set(key, now);
  reportTimes.push(now);
  const input = {
    kind,
    message: entry.message,
    ...(entry.stack === undefined ? {} : { stack: entry.stack }),
  };
  void bridge.command(command(USER_PRINCIPAL_ID, 'signal.app_error', input, null)).catch(() => {});
}

/** Reports uncaught errors, unhandled rejections and console errors from here on; call once. */
export function captureAppErrors(): void {
  window.addEventListener('error', (event) =>
    report(
      'error',
      appError(
        String(event.error ?? event.message),
        event.error instanceof Error && event.error.stack
          ? event.error.stack
          : `${event.filename}:${event.lineno}:${event.colno}`,
      ),
    ),
  );
  window.addEventListener('unhandledrejection', (event) =>
    report(
      'unhandled_rejection',
      appError(
        String(event.reason),
        event.reason instanceof Error && event.reason.stack ? event.reason.stack : undefined,
      ),
    ),
  );
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const thrown = args.find((arg): arg is Error => arg instanceof Error && !!arg.stack);
    report('console', appError(args.map(consoleText).join(' '), thrown?.stack));
    consoleError(...args);
  };
}
