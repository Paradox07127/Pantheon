# Pantheon web UI rules

Read this before changing `apps/web/src`. Tokens live in `src/index.css`: the shared scale `:root`, the light `:root` and `.dark`. Hex colours appear only in the two theme blocks.

## Surfaces and lines

- No shadows of any kind (`box-shadow`, `drop-shadow`). Depth comes from the surface ladder `--bg` < `--sf` < `--sf2` < `--ov` (popovers, with `backdrop-filter: blur(var(--blur-md))`).
- The window is `--bg`. The sidebar sits on it with no line between it and the content; the window's title bar (`--titlebar`, 52px) runs across the top on `--bg` with no line under it; the content is one `--sf` surface with a `--bd` hairline edge and `--r-xl` corners, under the title bar and 8px in from the window's right and bottom and from the folded sidebar. The whole title bar drags the window (`.app-drag`).
- New borders are `var(--hair)` (0.5px) solid; older 1px borders move to it when their region is rebuilt. Colours are the semi-transparent `--bd` (outer), `--bd2` (inner dividers) and `--bd3` (an edge under the pointer or around focused input); popovers use `--bd-ov`.
- A visual drawn in a conversation (`VisualCard inline`) is the same `--r-md` card as a pinned visual on the board: a `--bd` hairline edge on `--sf`, and a header with its kind icon and title; `.vis[data-inline]` has no rule of its own. In the conversation its plot is `role=group` with an `aria-label` that gives its data counts.
- The terminal (`src/screens/sessions/TerminalPanel.tsx`) is a row under the conversation and the panels, across both, with a hairline top edge and a splitter; xterm draws on `--term` / `--term-tx`, dark in both themes. It shows only in the desktop app (`window.pantheon`), and so does the browser panel.
- Another width is allowed only for focus indication, the selected-tab indicator, progress or meter bars, dashed flow-chart edges, status-glyph strokes and the 1px dashed border of a queued (not yet sent) turn.
- No coloured bar on the left edge of a card or row. Navigation items (the sidebar, the collapsed icon rail, the settings navigation) fill with `--st-hov` on hover, `--st-on` while pressed and `--sel` when selected, and draw no border on hover. A selected row in the content area uses `background: var(--sel)`.

## Colour

- The accent is the ink role. The primary button is `--ink` with `--on-ink` text, a switch that is on fills with `--ink`, and the focus ring is `--focus-ring`. A theme and the user's accent choice (Settings → Appearance) set these tokens; the default is the ink. New styles take the accent only from these tokens and do not use `--ac`, `--ac2` or `--ac-bg`.
- Status colours (`--run`, `--wait`, `--ok`, `--bad`, `--ready`, `--idle`, `--unk`, `--chk`, `--chg`, `--e-*`) paint graphics only: status icons and glyphs, dots, bars, rings, chart series. A word or number that names or counts a status uses `--tx2` (or the neutral colour it already had).
- A chip that holds only status text gets a 6px status-coloured `::before` dot; its background is `--sf2`.
- Identity colours mark which runtime or which project: a runtime's `--rt-<id>` tone on runtime chart series and its one-colour mark, `--mu` for a runtime without a tone, and `projectColor` (`src/components/Sidebar.tsx`) on the project monogram, darkened 20% towards `--tx` under its `--bg` letter, each 16px or smaller. They never stand for a status, and never colour text, rows or surfaces outside the graphic or chart mark.
- A runtime's name, glyph, colour and order come only from the table in `src/components/RuntimeGlyph.tsx`; every runtime it lists has its name and place there. A runtime with a vendor mark is drawn with that mark from `src/components/BrandMark.tsx` and has its own `--rt-<id>` tone in the vendor's colours, light and dark, in `src/index.css`. A runtime without a mark, listed or not, gets the generic glyph and `--mu`. The same file maps a model id to its maker's mark (`ModelMark`): put it before a model name that stands alone (model picker, model list, usage by model); beside a runtime glyph, as in a task route or a routing cell, only when the model's maker differs from the runtime's own (agy running a Claude model); no mark for a maker the table does not know.
- Colour stays on content and danger: non-zero diff counts and lines, syntax highlighting, error messages, destructive buttons. Zero diff counts (`data-zero`) use `--mu`.
- A gate step that failed but may be skipped is `skipped`: a minus glyph in a neutral colour (`--idle` or `--mu`), never the passed or failed colour. It has its own group after passed in `GateResults` (`src/screens/sessions/GateResults.tsx`: failed, passed, skipped, not run), carries the reason it ended, and takes its own segment in check count bars; it never counts as passed.

