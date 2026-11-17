const URLS = /\b[a-z][a-z\d+.-]*:\/\/[^\s'"`<>()]+/gi;
// A quote touching a word character on its outer side is an apostrophe, as in "can't".
const QUOTED = /(?<!\w)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)(?!\w)/g;
const UUIDS = /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi;
// Hex runs of 7 or more with both a digit and a letter, as commit and content hashes are.
const HASHES = /\b(?=[\da-f]*\d)(?=[\da-f]*[a-f])[\da-f]{7,}\b/gi;
const NUMBERS = /\d+(?:\.\d+)?/g;
const ERROR_TYPE = /^([A-Z][\w$]*(?:Error|Exception))\b/;
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?)(?::\d+){1,2}\)?$/;
const OTHER_FRAME = /^\s*(.*?)@(.+?)(?::\d+){1,2}$/;
// A bundler's chunk name ends in a hash of eight characters with an upper-case letter or a digit.
const CHUNK = /[-.](?=[\w-]{0,7}[A-Z\d])[\w-]{8}\.m?js$/;
const FINGERPRINT_CHARS = 1000;

/** The message with URLs, quoted strings, ids, hashes and numbers replaced by placeholders. */
export const normalizeMessage = (message: string): string =>
  message
    .replace(URLS, '<url>')
    .replace(QUOTED, '<str>')
    .replace(UUIDS, '<id>')
    .replace(HASHES, '<hash>')
    .replace(NUMBERS, '<n>')
    .replace(/\s+/g, ' ')
    .trim();

/** The script path of a frame location, without its origin and query. */
const scriptPath = (location: string) =>
  location.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');

const ownSource = (file: string) =>
  file.startsWith('/') &&
  !file.includes('/node_modules/') &&
  !file.includes('/@vite/') &&
  !CHUNK.test(file);

/** The function and file of the first stack frame in the app's own source, not a dependency or a hashed chunk. */
export function firstAppFrame(stack: string | undefined): string | undefined {
  for (const line of stack?.split('\n') ?? []) {
    const match = V8_FRAME.exec(line) ?? OTHER_FRAME.exec(line);
    if (!match) continue;
    const file = scriptPath(match[2]!);
    if (ownSource(file)) return match[1] ? `${match[1]} ${file}` : file;
  }
  return undefined;
}

/** The error type a message or stack names, such as TypeError; empty when it names none. */
export const errorType = (message: string, stack?: string): string =>
  ERROR_TYPE.exec(message)?.[1] ?? ERROR_TYPE.exec(stack ?? '')?.[1] ?? '';

/** Groups errors by their type, their message without its parameters and the first frame in the app's own source. */
export function appErrorFingerprint(error: { message: string; stack?: string }): string {
  const type = errorType(error.message, error.stack);
  const text = normalizeMessage(
    type && error.message.startsWith(type)
      ? error.message.slice(type.length).replace(/^:\s*/, '')
      : error.message,
  );
  const frame = firstAppFrame(error.stack);
  return `${type}: ${text}${frame ? ` @ ${frame}` : ''}`.slice(0, FINGERPRINT_CHARS);
}
