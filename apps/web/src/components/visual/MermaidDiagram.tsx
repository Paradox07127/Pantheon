import { useRef, useState } from 'react';
import { ClassDiagram } from './ClassDiagram';
import { ErDiagram } from './ErDiagram';
import { GraphDiagram, type GraphSpec } from './GraphDiagram';
import {
  LEGEND,
  fitZoom,
  layoutClass,
  layoutEr,
  layoutSequence,
  type ClassLayout,
  type ErLayout,
  type SeqLayout,
} from './mermaid-layout';
import { nativeType, parseMermaid } from './mermaid-model';
import { NativeLegend } from './NativeLegend';
import { SequenceDiagram } from './SequenceDiagram';
import { Drawing, token, useDraw, useThemeTick } from './shared';
import './mermaid.css';

// Mermaid places each render under a document id of its own.
let renders = 0;
// A diagram shrinks to fit no further than this, where its text reads; a larger one scrolls.
const FLOOR = 2 / 3;
// A tall diagram Pantheon draws grows its card to this, the height of the zoomed visual view.
const MAX_HEIGHT = 640;

/**
 * A diagram Pantheon draws, and the box width it was laid out for: an ER, sequence or class
 * diagram laid out here, or a flowchart or state diagram the graph lays out.
 */
type Native = { id: string; room: number } & (
  | { type: 'er'; layout: ErLayout }
  | { type: 'sequence'; layout: SeqLayout }
  | { type: 'class'; layout: ClassLayout }
  | { type: 'graph'; spec: GraphSpec }
);

// The node kinds a model may give with `A:::store` or `class A store`, and their series colours.
const KINDS = { client: 1, service: 2, store: 4, queue: 3, external: 5, policy: 6 };
const KIND_NAMES = Object.keys(KINDS).join('|');
const KIND_USED = new RegExp(`:::(?:${KIND_NAMES})\\b|^\\s*class\\s.*\\b(?:${KIND_NAMES})\\b`, 'm');
const KIND_HEADER = /^\s*(?:flowchart|graph|stateDiagram(?:-v2)?)\b/;

let paint: CanvasRenderingContext2D | undefined;
/** A colour as the browser paints it, in hex: mermaid's colour parser takes no var() or color-mix(). */
function painted(colour: string): string {
  paint ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = colour;
  paint.fillRect(0, 0, 1, 1);
  return `#${[...paint.getImageData(0, 0, 1, 1).data].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** A flowchart or state diagram that uses a node kind gets the kinds' classDefs after its header. */
function withKinds(source: string, color: (name: string) => string): string {
  if (!KIND_USED.test(source)) return source;
  const lines = source.split('\n');
  // Front matter ends at its second `---` line.
  let at = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  if (lines[0]?.trim() === '---' && at < 0) return source;
  at++;
  while (at < lines.length && (!lines[at]!.trim() || lines[at]!.trim().startsWith('%%'))) at++;
  if (!KIND_HEADER.test(lines[at] ?? '')) return source;
  const defs = Object.entries(KINDS).map(([kind, n]) => {
    const series = color(`--series-${n}`);
    const fill = painted(`color-mix(in srgb, ${series} 8%, ${color('--sf2')})`);
    const stroke = painted(`color-mix(in srgb, ${series} 45%, ${color('--bd')})`);
    return `  classDef ${kind} fill:${fill},stroke:${stroke}`;
  });
  return [...lines.slice(0, at + 1), ...defs, ...lines.slice(at + 1)].join('\n');
}

// A label's first line is its title, the lines after it its detail.
const TITLED = `.node > .label:not(.noteLabel, [class*='attribute-']) > foreignObject:first-of-type p`;

/**
 * The type of labels and the padding of label pills, which set the size of the boxes around them.
 * Mermaid measures labels under its own stylesheet, before the diagram reaches `mermaid.css`.
 */
const MEASURED = `
& { font-size: var(--fs-sm); }
${TITLED} { font-size: var(--fs-xs); }
${TITLED}::first-line { font-size: var(--fs-sm); font-weight: 600; }
.statediagram-state > .label > foreignObject + foreignObject p,
.noteLabel, .annotation-group, .attribute-comment, .cluster-label .nodeLabel { font-size: var(--fs-xs); }
.cluster-label .nodeLabel, .label-group p { font-weight: 600; }
.labelBkg { padding: 0 6px; border: var(--hair) solid transparent; font-size: var(--fs-xs); }
.attribute-type, .members-group, .methods-group { font-family: var(--font-mono); font-size: var(--fs-xs); }
.attribute-keys p:not(:empty) { padding: 0 4px; border: var(--hair) solid transparent; font-size: var(--fs-xs); }
`;

// A group's box, then its label, which mermaid centres along the box's top edge.
const GROUP_LABEL =
  /(<rect\b[^>]*?\sx="(-?[\d.]+)"[^>]*?\sy="(-?[\d.]+)"[^>]*><\/rect>(?:<\/g>)?<g class="cluster-label" transform=")translate\([^)]*\)/g;

/**
 * Mermaid's stylesheet selects by the diagram's id; under `:where()` it gives way to `mermaid.css`.
 * Group labels move to the top-left corner inside their box.
 */
function restyled(svg: string, id: string): string {
  const own = new RegExp(`#${id}(?![\\w-])`, 'g');
  return svg
    .replace(/<style>[\s\S]*?<\/style>/, (sheet) => sheet.replace(own, `:where(#${id})`))
    .replace(
      GROUP_LABEL,
      (_, head: string, x: string, y: string) => `${head}translate(${+x + 8}, ${+y + 4})`,
    );
}

