// Finds text drawn outside its box, and cut text whose full content the user cannot reach.
//   const findings = await scanOverflow(page, { within: '.app-main' });
// A finding is { kind: 'escape' | 'hidden', region, selector, text, by }; `by` is in px.

/** Runs in the page, so it uses nothing from this module. */
function scan(within) {
  const root = within ? document.querySelector(within) : document.body;
  if (!root) return [];
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const clear = (colour) => /^transparent$|,\s*0\)$|\/\s*0\)$/.test(colour);
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const draws = (cs) =>
    cs.display !== 'contents' &&
    (!clear(cs.backgroundColor) ||
      cs.overflowX !== 'visible' ||
      cs.overflowY !== 'visible' ||
      sides.some(
        (s) =>
          parseFloat(cs[`border${s}Width`]) > 0 &&
          !['none', 'hidden'].includes(cs[`border${s}Style`]) &&
          !clear(cs[`border${s}Color`]),
      ));
  const viewport = {
    rect: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
    x: true,
    y: true,
  };
  // The box an element's text must stay in; an axis the box clips cannot be escaped.
  const boxOf = (el) => {
    const cs = getComputedStyle(el);
    return {
      rect: el.getBoundingClientRect(),
      x: cs.overflowX === 'visible',
      y: cs.overflowY === 'visible',
    };
  };
  const boxAbove = (el) => {
    for (let up = el.parentElement; up; up = up.parentElement)
      if (draws(getComputedStyle(up))) return boxOf(up);
    return viewport;
  };
  const past = (a, box) =>
    Math.max(
      box.x ? box.rect.left - a.left : 0,
      box.x ? a.right - box.rect.right : 0,
      box.y ? box.rect.top - a.top : 0,
      box.y ? a.bottom - box.rect.bottom : 0,
    );
  const skipped = (el) => {
    if (
      el.closest(
        '.dbv, [aria-hidden="true"], input, textarea, select, script, style, noscript, template',
      )
    )
      return true;
    for (
      let block = el.closest('pre, code');
      block;
      block = block.parentElement?.closest('pre, code')
    ) {
      const cs = getComputedStyle(block);
      if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) return true;
    }
    return false;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return (
      // A 1px box holds text only for screen readers (.bd-vh, .ss-vh).
      rect.width > 1 &&
      rect.height > 1 &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    );
  };
  // The extent of the element's own text nodes, which may lie outside the element's own rect.
  const ownText = (el) => {
    let rect = null;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!r.width && !r.height) continue;
        rect = rect
          ? {
              left: Math.min(rect.left, r.left),
              top: Math.min(rect.top, r.top),
              right: Math.max(rect.right, r.right),
              bottom: Math.max(rect.bottom, r.bottom),
            }
          : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    return rect;
  };
  const interactive =
    'a[href], button, summary, [role=button], [role=link], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=treeitem], [role=row], [role=gridcell], [tabindex]:not([tabindex="-1"])';
  const reachable = (el, text) => {
    const holds = (value) => value !== null && clean(value).includes(text);
    for (let up = el, i = 0; up && i <= 2; up = up.parentElement, i++)
      if (holds(up.getAttribute('title')) || up.hasAttribute('data-clip')) return true;
    return (
      holds(el.getAttribute('aria-label')) ||
      holds(el.closest(interactive)?.getAttribute('aria-label') ?? null)
    );
  };
  const cutBy = (el, cs) => {
    const wide = el.scrollWidth - el.clientWidth;
    const tall = el.scrollHeight - el.clientHeight;
    if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && wide > 1) return wide;
    if (cs.getPropertyValue('-webkit-line-clamp') !== 'none' && tall > 1) return tall;
    if (['hidden', 'clip'].includes(cs.overflowX) && cs.whiteSpace === 'nowrap' && wide > 1)
      return wide;
    return 0;
  };
  // Text an ancestor cuts off with `overflow: hidden | clip`; scrolling boxes and pannable canvases show it.
  // Only boxes on the containing-block chain clip: an absolute box skips static ancestors up to
  // its positioned one, a fixed box skips all up to one with a transform, filter or contain.
  const holds = (cs, wait) =>
    wait === 'absolute'
      ? cs.position !== 'static'
      : wait === 'fixed'
        ? cs.transform !== 'none' ||
          cs.filter !== 'none' ||
          /paint|layout|strict|content/.test(cs.contain)
        : true;
  const cutAbove = (el, own) => {
    let most = 0;
    let wait = ['absolute', 'fixed'].find((p) => p === getComputedStyle(el).position) ?? null;
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (up.matches('.react-flow')) return 0;
      const cs = getComputedStyle(up);
      if (holds(cs, wait)) {
        wait = null;
        if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) return most;
        const x = /hidden|clip/.test(cs.overflowX);
        const y = /hidden|clip/.test(cs.overflowY);
        if (x || y) most = Math.max(most, past(own, { rect: up.getBoundingClientRect(), x, y }));
      }
      // A positioned ancestor starts its own chain for the boxes above it.
      if (wait === null && ['absolute', 'fixed'].includes(cs.position)) wait = cs.position;
    }
    return most;
  };
  const selectorOf = (el) => {
    const anchor = el.closest('[id], [data-debug-region], [aria-label]');
    const steps = [];
    for (let at = el; at && at !== anchor && at !== document.body; at = at.parentElement) {
      const tag = at.tagName.toLowerCase();
      const n =
        [...(at.parentElement?.children ?? [])]
          .filter((c) => c.tagName === at.tagName)
          .indexOf(at) + 1;
      steps.unshift(`${tag}:nth-of-type(${n})`);
    }
    const head = !anchor
      ? 'body'
      : anchor.id
        ? `#${CSS.escape(anchor.id)}`
        : anchor.hasAttribute('data-debug-region')
          ? `[data-debug-region="${anchor.getAttribute('data-debug-region')}"]`
          : `${anchor.tagName.toLowerCase()}[aria-label="${anchor.getAttribute('aria-label').slice(0, 40)}"]`;
    return [head, ...steps].join(' > ');
  };

  const found = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (skipped(el) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const text = clean(el.textContent);
    if (!text) continue;
    const own = ownText(el);
    if (own) {
      // An element that draws a box holds its own text, and must itself stay in the box above.
      const by = draws(cs)
        ? Math.max(past(own, boxOf(el)), past(el.getBoundingClientRect(), boxAbove(el)))
        : past(own, boxAbove(el));
      if (by > 1) found.push({ el, kind: 'escape', by });
    }
    const cut = Math.max(cutBy(el, cs), own ? cutAbove(el, own) : 0);
    if (cut > 1 && !reachable(el, text)) found.push({ el, kind: 'hidden', by: cut });
  }
  // A parent and its child both found for the same kind: the child is where the fault is.
  return found
    .filter((f) => !found.some((g) => g !== f && g.kind === f.kind && f.el.contains(g.el)))
    .map(({ el, kind, by }) => ({
      kind,
      region: el.closest('[data-debug-region]')?.getAttribute('data-debug-region') ?? null,
      selector: selectorOf(el),
      text: clean(el.textContent).slice(0, 80),
      by: Math.round(by),
    }));
}

/** `within` is a CSS selector that limits the scan to the first element it selects. */
export async function scanOverflow(page, { within } = {}) {
  return page.evaluate(`(${scan})(${JSON.stringify(within ?? null)})`);
}
