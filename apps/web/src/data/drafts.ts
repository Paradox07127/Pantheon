import { create } from 'zustand';
import type { AttachmentMeta, EffortLevel, WorkbenchSession } from '@pantheon/protocol';
import type { FeedbackItem } from './feedback';

/** A file a message carries; a rewritten turn's files come without their size. */
export type DraftAttachment = Pick<AttachmentMeta, 'id' | 'name' | 'mime'> & {
  /** The line count of text pasted as a file. */
  lines?: number;
};

/** A skill a Codex turn loads by path. */
export interface SkillRef {
  name: string;
  path: string;
}

/** A pull request or issue a message refers to, as listed when picked. */
export interface GithubRef {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  checks?: 'passing' | 'failing' | 'pending';
}

export const githubRefKey = (ref: Pick<GithubRef, 'kind' | 'number'>) =>
  `${ref.kind}:${ref.number}`;

/** A message as a composer holds it. */
export interface DraftMessage {
  text: string;
  attachments: readonly DraftAttachment[];
  skills: readonly SkillRef[];
  /** Sessions the message refers to, as listed when picked; absent is none. */
  refs?: readonly WorkbenchSession[];
  /** Pull requests and issues the message refers to; absent is none. */
  github?: readonly GithubRef[];
  /** Stored diff comments the message carries, marked sent when it is sent; absent is none. */
  comments?: readonly { id: string; revision: number }[];
}

/** Where a new session edits: a worktree of its own or the project's checkout. */
export type DraftWorkspace = 'worktree' | 'in_place';

/** The branch or session a new session's worktree starts from. */
export type DraftStart = { branch: string } | { session_id: string };

/** The runtime, backend, model and effort the new-session composer chose. */
export interface DraftModel {
  runtime: string;
  backend: string | null;
  model: string | null;
  effort: EffortLevel | null;
}

/** A composer's unsent message and the number of files still uploading into it. */
export interface Draft extends DraftMessage {
  refs: readonly WorkbenchSession[];
  github: readonly GithubRef[];
  /** The files and code symbols a session's message refers to, as chips on its box; absent is none. */
  mentions?: readonly FeedbackItem[];
  uploading: number;
  /** The new-session composer's chosen workspace; absent is the project folder while no session writes there. */
  workspace?: DraftWorkspace;
  /** The new-session composer's chosen start point; absent is the project's checkout. */
  from?: DraftStart;
  /** The new-session composer's chosen model; absent is the project's default. */
  model?: DraftModel;
  /** The new-session composer's chosen permission mode; absent is the default. */
  mode?: WorkbenchSession['permission_mode'];
  /** Whether the new-session composer turned fast mode on. */
  fast?: boolean;
  /** Whether the new-session composer turned ultracode on. */
  ultracode?: boolean;
}

/** A question card's picked options and typed answer, one entry per question. */
export interface Answers {
  picked: readonly (readonly string[])[];
  typed: readonly string[];
  /** Questions left to the model; absent is none. */
  decided?: readonly boolean[];
}

export const EMPTY_DRAFT: Draft = {
  text: '',
  attachments: [],
  skills: [],
  refs: [],
  github: [],
  uploading: 0,
};

/**
 * The draft of a session's composer; with a null session, of the project's new-session composer,
 * one per task it is bound to.
 */
export const draftKey = (projectId: string, sessionId: string | null, taskId?: string): string =>
  JSON.stringify([projectId, sessionId ?? 'new', taskId ?? null]);

// Each draft is stored under this prefix and its draftKey, so it outlives the window and every
// window shows it.
const STORED = 'pantheon.draft.';

const isStart = (from: unknown): from is DraftStart =>
  typeof (from as { branch?: unknown } | null)?.branch === 'string' ||
  typeof (from as { session_id?: unknown } | null)?.session_id === 'string';

const isModel = (model: unknown): model is DraftModel =>
  typeof (model as { runtime?: unknown } | null)?.runtime === 'string';

