import 'katex/dist/katex.min.css';
import {
  createContext,
  memo,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Braces } from 'lucide-react';
import type { VisualContent } from '@pantheon/domain';
import type { FileRef } from '@pantheon/protocol';
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { t } from '../i18n';
import { codePath, linkTarget, type LinkTarget } from './markdownLinks';
import { normalizeMathDelimiters } from './markdownMath';
import { rehypePlugins as textRehypePlugins, remarkPlugins } from './markdownPlugins';
import { Tip } from './Tip';
import { VisualFrame } from './visual/VisualCard';

const rehypePlugins: Options['rehypePlugins'] = [...textRehypePlugins, rehypeHighlight];

/** The directory relative file paths in model output are looked up from first. */
const MarkdownBase = createContext<string | undefined>(undefined);
export const MarkdownBaseProvider = MarkdownBase.Provider;

/** Shows a linked file in the app; false leaves it to the external editor. */
const MarkdownFiles = createContext<((ref: FileRef) => boolean) | undefined>(undefined);
export const MarkdownFilesProvider = MarkdownFiles.Provider;

/** The base path and the in-app opener for the links of the Markdown inside. */
export function MarkdownLinks(props: {
  base: string | undefined;
  show: (ref: FileRef) => boolean;
  children: ReactNode;
}) {
  return (
    <MarkdownBaseProvider value={props.base}>
      <MarkdownFilesProvider value={props.show}>{props.children}</MarkdownFilesProvider>
    </MarkdownBaseProvider>
  );
}

// Getters, so each text is read in the language loaded by then.
const OPEN_ERRORS: Record<string, string> = {
  get file_not_found() {
    return t({ id: 'components.markdown.fileNotFound', defaultMessage: "Can't find this file" });
  },
  get editor_unavailable() {
    return t({
      id: 'components.markdown.editorUnavailable',
      defaultMessage: 'No editor available',
    });
  },
  get link_refused() {
    return t({
      id: 'components.markdown.linkRefused',
      defaultMessage: "This kind of link can't be opened",
    });
  },
};

/** Why the desktop bridge could not open a link or a file. */
export const openFailureText = (error: { code: string; message: string }) =>
  OPEN_ERRORS[error.code] ??
  t(
    { id: 'components.markdown.openFailed', defaultMessage: "Couldn't open: {message}" },
    { message: error.message },
  );

/** A link or path that opens through the desktop bridge and shows why it could not. */
function Opener({
  target,
  as,
  href,
  children,
}: {
  target: LinkTarget;
  as: 'a' | 'code';
  href?: string;
  children: ReactNode;
}) {
  const base = useContext(MarkdownBase);
  const show = useContext(MarkdownFiles);
  const [error, setError] = useState<string | null>(null);
  // A held ⌘ or Ctrl opens a file in the external editor.
  const run = (call: 'open' | 'menu', editor = false) => {
    const bridge = window.pantheon;
    setError(null);
    if (target.kind === 'file' && call === 'open' && !editor && show?.(target.ref)) return;
    if (!bridge) return;
    const result =
      target.kind === 'web'
        ? bridge.openLink(target.url)
        : call === 'open'
          ? bridge.openFile({ ...target.ref, base })
          : bridge.fileMenu({ ...target.ref, base });
    void result.then((r) => {
      if (!r.ok) setError(openFailureText(r.error));
    });
  };
  const handlers = {
    onClick: (e: MouseEvent) => {
      e.preventDefault();
      run('open', e.metaKey || e.ctrlKey);
    },
    onContextMenu:
      target.kind === 'file'
        ? (e: MouseEvent) => {
            e.preventDefault();
            run('menu');
          }
        : undefined,
  };
  return (
    <>
      {as === 'a' ? (
        <Tip content={href ?? ''} disabled={!href}>
          <a href={href} {...handlers}>
            {children}
          </a>
        </Tip>
      ) : (
        <code
          className="md-path"
          role="link"
          tabIndex={0}
          {...handlers}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            run('open', e.metaKey || e.ctrlKey);
          }}
        >
          {children}
        </code>
      )}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** Inside a link's label, which leaves opening to the link. */
const InLink = createContext(false);

const FENCED = ['mermaid', 'vega-lite', 'kline'] as const;
type Fenced = (typeof FENCED)[number];

const fencedKind = (className: unknown): Fenced | null => {
  const names: unknown[] = Array.isArray(className) ? className : [];
  return FENCED.find((kind) => names.includes(`language-${kind}`)) ?? null;
};

type Hast = { type: string; value?: string; children?: Hast[] };
const textOf = (node: Hast): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

// A `url` on a data object at any depth, which the daemon also refuses in a drawn chart; the
// inline rows in its `values` are plain fields.
const fetchesData = (value: unknown, inData = false): boolean =>
  Array.isArray(value)
    ? value.some((child) => fetchesData(child, inData))
    : value !== null &&
      typeof value === 'object' &&
      Object.entries(value).some(
        ([key, child]) =>
          (inData && key === 'url') ||
          ((!inData || key !== 'values') && fetchesData(child, key === 'data')),
      );

const isTime = (time: unknown) => typeof time === 'string' || typeof time === 'number';
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function klineReason(spec: unknown): string | null {
  const candles = isObject(spec) ? spec.candles : undefined;
  if (!Array.isArray(candles) || !candles.length)
    return t({
      id: 'visual.markdown.noCandles',
      defaultMessage: 'A K-line block needs a candles array',
    });
  if (
    !candles.every(
      (candle) =>
        isObject(candle) &&
        isTime(candle.time) &&
        ['open', 'high', 'low', 'close'].every((key) => typeof candle[key] === 'number'),
    )
  )
    return t({
      id: 'visual.markdown.badCandle',
      defaultMessage: 'Each candle needs a time and a numeric open, high, low and close',
    });
  const lines = isObject(spec) ? spec.lines : undefined;
  if (
    lines !== undefined &&
    !(
      Array.isArray(lines) &&
      lines.every(
        (line) =>
          isObject(line) &&
          typeof line.name === 'string' &&
          Array.isArray(line.points) &&
          line.points.every(
            (point) => isObject(point) && isTime(point.time) && typeof point.value === 'number',
          ),
      )
    )
  )
    return t({
      id: 'visual.markdown.badLines',
      defaultMessage: 'Each line needs a name and points with a time and a numeric value',
    });
  return null;
}

