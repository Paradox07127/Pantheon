import type { Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** How replies' Markdown is parsed, shared by the renderer and the thread's find. */
export const remarkPlugins: NonNullable<Options['remarkPlugins']> = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  [remarkMath, { singleDollarTextMath: false }],
];
/** The rehype steps that change the drawn text; highlighting, which only splits it, is left out. */
export const rehypePlugins: NonNullable<Options['rehypePlugins']> = [
  [rehypeKatex, { strict: false }],
];