function readDraft(raw: string | null): Draft | null {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<Draft> | null;
    if (
      typeof value?.text !== 'string' ||
      !Array.isArray(value.attachments) ||
      !Array.isArray(value.skills)
    )
      return null;
    return {
      text: value.text,
      attachments: value.attachments,
      skills: value.skills,
      refs: Array.isArray(value.refs) ? value.refs : [],
      github: Array.isArray(value.github) ? value.github : [],
      ...(Array.isArray(value.comments) ? { comments: value.comments } : {}),
      ...(Array.isArray(value.mentions) ? { mentions: value.mentions } : {}),
      uploading: 0,
      ...(value.workspace === 'worktree' || value.workspace === 'in_place'
        ? { workspace: value.workspace }
        : {}),
      ...(isStart(value.from) ? { from: value.from } : {}),
      ...(isModel(value.model) ? { model: value.model } : {}),
      ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
      ...(value.fast === true ? { fast: true } : {}),
      ...(value.ultracode === true ? { ultracode: true } : {}),
    };
  } catch {
    return null;
  }
}

function loadDrafts(): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const draft = key?.startsWith(STORED) ? readDraft(localStorage.getItem(key)) : null;
      if (draft) drafts[key!.slice(STORED.length)] = draft;
    }
  } catch {
    // Unreadable storage starts with no drafts.
  }
  return drafts;
}

function storeDraft(key: string, draft: Draft | undefined) {
  try {
    if (
      draft &&
      (draft.text ||
        draft.attachments.length ||
        draft.skills.length ||
        draft.refs.length ||
        draft.github.length ||
        draft.mentions?.length ||
        draft.workspace ||
        draft.from ||
        draft.model ||
        draft.mode ||
        draft.fast ||
        draft.ultracode)
    )
      localStorage.setItem(
        STORED + key,
        JSON.stringify({
          text: draft.text,
          attachments: draft.attachments,
          skills: draft.skills,
          refs: draft.refs,
          github: draft.github,
          comments: draft.comments,
          mentions: draft.mentions,
          workspace: draft.workspace,
          from: draft.from,
          model: draft.model,
          mode: draft.mode,
          fast: draft.fast,
          ultracode: draft.ultracode,
        }),
      );
    else localStorage.removeItem(STORED + key);
  } catch {
    // The draft still holds in this window.
  }
}

interface Drafts {
  /** Each composer's draft by draftKey, as stored. */
  drafts: Readonly<Record<string, Draft>>;
  /** Each question card's answers by approval id. */
  answers: Readonly<Record<string, Answers>>;
  /** Changes the draft; an absent one starts empty. */
  update: (key: string, change: (draft: Draft) => Partial<Draft>) => void;
  /** Starts the draft with the text unless there is one. */
  start: (key: string, text: string) => void;
  /** Appends the message's text and joins its attachments; its skill replaces a picked one of the same name. */
  put: (key: string, message: DraftMessage) => void;
  /** Takes off what a sent message carried and keeps later changes; forgets a draft left empty. */
  sent: (
    key: string,
    message: {
      text: string;
      attachments: readonly string[];
      skills: readonly string[];
      refs?: readonly string[];
      /** Keys of the pull requests and issues, by githubRefKey. */
      github?: readonly string[];
      /** Ids of the stored comments. */
      comments?: readonly string[];
      /** Ids of the file and symbol references. */
      mentions?: readonly string[];
      workspace?: DraftWorkspace;
      from?: DraftStart;
      model?: DraftModel;
      mode?: WorkbenchSession['permission_mode'];
      fast?: boolean;
      ultracode?: boolean;
    },
  ) => void;
  answer: (approvalId: string, answers: Answers) => void;
}

