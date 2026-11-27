import { Minus, Plus } from 'lucide-react';
import { t } from '../../i18n';
import { stepZoom, ZOOM_MAX, ZOOM_MIN } from './graph-focus';
import './memory-graph-interact.css';

export interface GraphZoomProps {
  zoom: number;
  onZoom(zoom: number): void;
  onFit(): void;
}

/** Zoom out, the zoom in percent, zoom in, and fit the drawing to the window. */
export function GraphZoom({ zoom, onZoom, onFit }: GraphZoomProps) {
  return (
    <div
      className="pop mgi-zoom"
      role="group"
      aria-label={t({ id: 'memory.graphInteract.zoom', defaultMessage: 'Zoom' })}
    >
      <button
        type="button"
        className="ib mgi-zb"
        aria-label={t({ id: 'memory.graphInteract.zoomOut', defaultMessage: 'Zoom out' })}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onZoom(stepZoom(zoom, -1))}
      >
        <Minus aria-hidden="true" />
      </button>
      <span className="mgi-pct">{`${Math.round(zoom * 100)}%`}</span>
      <button
        type="button"
        className="ib mgi-zb"
        aria-label={t({ id: 'memory.graphInteract.zoomIn', defaultMessage: 'Zoom in' })}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onZoom(stepZoom(zoom, 1))}
      >
        <Plus aria-hidden="true" />
      </button>
      <span className="mgi-sep" aria-hidden="true" />
      <button type="button" className="btn ghost sm" onClick={onFit}>
        {t({ id: 'memory.graphInteract.fit', defaultMessage: 'Fit to window' })}
      </button>
    </div>
  );
}
