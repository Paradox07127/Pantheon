import { useEffect, useLayoutEffect, useState } from 'react';
import { t } from '../i18n';
import { Tip } from './Tip';
import './clip.css';

// A control the clipped text sits in; it takes the focus, so the text itself is not a tab stop.
const CONTROL =
  'button, a[href], summary, [role=button], [role=link], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [tabindex]:not([tabindex="-1"])';

interface ClipProps {
  text: string;
  /** How many lines show before the text is cut. */
  lines?: number;
  className?: string;
  as?: 'span' | 'div';
  /** The text's own id, for a control it describes. */
  id?: string;
}

/** Text cut to its lines, with the rest in a tooltip (one line) or behind a show-more button. */
export function Clip({ text, lines = 1, className, as: Tag = 'span', id }: ClipProps) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const one = lines === 1;
  const control = (el?.parentElement?.closest(CONTROL) as HTMLElement | null | undefined) ?? null;

  useLayoutEffect(() => {
    // Unfolded text is not cut; the button stays so the user can fold it again.
    if (!el || open) return;
    const measure = () =>
      setCut(one ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, open, one, text, lines]);

  // Inside a control, the control's keyboard focus shows the tooltip.
  useEffect(() => {
    if (!control || !one || !cut) return;
    const show = () => setTip(control.matches(':focus-visible'));
    const hide = () => setTip(false);
    control.addEventListener('focus', show);
    control.addEventListener('blur', hide);
    return () => {
      control.removeEventListener('focus', show);
      control.removeEventListener('blur', hide);
    };
  }, [control, one, cut]);

  const base = one ? 'clip-1' : 'clip-n';
  const body = (
    <Tag
      ref={setEl}
      id={id}
      className={className ? `${base} ${className}` : base}
      data-clip={cut ? 'cut' : ''}
      tabIndex={one && cut && !control ? 0 : undefined}
      style={one || open ? undefined : { WebkitLineClamp: lines, lineClamp: lines }}
    >
      {text}
    </Tag>
  );
  if (one)
    return cut ? (
      <Tip content={text} open={tip} onOpenChange={setTip}>
        {body}
      </Tip>
    ) : (
      body
    );
  return (
    <>
      {body}
      {cut && (
        <button
          type="button"
          className="btn sm ghost clip-more"
          aria-expanded={open}
          onClick={() => setOpen((now) => !now)}
        >
          {open
            ? t({ id: 'components.clip.less', defaultMessage: 'Show less' })
            : t({ id: 'components.clip.more', defaultMessage: 'Show more' })}
        </button>
      )}
    </>
  );
}
