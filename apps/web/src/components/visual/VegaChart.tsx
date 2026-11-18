import { useRef } from 'react';
import type { Loader } from 'vega';
import type { VisualizationSpec } from 'vega-embed';
import { t } from '../../i18n';
import { Drawing, token, useDraw, useThemeTick } from './shared';

// Specs carry their data inline; any fetch, including a URL in a spec drawn earlier, is refused.
const refuse = (): Promise<never> =>
  Promise.reject(
    new Error(
      t({ id: 'visual.vega.noFetch', defaultMessage: 'Charts cannot load data from outside' }),
    ),
  );
const loader = { load: refuse, sanitize: refuse, http: refuse, file: refuse } as unknown as Loader;

export function VegaChart({ spec, height }: { spec: Record<string, unknown>; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeTick();
  const ready = useDraw(
    async (live) => {
      const [{ default: embed }, { expressionInterpreter }] = await Promise.all([
        import('vega-embed'),
        import('vega-interpreter'),
      ]);
      const at = box.current;
      if (!live() || !at) return undefined;
      const color = (name: string) => token(at, name);
      const size = Number.parseFloat(token(at, '--fs-xs'));
      const title = Number.parseFloat(token(at, '--fs-sm'));
      // vega-embed lets a spec's usermeta.embedOptions override the options below.
      const { usermeta: _, ...drawn } = spec;
      const result = await embed(
        at,
        {
          width: 'container',
          height: 'container',
          autosize: { type: 'fit', contains: 'padding' },
          ...drawn,
        } as VisualizationSpec,
        {
          mode: 'vega-lite',
          actions: false,
          ast: true,
          expr: expressionInterpreter,
          loader,
          config: {
            background: 'transparent',
            font: color('font-family'),
            view: { stroke: 'transparent' },
            // No axis lines or ticks; a hairline grid on value axes only.
            axis: {
              domain: false,
              ticks: false,
              tickSize: 0,
              grid: true,
              gridColor: color('--bd2'),
              gridWidth: 0.5,
              labelColor: color('--mu'),
              titleColor: color('--tx2'),
              labelFontSize: size,
              titleFontSize: size,
              titleFontWeight: 600,
            },
            axisDiscrete: { grid: false },
            // Vega-Lite already hides labels that overlap; this hides those that would touch.
            axisXQuantitative: { labelSeparation: 8 },
            legend: {
              orient: 'top',
              symbolType: 'circle',
              // A symbol's size is its area: an 8px circle.
              symbolSize: 64,
              labelColor: color('--mu'),
              titleColor: color('--tx2'),
              labelFontSize: size,
              titleFontSize: size,
            },
            scale: { barBandPaddingInner: 0.25 },
            bar: { cornerRadius: 3 },
            point: { size: 48 },
            line: { strokeWidth: 1.5 },
            header: {
              labelColor: color('--mu'),
              titleColor: color('--tx2'),
              labelFontSize: size,
              titleFontSize: size,
            },
            // Vega-Lite draws text and rule marks black unless told otherwise.
            text: { color: color('--tx2'), fontSize: size },
            rule: { color: color('--tx2') },
            title: {
              anchor: 'start',
              color: color('--tx'),
              fontSize: title,
              fontWeight: 600,
              subtitleColor: color('--mu'),
              subtitleFontSize: size,
            },
            range: { category: [1, 2, 3, 4, 5, 6].map((n) => color(`--series-${n}`)) },
          },
        },
      );
      return result.finalize;
    },
    [spec, theme],
  );
  return (
    <div className="vis-fill" style={{ height }}>
      <div ref={box} className="vis-vega" />
      {!ready && <Drawing />}
    </div>
  );
}
