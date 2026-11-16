import { create } from 'zustand';

/** Something from the inspector that the next message of the session carries. */
export interface FeedbackItem {
  /** The same finding, check or conflict always has the same id. */
  id: string;
  kind: 'comment' | 'finding' | 'check' | 'conflict' | 'reference';
  label: string;
  text: string;
  /** The stored diff comment the item is; sending it marks the comment sent. */
  comment?: { id: string; revision: number };
}

interface FeedbackItems {
  /** Each session's items in the order added; kept only while the window is open. */
  items: Readonly<Record<string, readonly FeedbackItem[]>>;
  /** Adds the item unless one with its id is there. */
  add: (sessionId: string, item: FeedbackItem) => void;
  remove: (sessionId: string, id: string) => void;
  /** Takes off the items a message carried. */
  clear: (sessionId: string, ids: readonly string[]) => void;
}

const NONE: readonly FeedbackItem[] = [];

export const useFeedback = create<FeedbackItems>()((set, get) => {
  const put = (sessionId: string, list: readonly FeedbackItem[]) =>
    set((s) => ({ items: { ...s.items, [sessionId]: list } }));
  const list = (sessionId: string) => get().items[sessionId] ?? NONE;
  return {
    items: {},
    add: (sessionId, item) => {
      if (!list(sessionId).some((i) => i.id === item.id))
        put(sessionId, [...list(sessionId), item]);
    },
    remove: (sessionId, id) =>
      put(
        sessionId,
        list(sessionId).filter((i) => i.id !== id),
      ),
    clear: (sessionId, ids) =>
      put(
        sessionId,
        list(sessionId).filter((i) => !ids.includes(i.id)),
      ),
  };
});

/** The message text: what the user typed, then each item's text, separated by blank lines. */
export const withFeedback = (input: string, items: readonly FeedbackItem[]): string =>
  items.length === 0
    ? input
    : [input.trimEnd(), ...items.map((i) => i.text)].filter((part) => part !== '').join('\n\n');