export function MermaidDiagram({
  spec,
  height,
  grows = false,
  full = false,
}: {
  spec: { source: string };
  height: number;
  /** A diagram Pantheon draws taller than the height grows past it, up to the zoomed view's. */
  grows?: boolean;
  /** A flowchart or state diagram draws at full size and pans, as the Enlarge dialog does. */
  full?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeTick();
  const [drawn, setDrawn] = useState<{ svg: string; size?: { width: number; height: number } }>({
    svg: '',
  });
  const [native, setNative] = useState<Native | null>(null);
  const ready = useDraw(
    async (live) => {
      const { default: mermaid } = await import('mermaid');
      const at = box.current;
      if (!live() || !at) return undefined;
      const color = (name: string) => token(at, name);
      // The base theme derives every colour left out from light defaults, so each one is a token.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: color('font-family'),
        themeVariables: {
          fontFamily: color('font-family'),
          background: color('--sf'),
          primaryColor: color('--sf2'),
          primaryTextColor: color('--tx'),
          primaryBorderColor: color('--mu'),
          secondaryColor: color('--sf'),
          secondaryTextColor: color('--tx'),
          tertiaryColor: color('--bg'),
          tertiaryTextColor: color('--tx'),
          titleColor: color('--tx'),
          lineColor: color('--mu'),
          arrowheadColor: color('--mu'),
          textColor: color('--tx2'),
          edgeLabelBackground: color('--sf'),
          noteBkgColor: color('--bg'),
          noteTextColor: color('--tx'),
          noteBorderColor: color('--bd'),
          actorBkg: color('--sf2'),
          actorBorder: color('--mu'),
          actorTextColor: color('--tx'),
          actorLineColor: color('--mu'),
          signalColor: color('--tx2'),
          signalTextColor: color('--tx2'),
          labelBoxBkgColor: color('--sf2'),
          labelBoxBorderColor: color('--mu'),
          labelTextColor: color('--tx'),
          loopTextColor: color('--tx'),
          activationBkgColor: color('--sf2'),
          activationBorderColor: color('--mu'),
          sequenceNumberColor: color('--sf'),
          stateBkg: color('--sf2'),
          stateLabelColor: color('--tx'),
          labelBackgroundColor: color('--sf'),
          compositeBackground: color('--sf'),
          compositeTitleBackground: color('--sf2'),
          altBackground: color('--bg'),
          classText: color('--tx'),
          rowOdd: color('--sf'),
          rowEven: color('--sf2'),
          attributeBackgroundColorOdd: color('--sf'),
          attributeBackgroundColorEven: color('--sf2'),
          relationLabelBackground: color('--sf'),
          relationLabelColor: color('--tx2'),
          altSectionBkgColor: color('--sf'),
          excludeBkgColor: color('--sf2'),
          gridColor: color('--bd'),
          doneTaskBkgColor: color('--sf2'),
          doneTaskBorderColor: color('--mu'),
          taskTextClickableColor: color('--tx'),
          vertLineColor: color('--mu'),
          pieStrokeColor: color('--sf'),
          pieOuterStrokeColor: color('--mu'),
          archGroupBorderColor: color('--mu'),
          emUiFill: color('--sf2'),
          emUiStroke: color('--bd'),
          emSwimlaneBackgroundOdd: color('--sf'),
          emSwimlaneBackgroundStroke: color('--bd'),
          dropShadow: 'none',
        },
        fontSize: Number.parseFloat(color('--fs-sm')),
        themeCSS: MEASURED,
        flowchart: { nodeSpacing: 24, rankSpacing: 48, curve: 'linear' },
        sequence: { actorMargin: 48, messageMargin: 32, noteMargin: 8 },
        // A table row is its text line and this much more: 24px.
        er: { entityPadding: 4.5 },
      });
      const id = `vis-mermaid-${++renders}`;
      const type = nativeType(spec.source);
      if (type) {
        // A source mermaid cannot parse throws its error here, and mermaid draws nothing.
        const parsed = await parseMermaid(mermaid, spec.source, type);
        const room = at.clientWidth;
        const tall = grows ? Math.max(height, MAX_HEIGHT) : at.clientHeight;
        const laid: Native =
          parsed.type === 'er'
            ? { id, room, type: 'er', layout: await layoutEr(parsed.model, { x: room, y: tall }) }
            : parsed.type === 'sequence'
              ? { id, room, type: 'sequence', layout: layoutSequence(parsed.model) }
              : parsed.type === 'class'
                ? {
                    id,
                    room,
                    type: 'class',
                    layout: await layoutClass(parsed.model, { x: room, y: tall }),
                  }
                : { id, room, type: 'graph', spec: parsed.model };
        if (live()) setNative(laid);
        return undefined;
      }
      const drawing = await mermaid.render(id, withKinds(spec.source, color));
      if (!live()) return undefined;
      const svg = restyled(drawing.svg, id);
      // The viewBox holds the diagram's natural size in px.
      const view = /viewBox="([^"]*)"/
        .exec(svg)?.[1]!
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const [, , width = 0, tall = 0] = view ?? [];
      const fit = Math.min(at.clientWidth / width, at.clientHeight / tall);
      const scale = Math.min(1, Math.max(FLOOR, fit));
      setDrawn({ svg, ...(view && { size: { width: width * scale, height: tall * scale } }) });
      setNative(null);
      return undefined;
    },
    [spec, theme, grows, height],
  );
  if (native?.type === 'graph')
    return (
      <div ref={box} className="vis-fill">
        <GraphDiagram spec={native.spec} height={height} grows={grows} full={full} />
        {!ready && <Drawing />}
      </div>
    );
  if (native) {
    const { layout } = native;
    const below = layout.legend.length ? LEGEND : 0;
    const shown = grows
      ? Math.min(Math.max(height, layout.height + below), Math.max(height, MAX_HEIGHT))
      : height;
    const scale = Math.max(FLOOR, fitZoom(layout, { x: native.room, y: shown - below }));
    return (
      <div ref={box} className="vis-fill vis-nw" style={{ height: shown }}>
        <div className="vis-nd">
          {native.type === 'er' ? (
            <ErDiagram id={native.id} layout={native.layout} scale={scale} />
          ) : native.type === 'sequence' ? (
            <SequenceDiagram id={native.id} layout={native.layout} scale={scale} />
          ) : (
            <ClassDiagram id={native.id} layout={native.layout} scale={scale} />
          )}
        </div>
        {below > 0 && <NativeLegend entries={layout.legend} />}
        {!ready && <Drawing />}
      </div>
    );
  }
  return (
    <div ref={box} className="vis-fill" style={{ height }}>
      <div className="vis-mermaid">
        {/* Mermaid's own output in strict security mode; no other markup reaches this node. */}
        <div style={drawn.size} dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      </div>
      {!ready && <Drawing />}
    </div>
  );
}
