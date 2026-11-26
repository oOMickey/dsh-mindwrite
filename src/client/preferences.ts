import { printLayout } from '../style-tokens.ts';
import type { ArticleTitle, Numbering } from '../format.ts';
import type { StoragePort } from './drafts.ts';

export interface DocumentPreferences {
  layout?: 'official' | 'standard';
  scheme: Numbering;
  articleTitle: ArticleTitle;
  fontSize: 14 | 16;
  arabic: boolean;
}
export const defaultPreferences: DocumentPreferences = {
  scheme: 'official',
  articleTitle: 'omit',
  fontSize: printLayout.official.bodyPt,
  arabic: false,
};
export function readPreferences(
  storage: Pick<StoragePort, 'getItem'>,
  id: string,
  legacyId = id,
): DocumentPreferences {
  try {
    const value = JSON.parse(
      storage.getItem(`mindwrite:preferences:${id}`) ??
        storage.getItem(`mindwrite:preferences:${legacyId}`) ??
        '{}',
    );
    return {
      ...(value.layout === 'official' || value.layout === 'standard'
        ? { layout: value.layout }
        : {}),
      scheme: ['official', 'heading', 'decimal', 'none'].includes(value.scheme)
        ? value.scheme
        : 'official',
      articleTitle: ['omit', 'bracket', 'separate'].includes(value.articleTitle)
        ? value.articleTitle
        : 'omit',
      fontSize:
        value.fontSize === printLayout.official.smallBodyPt
          ? printLayout.official.smallBodyPt
          : printLayout.official.bodyPt,
      arabic: value.arabic === true,
    };
  } catch {
    return { ...defaultPreferences };
  }
}
export function writePreferences(
  storage: Pick<StoragePort, 'setItem'>,
  id: string,
  value: DocumentPreferences,
) {
  storage.setItem(`mindwrite:preferences:${id}`, JSON.stringify(value));
}