/** What a fenced block draws, or why it cannot; null while its JSON is still incomplete. */
function fencedContent(kind: Fenced, source: string): VisualContent | { reason: string } | null {
  if (kind === 'mermaid') return source.trim() ? { kind, spec: { source } } : null;
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  if (kind === 'kline') {
    const reason = klineReason(spec);
    return reason
      ? { reason }
      : { kind, spec: spec as Extract<VisualContent, { kind: 'kline' }>['spec'] };
  }
  if (!isObject(spec))
    return {
      reason: t({
        id: 'visual.markdown.notObject',
        defaultMessage: 'A Vega-Lite block must be a JSON object',
      }),
    };
  return fetchesData(spec)
    ? {
        reason: t({
          id: 'visual.markdown.dataUrl',
          defaultMessage: 'Data must be inline in the spec; data.url is refused',
        }),
      }
    : { kind, spec };
}

/** A fenced visual can show its source in place. */
function FencedVisual({ kind, source, plain }: { kind: Fenced; source: string; plain: ReactNode }) {
  const content = useMemo(() => fencedContent(kind, source), [kind, source]);
  const [showSource, setShowSource] = useState(false);
  if (!content) return plain;
  if ('reason' in content)
    return (
      <>
        {plain}
        <p className="vis-reason">{content.reason}</p>
      </>
    );
  const label = t({ id: 'visual.markdown.source', defaultMessage: 'View source' });
  return (
    <VisualFrame
      content={content}
      size="M"
      inline
      replace={showSource ? <div className="vis-src">{plain}</div> : undefined}
      action={
        <Tip content={label}>
          <button
            type="button"
            className="ib"
            aria-label={label}
            aria-pressed={showSource}
            onClick={() => setShowSource((shown) => !shown)}
          >
            <Braces aria-hidden="true" />
          </button>
        </Tip>
      }
    />
  );
}

const components: Components = {
  a: ({ href, id, children }) => {
    const target = href ? linkTarget(href) : null;
    const label = <InLink.Provider value={true}>{children}</InLink.Provider>;
    return target ? (
      <Opener target={target} as="a" href={href}>
        {label}
      </Opener>
    ) : (
      <Tip content={href ?? ''} disabled={!href}>
        <a
          id={id}
          href={href}
          onClick={href?.startsWith('#') ? undefined : (e) => e.preventDefault()}
        >
          {label}
        </a>
      </Tip>
    );
  },
  // Fenced code always spans several source lines; only single-line inline code may be a path.
  code: ({ node, children, ...props }) => {
    const inLink = useContext(InLink);
    const at = node?.position;
    const ref =
      !inLink && at && at.start.line === at.end.line && typeof children === 'string'
        ? codePath(children)
        : null;
    return ref ? (
      <Opener target={{ kind: 'file', ref }} as="code">
        {children}
      </Opener>
    ) : (
      <code {...props}>{children}</code>
    );
  },
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0];
    const kind =
      code?.type === 'element' && code.tagName === 'code'
        ? fencedKind(code.properties.className)
        : null;
    const plain = <pre {...props}>{children}</pre>;
    return kind && code ? <FencedVisual kind={kind} source={textOf(code)} plain={plain} /> : plain;
  },
};

// The default drops every scheme it does not know, which includes `file:` and `name.ext:12`.
const urlTransform = (url: string): string =>
  /^file:/i.test(url) || /^[^:/?#]+\.\w+:\d/.test(url) ? url : defaultUrlTransform(url);

const blockDisallowed = ['img'];
// Filtering runs after rehype, so block tags are removed here instead of allowlisting inline tags (which would drop KaTeX MathML).
const inlineDisallowed = [
  'img',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
];

/** Rendered trees by input, least recently shown first, so a message mounted again is not parsed and highlighted again. */
const rendered = new Map<string, ReactElement>();
const RENDERED_MAX = 300;

export const Markdown = memo(function Markdown({
  text,
  inline,
}: {
  text: string;
  inline?: boolean;
}) {
  // Footnote ids are per message, so several messages on one page do not share them.
  const id = useId().replace(/[^\w-]/g, '');
  // The base path is read by `Opener` when clicked, so it is not part of the tree.
  const key = JSON.stringify([text, !!inline, text.includes('[^') ? id : null]);
  // The entry this message added; a streaming message drops it once its text grows.
  const added = useRef<string | null>(null);
  let body = rendered.get(key);
  if (body) {
    rendered.delete(key);
  } else {
    if (added.current !== null) rendered.delete(added.current);
    added.current = key;
    body = ReactMarkdown({
      remarkPlugins,
      rehypePlugins,
      remarkRehypeOptions: { clobberPrefix: `md${id}-` },
      components,
      urlTransform,
      disallowedElements: inline ? inlineDisallowed : blockDisallowed,
      unwrapDisallowed: inline,
      children: normalizeMathDelimiters(text),
    });
    if (rendered.size >= RENDERED_MAX) rendered.delete(rendered.keys().next().value!);
  }
  rendered.set(key, body);
  return inline ? <span className="md md-inline">{body}</span> : <div className="md">{body}</div>;
});
