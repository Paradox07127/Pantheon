import type { Entity } from './index.js';
/** The body of each lead instruction section a playbook replaces, without its heading. */
export interface PlaybookSections {
  before_you_plan: string;
  routing: string;
  replies: string;
}
/** A project's lead behaviour for one runtime, or its default without runtime; leads use `version`. */
export interface Playbook extends Entity {
  project_id: string;
  runtime?: string;
  version: number;
  versions: Record<number, PlaybookSections>;
}