## Corners

- Levels: `--r-sm` 7px controls and rows, 5px (`--r-sm` − 2px) chips, small buttons and key caps, `--r-md` 10px cards, `--r-lg` 10px panels, menus and popovers, `--r-xl` 14px the content surface and dialogs. One element keeps one radius everywhere; no container-scoped radius overrides.
- Tight nesting (inset 8px or less): inner radius = `max(calc(var(--r-outer) - <inset>), 4px)`. With a larger inset the inner element keeps its own level.
- Everything under `.pt` gets `corner-shape: superellipse(1.25)` inside `@supports`; pills and circles get `corner-shape: round`.

## Type

- Interface text is Geist (`--font-sans`); code is Geist Mono (`--font-mono`). Both are bundled.
- Sizes and line heights: `--fs-xs` 12/16, `--fs-sm` 13/20, `--fs-md` 14/22, and `--fs-lg` and `--fs-xl` both 20/28 for titles and key numbers. Nothing below 12px.
- Code, paths, SHAs and ids use `var(--font-mono)`. Numbers that change in place or sit in columns use `font-variant-numeric: tabular-nums`.
- `.pt` has `text-autospace: normal`; headings and empty states use `text-wrap: balance`; `.md p` uses `text-wrap: pretty`.

## Text and layout

