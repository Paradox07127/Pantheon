import { useRef, useState } from 'react';
import { Drawing, token, useDraw, useThemeTick } from './shared';

// Mermaid places each render under a document id of its own.
let renders = 0;

export function MermaidDiagram({ spec, height }: { spec: { source: string }; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeTick();
  const [svg, setSvg] = useState('');
  const ready = useDraw(
    async (live) => {
      const { default: mermaid } = await import('mermaid');
      const at = box.current;
      if (!live() || !at) return undefined;
      const color = (name: string) => token(at, name);
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
          tertiaryColor: color('--bg'),
          lineColor: color('--mu'),
          textColor: color('--tx2'),
          dropShadow: 'none',
        },
      });
      const { svg } = await mermaid.render(`vis-mermaid-${++renders}`, spec.source);
      if (live()) setSvg(svg);
      return undefined;
    },
    [spec, theme],
  );
  return (
    <div ref={box} className="vis-fill" style={{ height }}>
      {/* Mermaid's own output in strict security mode; no other markup reaches this node. */}
      <div className="vis-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      {!ready && <Drawing />}
    </div>
  );
}
