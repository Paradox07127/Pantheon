import { currentLocale, t } from '../i18n';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The one duration text: each unit floors, and a zero second unit is left out. */
export function durationText(ms: number): string {
  const at = Math.max(0, ms);
  if (at < SECOND) return t({ id: 'lib.time.underSecond', defaultMessage: '<1s' });
  if (at < MINUTE)
    return t(
      { id: 'lib.time.seconds', defaultMessage: '{seconds}s' },
      { seconds: Math.floor(at / SECOND) },
    );
  if (at < 10 * MINUTE) {
    const minutes = Math.floor(at / MINUTE);
    const seconds = Math.floor((at % MINUTE) / SECOND);
    return seconds
      ? t(
          { id: 'lib.time.minutesSeconds', defaultMessage: '{minutes}m {seconds}s' },
          { minutes, seconds },
        )
      : t({ id: 'lib.time.minutes', defaultMessage: '{minutes}m' }, { minutes });
  }
  if (at < HOUR)
    return t(
      { id: 'lib.time.minutes', defaultMessage: '{minutes}m' },
      { minutes: Math.floor(at / MINUTE) },
    );
  if (at < DAY) {
    const hours = Math.floor(at / HOUR);
    const minutes = Math.floor((at % HOUR) / MINUTE);
    return minutes
      ? t(
          { id: 'lib.time.hoursMinutes', defaultMessage: '{hours}h {minutes}m' },
          { hours, minutes },
        )
      : t({ id: 'lib.time.hours', defaultMessage: '{hours}h' }, { hours });
  }
  const days = Math.floor(at / DAY);
  const hours = Math.floor((at % DAY) / HOUR);
  return hours
    ? t({ id: 'lib.time.daysHours', defaultMessage: '{days}d {hours}h' }, { days, hours })
    : t({ id: 'lib.time.days', defaultMessage: '{days}d' }, { days });
}

/** An age as a unit and a count, for one message to word. */
export function ageParts(ms: number): { unit: 'now' | 'minute' | 'hour' | 'day'; count: number } {
  if (ms < MINUTE) return { unit: 'now', count: 0 };
  if (ms < HOUR) return { unit: 'minute', count: Math.floor(ms / MINUTE) };
  if (ms < DAY) return { unit: 'hour', count: Math.floor(ms / HOUR) };
  return { unit: 'day', count: Math.floor(ms / DAY) };
}

const CLOCK = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;

const formats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = currentLocale();
  const key = `${locale} ${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) formats.set(key, (format = new Intl.DateTimeFormat(locale, options)));
  return format;
}

/** The one time of day text, 24-hour, in the interface language. */
export function clockText(at: number, opts?: { seconds?: boolean }): string {
  return dateFormat({
    ...CLOCK,
    ...(opts?.seconds ? { second: '2-digit' } : {}),
  }).format(at);
}

/** The one date text: today and yesterday by name, then the day, with the year before this one. */
export function dayText(at: number, now: number, opts?: { time?: boolean }): string {
  const day = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.toDateString() === today.toDateString())
    return opts?.time ? clockText(at) : t({ id: 'lib.time.today', defaultMessage: 'Today' });
  if (day.toDateString() === yesterday.toDateString())
    return opts?.time
      ? t(
          { id: 'lib.time.yesterdayAt', defaultMessage: 'Yesterday {time}' },
          { time: clockText(at) },
        )
      : t({ id: 'lib.time.yesterday', defaultMessage: 'Yesterday' });
  return dateFormat({
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    ...(opts?.time ? CLOCK : {}),
  }).format(at);
}
