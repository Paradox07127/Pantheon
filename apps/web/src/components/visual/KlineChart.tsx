import { useMemo, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { VisualContent } from '@pantheon/domain';
import type { CandlestickData, Time, UTCTimestamp } from 'lightweight-charts';
import { currentLocale, t } from '../../i18n';
import { Drawing, token, useDraw, useThemeTick } from './shared';

export type KlineSpec = Extract<VisualContent, { kind: 'kline' }>['spec'];
type SpecTime = KlineSpec['candles'][number]['time'];
type KlineRange = '1m' | '3m' | '1y';

const MONTHS: Record<KlineRange, number> = { '1m': 1, '3m': 3, '1y': 12 };
const DAY = 86_400_000;

// Numbers are seconds; a date stays a business day; a date-time becomes seconds.
const chartTime = (time: SpecTime): Time =>
  (typeof time === 'number'
    ? time
    : time.includes('T')
      ? Date.parse(time) / 1000
      : time) as UTCTimestamp;

const timeMs = (time: SpecTime): number =>
  typeof time === 'number' ? time * 1000 : Date.parse(time);

const monthsBefore = (at: number, months: number): number => {
  const date = new Date(at);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
};

// Weeks start on Monday; day 0 of the epoch was a Thursday.
const weekOf = (at: number): number => Math.floor((Math.floor(at / DAY) + 3) / 7);

/** One entry per week, timed at its first item; `merge` folds a later item of the week into it. */
function byWeek<T extends { time: SpecTime }>(items: T[], merge: (week: T, item: T) => void): T[] {
  const weeks: T[] = [];
  let current: number | undefined;
  for (const item of items) {
    const week = weekOf(timeMs(item.time));
    if (week === current) merge(weeks[weeks.length - 1]!, item);
    else weeks.push({ ...item });
    current = week;
  }
  return weeks;
}

/** The last one or three months as drawn, or the last year as weekly candles. */
function inRange(spec: KlineSpec, range: KlineRange): KlineSpec {
  const last = Math.max(...spec.candles.map((candle) => timeMs(candle.time)));
  const from = monthsBefore(last, MONTHS[range]);
  const within = <T extends { time: SpecTime }>(items: T[]) =>
    items.filter((item) => timeMs(item.time) > from);
  const candles = within(spec.candles);
  const lines = spec.lines?.map((line) => ({ ...line, points: within(line.points) }));
  if (range !== '1y') return { candles, ...(lines && { lines }) };
  return {
    candles: byWeek(candles, (week, candle) => {
      week.high = Math.max(week.high, candle.high);
      week.low = Math.min(week.low, candle.low);
      week.close = candle.close;
      if (candle.volume !== undefined) week.volume = (week.volume ?? 0) + candle.volume;
    }),
    ...(lines && {
      lines: lines.map((line) => ({
        ...line,
        points: byWeek(line.points, (week, point) => {
          week.value = point.value;
        }),
      })),
    }),
  };
}

const timeText = (time: SpecTime): string =>
  typeof time === 'number'
    ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
        time * 1000,
      )
    : time.replace('T', ' ');

const changeText = (change: number): string =>
  new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    signDisplay: 'exceptZero',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(change);

