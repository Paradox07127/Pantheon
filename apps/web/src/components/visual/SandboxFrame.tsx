import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Drawing } from './shared';
import { VisualError } from './VisualError';
import './sandbox-frame.css';

// With no hosts this is the offline policy; each host opens every kind of request to it alone.
const policy = (hosts: string[]): string => {
  const at = hosts.map((host) => ` ${host}`).join('');
  return `default-src 'none'; script-src 'unsafe-inline'${at}; style-src 'unsafe-inline'${at}; img-src${at} data: blob:; font-src${at} data:${hosts.length > 0 ? `; connect-src${at}` : ''}`;
};
// Runs before the page's own scripts and tells the app each address the policy blocked and each
// script error. It stays on the first line, so an error's line is the line in the page's own HTML.
const REPORTER =
  "<script>document.addEventListener('securitypolicyviolation',function(e){parent.postMessage({blocked:e.blockedURI},'*')});addEventListener('error',function(e){parent.postMessage({error:String(e.error||e.message),line:e.lineno},'*')})</script>";
// Only a plain https origin goes into the policy, which sits inside an attribute.
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/;

export function SandboxFrame({
  spec,
  height,
  network,
  onBlocked,
  onFix,
  onViewSpec,
}: {
  spec: { html: string };
  height: number;
  network: boolean;
  onBlocked: (url: string) => void;
  onFix?: ((error: string) => Promise<string | null>) | undefined;
  onViewSpec: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useRef(onBlocked);
  report.current = onBlocked;
  // The hosts the page tried while offline, which are the ones the card asks to allow.
  const [asked, setAsked] = useState<string[]>([]);
  // The desktop app serves the page from its own origin, under the policy it sends with it.
  const serve = window.pantheon?.visualServe;
  // The doctype keeps the page out of quirks mode; a second one in the page's own HTML is ignored.
  const doc = serve
    ? `<!doctype html>${REPORTER}${spec.html}`
    : `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy(network ? asked : [])}">${REPORTER}${spec.html}`;
  const [served, setServed] = useState<{ doc: string; url: string } | null>(null);
  const [unserved, setUnserved] = useState<{ doc: string; message: string } | null>(null);
  // The app puts these hosts in the policy it sends with the page; the frame keeps the page it
  // shows until the page served with them replaces it.
  const allowed = serve && network ? asked : [];
  const hosts = allowed.join(' ');
  useEffect(() => {
    if (!serve) return;
    let live = true;
    void serve({ html: doc, hosts: allowed }).then((result) => {
      if (!live) return;
      if (result.ok) setServed({ doc, url: result.value.url });
      else setUnserved({ doc, message: result.error.message });
    });
    return () => {
      live = false;
    };
  }, [doc, hosts]);
  const url = served?.doc === doc ? served.url : null;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ doc: string; line: number; message: string } | null>(null);
  useEffect(() => {
    const hear = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data = event.data as { blocked?: unknown; error?: unknown; line?: unknown } | null;
      const url = data?.blocked;
      // The page can post this message itself, so the address may not parse.
      if (typeof url === 'string' && /^https?:/i.test(url) && URL.canParse(url)) {
        report.current(url);
        const origin = new URL(url).origin;
        if (!network && HTTPS_ORIGIN.test(origin))
          setAsked((hosts) => (hosts.includes(origin) ? hosts : [...hosts, origin]));
      }
      if (typeof data?.error === 'string' && typeof data.line === 'number') {
        const message = data.error;
        const line = data.line;
        setFailed((first) => (first?.doc === doc ? first : { doc, line, message }));
      }
    };
    window.addEventListener('message', hear);
    return () => window.removeEventListener('message', hear);
  }, [doc, network]);
  return (
    <div className="vis-fill" style={{ height }}>
      {(!serve || url) && (
        <iframe
          ref={frame}
          className="vis-page"
          sandbox="allow-scripts"
          {...(url ? { src: url } : { srcDoc: doc })}
          title={t({ id: 'visual.sandbox.title', defaultMessage: 'Sandboxed page' })}
          onLoad={() => setLoaded(doc)}
        />
      )}
      {unserved?.doc === doc ? (
        <VisualError
          message={t({
            id: 'visual.error.failed',
            defaultMessage: 'The visual could not be drawn',
          })}
          error={unserved.message}
          onViewSpec={onViewSpec}
        />
      ) : failed?.doc === doc ? (
        <VisualError
          message={t({
            id: 'visual.sandbox.failed',
            defaultMessage: 'The page script failed, so nothing was drawn',
          })}
          error={`index.html:${failed.line} ${failed.message}`}
          onFix={onFix}
          onViewSpec={onViewSpec}
        />
      ) : (
        loaded !== doc && <Drawing />
      )}
    </div>
  );
}