- Buttons, inputs and icon buttons are 28px high (`--h-ctl`, `--h-btn`, `--ctl`), rows 30px (`--row`), the window's title bar 52px (`--titlebar`), bars inside the content 44px (`--bar`).
- No middle dot "·" as a separator. Join short facts with `listText` (`src/lib/list-text.ts`), or lay them out as siblings in a flex container with a gap.
- No secondary labels or helper text in new UI; show relations with grouping, order and alignment.
- A session's title appears once, in the session bar. The inspector repeats it only when it is a sheet over that bar.
- Controls keep the arrow cursor: no `cursor: pointer` on buttons, tabs, rows, menu items or chips. Only a link in content gets the hand (`.md a` by default, `.md .md-path`).
- While its data loads, a region keeps the layout it will have, so nothing below it moves when the read lands: either `Skeleton` blocks (`src/components/Skeleton.tsx`) in the shape of the content, which show only once loading lasts 300ms, or the real controls standing empty and disabled under `aria-busy` until their values fill in place (the task drawer's contract rows in `src/screens/board/PlanEdit.tsx`).
- A choice that only applies under another sits after it in the same row and shows only while it applies: the gates page's handback count follows "Hand back to fix" (`GatePolicy` in `src/screens/settings/GatesPage.tsx`).
- Parts of one task (a parallel task's parts) reuse the task's status glyphs and the drawer's link rows, in plan order; a part with a session opens it, one without is a plain row. A glyph that stands alone is `role=img` with the name and status in its `aria-label`.
- Images and links do not drag out of the window (`-webkit-user-drag: none`); an element the user drags sets `draggable`.
- Interface text is not selectable (`.pt` has `user-select: none`). What the user copies gets `user-select: text`: the session thread, markdown, `pre` and `code`, the trace detail, request card bodies, the task drawer, retrospective and history content, banner and toast messages, paths and ids in settings and experience entries, and `input`, `textarea` and `[contenteditable]`. Buttons and tabs inside them stay unselectable.
- Text in a box of limited width takes one of three treatments. Wrap is the default: `overflow-wrap: anywhere`, and every flex or grid child on the way gets `min-width: 0`.
- Cut to one line only where the row height is fixed (sidebar rows, table cells, tabs, chips) and only through `Clip` (`src/components/Clip.tsx`), which shows the full text in a tooltip on hover and keyboard focus when the text is really cut.
- Cut to N lines only through `Clip` with `lines={N}`, which adds a show-more button when the text is really cut.
- Nothing is drawn outside its card or pane; `node tests/acceptance/verify/run.mjs --boot layout.overflow-scan` reports what is.

## Page frame

- Every page except the session page renders `<TopBar title count?>` (`src/components/TopBar.tsx`) first, inside a `.tb-pg` wrapper; the bar sits in the window's title bar from the content's left edge (`--main-x`) to the global controls: the page name as `h1`, then the page's tabs (`.tb-tabs` > `.tb-tab`), then its controls in `.tb-end`. A range or view switch in the bar is `.tb-seg`. No breadcrumb, no second header row, no page title in the body.
- The board's views are a `.tb-seg` in its own `TopBar`; there is no second row under it.
- A bar button whose text sits in `.tb-lbl` shows only its icon while the bar is narrower than 1180px (`@container tb` in `src/index.css`); it keeps its name in `aria-label` and `title`. The bar's `h1` never wraps.
- The session page's bar is `SessionHeader` (`src/screens/sessions/SessionHeader.tsx`): state, the last turn's mark, lead session, title (`h1`), branch, diff size, checks, a toggle for each of the seven panels in a fixed order (changes, checks, plan, files, browser, trace, monitor), the same for every session, a panel the session lacks dimmed with the reason in its tooltip, and, in the desktop app, the terminal toggle, then the overview toggle and the more menu; the main agent's plan is a 2px strip along the content's top edge. With one session it sits in the window's title bar like a `TopBar`; two sessions side by side keep their own heads (`SplitHead`) in their columns.
- A settings page gets its header from `CategoryHeader`; a group of settings is a `Section` and each setting a `Row` (`src/screens/settings/ProjectSettingsScreen.tsx`). No heading inside the page body. The Devices page body is its own device list (`ul.dv-grp` in `src/screens/settings/DevicesPage.tsx`), not `Section`/`Row`.
- The title bar's right end is `TitleBarEnd` (`src/components/TitleBarEnd.tsx`) on every page: the count of what waits for the user, which opens `NeedsPopover`. No window has a search field; search is the magnifier button after the sidebar toggle in `WindowControls` (`src/components/WindowControls.tsx`), which opens the palette.
- On the all projects screen the sidebar shows the project list (`ProjectList` in `src/components/Sidebar.tsx`) and no page navigation or sessions.

## Interface text

- Every string the UI shows, `aria-label`s included, comes from `t({ id, defaultMessage })` in `src/i18n`, a plain function; no React component or context fetches text.
- IDs are `<area>.<component or feature>.<purpose>`, such as `settings.appearance.language`. One ID has one `defaultMessage`.
- The English text is the `defaultMessage` at the call site; English has no catalog. The Simplified Chinese text goes into `src/i18n/locales/zh-CN/<area>.json`.
- Counts use ICU plurals, `{count, plural, one {# file} other {# files}}`, and values go in as `{name}` arguments. Never join sentence fragments.
- A constant built at module load reads its text through a getter, so the loaded language applies.
- Prompts sent to models stay in one language whatever the interface language is.
- Guard: `tests/web/i18n-catalog.test.ts`.

## Shortcuts

- Default keys only for frequent actions and these keys: navigation, new and send, the palette, switching sessions (⌘1 to ⌘9), list keys, interrupting the turn (⌘.), the model menu (⇧⌘M), the overview (⌘I), attaching files (⌘U) and the shortcut sheet (?). Every other action has `keys: ''` and is reached from a menu or the command palette; the user can record keys for it.
- A new feature gets default keys only once the action exists; its entry joins the registry and the guard together.
- Key hints stay hidden until ⌘ (Ctrl off macOS) has been held for 400ms (`src/lib/held-keys.ts` sets `data-cmd` on the body). Put `<KeyHint id="…" />` (`src/components/Shortcuts.tsx`) inside the control; it writes the entry's current keys. The one exception is the search button in `WindowControls`, which always shows the palette's keys.
- Guard: `tests/web/shortcut-defaults.test.ts`.

## Motion

- Durations `--dur-1`..`--dur-4` (120/180/260/420ms). Curves: `--ease-std` default, `--ease-in` for entering (decelerate), `--ease-out` for exiting (accelerate). Exits are one step shorter than entries.
- Animate `transform`, `opacity` and colours only, plus `grid-template-rows` on `-grow` wrappers (rows growing in) and `filter: blur()` of at most 4px on entering `-in` elements; no `transition: all`. Enter and exit through Base UI `data-starting-style` / `data-ending-style` or `@starting-style`. No JS animation library.
- A one-shot entrance is a transition, not a keyframe animation: `.app-main[data-switching]` switches transitions off for the frame in which a kept screen shows again, and a keyframe animation would replay there.
- Infinite loops only on decorative elements that hold no control. `prefers-reduced-motion` keeps fades and colour changes and stops movement.
- Guards: `tests/web/web-motion-css.test.ts`, `tests/web/web-shell-tokens.test.ts`, `tests/web/web-css-classes.test.ts`, `tests/web/web-interaction-states.test.ts`.

## Review

- Check changes in Chrome DevTools at 1440×900 and 1280×800, light and dark.
