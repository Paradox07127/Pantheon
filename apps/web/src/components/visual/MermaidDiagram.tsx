import { useRef, useState } from 'react';
import { Drawing, token, useDraw, useThemeTick } from './shared';

// Mermaid places each render under a document id of its own.
let renders = 0;
// A diagram shrinks to fit no further than this, where its text reads; a larger one scrolls.
const FLOOR = 2 / 3;

export function MermaidDiagram({ spec, height }: { spec: { source: string }; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeTick();
  const [drawn, setDrawn] = useState<{ svg: string; size?: { width: number; height: number } }>({
    svg: '',
  });
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
      });
      const { svg } = await mermaid.render(`vis-mermaid-${++renders}`, spec.source);
      if (!live()) return undefined;
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
      return undefined;
    },
    [spec, theme],
  );
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