export const useDrafts = create<Drafts>()((set, get) => {
  const update: Drafts['update'] = (key, change) => {
    set((s) => {
      const draft = s.drafts[key] ?? EMPTY_DRAFT;
      return { drafts: { ...s.drafts, [key]: { ...draft, ...change(draft) } } };
    });
    storeDraft(key, get().drafts[key]);
  };
  return {
    drafts: loadDrafts(),
    answers: {},
    update,
    start: (key, text) => {
      if (!get().drafts[key]) update(key, () => ({ text }));
    },
    put: (key, message) =>
      update(key, (draft) => ({
        text:
          draft.text.trim() === '' ? message.text : `${draft.text.trimEnd()}\n\n${message.text}`,
        attachments: [
          ...draft.attachments,
          ...message.attachments.filter((a) => !draft.attachments.some((b) => b.id === a.id)),
        ],
        skills: [
          ...draft.skills.filter((s) => !message.skills.some((b) => b.name === s.name)),
          ...message.skills,
        ],
        refs: [
          ...draft.refs,
          ...(message.refs ?? []).filter((r) => !draft.refs.some((b) => b.id === r.id)),
        ],
        github: [
          ...draft.github,
          ...(message.github ?? []).filter(
            (r) => !draft.github.some((b) => githubRefKey(b) === githubRefKey(r)),
          ),
        ],
        ...(draft.comments || message.comments
          ? {
              comments: [
                ...(draft.comments ?? []),
                ...(message.comments ?? []).filter(
                  (c) => !draft.comments?.some((b) => b.id === c.id),
                ),
              ],
            }
          : {}),
      })),
    sent: (key, message) => {
      set((s) => {
        const { [key]: draft = EMPTY_DRAFT, ...rest } = s.drafts;
        const left: Draft = {
          text: draft.text === message.text ? '' : draft.text,
          attachments: draft.attachments.filter((a) => !message.attachments.includes(a.id)),
          skills: draft.skills.filter((skill) => !message.skills.includes(skill.name)),
          refs: draft.refs.filter((r) => !message.refs?.includes(r.id)),
          github: draft.github.filter((r) => !message.github?.includes(githubRefKey(r))),
          uploading: draft.uploading,
          ...(draft.comments
            ? { comments: draft.comments.filter((c) => !message.comments?.includes(c.id)) }
            : {}),
          ...(draft.mentions
            ? { mentions: draft.mentions.filter((m) => !message.mentions?.includes(m.id)) }
            : {}),
          ...(draft.workspace && draft.workspace !== message.workspace
            ? { workspace: draft.workspace }
            : {}),
          ...(draft.from && JSON.stringify(draft.from) !== JSON.stringify(message.from)
            ? { from: draft.from }
            : {}),
          ...(draft.model && JSON.stringify(draft.model) !== JSON.stringify(message.model)
            ? { model: draft.model }
            : {}),
          ...(draft.mode && draft.mode !== message.mode ? { mode: draft.mode } : {}),
          ...(draft.fast && !message.fast ? { fast: true } : {}),
          ...(draft.ultracode && !message.ultracode ? { ultracode: true } : {}),
        };
        // Comments alone keep no draft: they belong to the text they came with.
        const kept =
          left.text ||
          left.attachments.length ||
          left.skills.length ||
          left.refs.length ||
          left.github.length ||
          left.mentions?.length ||
          left.uploading ||
          left.workspace ||
          left.from ||
          left.model ||
          left.mode ||
          left.fast ||
          left.ultracode;
        return { drafts: kept ? { ...rest, [key]: left } : rest };
      });
      storeDraft(key, get().drafts[key]);
    },
    answer: (approvalId, answers) =>
      set((s) => ({ answers: { ...s.answers, [approvalId]: answers } })),
  };
});

// Another window stored a draft: this one shows it, keeping its own uploads into it, also when
// the other window sent or cleared it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(STORED)) return;
    const key = e.key.slice(STORED.length);
    const draft = readDraft(e.newValue);
    useDrafts.setState((s) => {
      const { [key]: was, ...rest } = s.drafts;
      const uploading = was?.uploading ?? 0;
      if (!draft && !uploading) return { drafts: rest };
      return { drafts: { ...rest, [key]: { ...(draft ?? EMPTY_DRAFT), uploading } } };
    });
  });

/** Resolves once no file is uploading into the draft. */
export const whenUploaded = (key: string): Promise<void> =>
  new Promise((resolve) => {
    const done = () => !useDrafts.getState().drafts[key]?.uploading;
    if (done()) return resolve();
    const stop = useDrafts.subscribe(() => {
      if (!done()) return;
      stop();
      resolve();
    });
  });
