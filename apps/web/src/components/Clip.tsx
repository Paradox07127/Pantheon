import { useLayoutEffect, useState } from 'react';
import { t } from '../i18n';
import { Tip } from './Tip';
import './clip.css';

interface ClipProps {
  text: string;
  /** How many lines show before the text is cut. */
  lines?: number;
  className?: string;
  as?: 'span' | 'div';
}

/** Text cut to its lines, with the rest in a tooltip (one line) or behind a show-more button. */
export function Clip({ text, lines = 1, className, as: Tag = 'span' }: ClipProps) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const one = lines === 1;

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

  const base = one ? 'clip-1' : 'clip-n';
  const body = (
    <Tag
      ref={setEl}
      className={className ? `${base} ${className}` : base}
      data-clip={cut ? 'cut' : ''}
      tabIndex={one && cut ? 0 : undefined}
      style={one || open ? undefined : { WebkitLineClamp: lines, lineClamp: lines }}
    >
      {text}
    </Tag>
  );
  if (one) return cut ? <Tip content={text}>{body}</Tip> : body;
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
