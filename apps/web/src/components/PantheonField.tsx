import { useEffect, useRef } from 'react';
import { reducedMotion } from '../lib/motion';
import {
  energy,
  quietMap,
  RAMP,
  STILL_ENERGY,
  templeDensity,
  waveStep,
  type Box,
} from '../lib/pantheon-field';
import './pantheon-field.css';

const FONT_PX = 13;
const CELL_H = 16;
const STEP_MS = 1000 / 30;
const CX = 0.5;
const DAMP = 0.94;
const LEVELS = 8;
const IDLE_MS = 500;
const MOVE = 1;
const PRESS = 4;
// Cells the sampled temple shifts per unit of wave slope, and how much a crest adds to a cell.
const BEND = 2.5;
const LIFT = 0.5;

/** A glyph temple behind the new-session page that ripples under the pointer; its parent holds the content. */
export function PantheonField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const host = canvas.parentElement!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let cellW = 8;
    let cy = CX / 4;
    let density: Float32Array = new Float32Array(0);
    let calm: Float32Array = new Float32Array(0);
    let prev: Float32Array = new Float32Array(0);
    let cur: Float32Array = new Float32Array(0);
    let level = new Uint8Array(0);
    let glyph = new Uint8Array(0);
    let color = '';
    let peak = 0;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let touched = 0;
    let gone = false;

    const readTheme = () => {
      color = getComputedStyle(canvas).getPropertyValue('--mu').trim();
      peak = document.documentElement.classList.contains('dark') ? 0.22 : 0.09;
    };
    const measure = () => {
      if (!cols) return;
      const at = canvas.getBoundingClientRect();
      const boxes: Box[] = [...host.querySelectorAll('h1, .cr-box')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left - at.left,
          top: r.top - at.top,
          right: r.right - at.left,
          bottom: r.bottom - at.top,
        };
      });
      // Under the title and the composer the temple fades to 45%: 0.22 × 0.45 in the dark theme and
      // 0.09 × 0.45 in the light one keep secondary text above 4.5:1, and the building still reads whole.
      calm = quietMap(cols, rows, cellW, CELL_H, boxes, 8, 40, 0.45);
      density = templeDensity(cols, rows);
    };
    const layout = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${FONT_PX}px ${getComputedStyle(canvas).getPropertyValue('--font-mono')}`;
      ctx.textBaseline = 'top';
      cellW = ctx.measureText('M').width;
      const fits = width >= 640 && height >= 480;
      cols = fits ? Math.floor(width / cellW) : 0;
      rows = fits ? Math.floor(height / CELL_H) : 0;
      // Waves travel as far per step down as across, measured in pixels: cy = cx / (cell height / width)².
      cy = CX / (CELL_H / cellW) ** 2;
      const n = cols * rows;
      density = templeDensity(cols, rows);
      prev = new Float32Array(n);
      cur = new Float32Array(n);
      level = new Uint8Array(n);
      glyph = new Uint8Array(n);
      measure();
    };
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      if (!cols) return;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const ox = x > 0 && x < cols - 1 ? cur[i + 1]! - cur[i - 1]! : 0;
          const oy = y > 0 && y < rows - 1 ? cur[i + cols]! - cur[i - cols]! : 0;
          const sx = x + Math.max(-3, Math.min(3, Math.round(ox * BEND)));
          const sy = y + Math.max(-2, Math.min(2, Math.round((oy * BEND) / 2)));
          const d = sx >= 0 && sx < cols && sy >= 0 && sy < rows ? density[sy * cols + sx]! : 0;
          const v = Math.min(1, 0.8 * d + LIFT * Math.max(0, cur[i]!));
          glyph[i] = Math.round(v * (RAMP.length - 1));
          level[i] = glyph[i] ? Math.round(v * calm[i]! * LEVELS) : 0;
        }
      ctx.fillStyle = color;
      for (let l = 1; l <= LEVELS; l++) {
        ctx.globalAlpha = (peak * l) / LEVELS;
        for (let i = 0; i < level.length; i++)
          if (level[i] === l)
            ctx.fillText(RAMP[glyph[i]!]!, (i % cols) * cellW, Math.floor(i / cols) * CELL_H + 2);
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      // A frame late after a pause runs at most three steps, so the water does not jump.
      acc += Math.min(100, now - last);
      last = now;
      let stepped = false;
      for (; acc >= STEP_MS; acc -= STEP_MS) {
        const next = waveStep(prev, cur, cols, rows, CX, cy, DAMP);
        prev = cur;
        cur = next;
        stepped = true;
      }
      if (energy(prev) + energy(cur) < STILL_ENERGY && now - touched > IDLE_MS) {
        prev.fill(0);
        cur.fill(0);
        draw();
        raf = 0;
        return;
      }
      if (stepped) draw();
      raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (raf || document.hidden) return;
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(tick);
    };
    const poke = (event: PointerEvent, amount: number) => {
      if (!cols || reducedMotion()) return;
      const at = canvas.getBoundingClientRect();
      const x = Math.floor((event.clientX - at.left) / cellW);
      const y = Math.floor((event.clientY - at.top) / CELL_H);
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      cur[y * cols + x]! -= amount;
      touched = performance.now();
      wake();
    };
    const onMove = (event: PointerEvent) => poke(event, MOVE);
    const onDown = (event: PointerEvent) => poke(event, PRESS);
    const onVisibility = () => {
      if (!document.hidden || !raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    readTheme();
    layout();
    draw();
    void document.fonts.ready.then(() => {
      if (gone) return;
      layout();
      draw();
    });
    const sizes = new ResizeObserver(() => {
      if (canvas.clientWidth !== width || canvas.clientHeight !== height) layout();
      else measure();
      draw();
    });
    sizes.observe(host);
    for (const el of host.querySelectorAll('h1, .cr-box')) sizes.observe(el);
    const theme = new MutationObserver(() => {
      readTheme();
      draw();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      sizes.disconnect();
      theme.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerdown', onDown);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return <canvas ref={ref} className="pf" aria-hidden="true" />;
}