const volumeText = (volume: number): string =>
  new Intl.NumberFormat(currentLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(
    volume,
  );

export function KlineChart({ spec, height }: { spec: KlineSpec; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeTick();
  const [range, setRange] = useState<KlineRange>('3m');
  // The candle under the crosshair, as an index into the shown candles; else the last one reads.
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = useMemo(() => inRange(spec, range), [spec, range]);
  // A range only changes what shows once the candles span more than a month.
  const ranged = useMemo(() => {
    const times = spec.candles.map((candle) => timeMs(candle.time));
    return Math.min(...times) < monthsBefore(Math.max(...times), 1);
  }, [spec]);
  const ready = useDraw(
    async (live) => {
      const lib = await import('lightweight-charts');
      const at = box.current;
      if (!live() || !at) return undefined;
      const color = (name: string) => token(at, name);
      const chart = lib.createChart(at, {
        autoSize: true,
        layout: {
          background: { type: lib.ColorType.Solid, color: 'transparent' },
          textColor: color('--mu'),
          fontFamily: color('--font-mono'),
          attributionLogo: true,
        },
        grid: { vertLines: { color: color('--bd2') }, horzLines: { color: color('--bd2') } },
        rightPriceScale: { borderColor: color('--bd') },
        timeScale: { borderColor: color('--bd') },
        crosshair: { mode: lib.CrosshairMode.Normal },
      });
      const candles = chart.addSeries(lib.CandlestickSeries, {
        upColor: color('--ok'),
        downColor: color('--bad'),
        wickUpColor: color('--ok'),
        wickDownColor: color('--bad'),
        borderVisible: false,
      });
      candles.setData(
        shown.candles.map(({ time, open, high, low, close }) => ({
          time: chartTime(time),
          open,
          high,
          low,
          close,
        })),
      );
      if (shown.candles.some((candle) => candle.volume !== undefined)) {
        const volume = chart.addSeries(lib.HistogramSeries, {
          color: color('--bd'),
          priceScaleId: '',
          priceFormat: { type: 'volume' },
          priceLineVisible: false,
          lastValueVisible: false,
        });
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        candles.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });
        volume.setData(
          shown.candles.flatMap(({ time, volume: value }) =>
            value === undefined ? [] : [{ time: chartTime(time), value }],
          ),
        );
      }
      shown.lines?.forEach((line, index) =>
        chart
          .addSeries(lib.LineSeries, {
            color: color(`--series-${(index % 6) + 1}`),
            lineWidth: 2,
            title: line.name,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          .setData(line.points.map(({ time, value }) => ({ time: chartTime(time), value }))),
      );
      chart.timeScale().fitContent();
      const index = new Map(shown.candles.map((candle, i) => [String(chartTime(candle.time)), i]));
      chart.subscribeCrosshairMove((param) => {
        const bar = param.seriesData.get(candles) as CandlestickData | undefined;
        setHovered((bar && index.get(String(bar.time))) ?? null);
      });
      return () => chart.remove();
    },
    [shown, theme],
  );
  const at = hovered ?? shown.candles.length - 1;
  const candle = shown.candles[at];
  const base = at > 0 ? shown.candles[at - 1]!.close : candle?.open;
  const change = candle && base ? (candle.close - base) / base : undefined;
  const rangeLabel = t({ id: 'visual.kline.range', defaultMessage: 'Range' });
  return (
    <div className="vis-fill vis-kl" style={{ height }}>
      <div className="vis-kl-read">
        {candle && (
          <>
            <span className="vis-kl-n">{timeText(candle.time)}</span>
            <span>
              {t({ id: 'visual.kline.open', defaultMessage: 'O' })}
              <b>{candle.open}</b>
            </span>
            <span>
              {t({ id: 'visual.kline.high', defaultMessage: 'H' })}
              <b>{candle.high}</b>
            </span>
            <span>
              {t({ id: 'visual.kline.low', defaultMessage: 'L' })}
              <b>{candle.low}</b>
            </span>
            <span>
              {t({ id: 'visual.kline.close', defaultMessage: 'C' })}
              <b>{candle.close}</b>
            </span>
            {change !== undefined && (
              <span
                className="vis-kl-n"
                data-up={change > 0 || undefined}
                data-down={change < 0 || undefined}
              >
                {changeText(change)}
              </span>
            )}
            {candle.volume !== undefined && (
              <span>
                {t({ id: 'visual.kline.volume', defaultMessage: 'Vol' })}
                <b>{volumeText(candle.volume)}</b>
              </span>
            )}
          </>
        )}
        {ranged && (
          <RadioGroup<KlineRange>
            className="tb-seg"
            aria-label={rangeLabel}
            value={range}
            onValueChange={(next) => {
              setHovered(null);
              setRange(next);
            }}
          >
            <Radio.Root value="1m">
              {t({ id: 'visual.kline.oneMonth', defaultMessage: '1M' })}
            </Radio.Root>
            <Radio.Root value="3m">
              {t({ id: 'visual.kline.threeMonths', defaultMessage: '3M' })}
            </Radio.Root>
            <Radio.Root value="1y">
              {t({ id: 'visual.kline.oneYear', defaultMessage: '1Y' })}
            </Radio.Root>
          </RadioGroup>
        )}
      </div>
      <div className="vis-kl-plot">
        <div ref={box} className="vis-fill" />
        {!ready && <Drawing />}
      </div>
    </div>
  );
}
