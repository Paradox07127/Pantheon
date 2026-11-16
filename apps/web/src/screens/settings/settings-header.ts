import type { ComponentType } from 'react';
import type { SettingsPage } from './view';

export interface PageHeader {
  /** The page's own controls at the header's end, before the close. */
  tools?: ComponentType;
}

const HEADERS = new Map<SettingsPage, PageHeader>();

/** Sets what the page adds to its header; each page registers from its own file. */
export function registerPageHeader(page: SettingsPage, header: PageHeader) {
  HEADERS.set(page, header);
}

/** What the page added to its header; nothing for a page that registered none. */
export const pageHeader = (page: SettingsPage): PageHeader => HEADERS.get(page) ?? {};
