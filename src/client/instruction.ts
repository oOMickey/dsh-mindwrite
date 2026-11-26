/** Bind an instruction to both the document and selection, including during the
 * render before React's selection-change cleanup runs. Selection order is not scope. */
export function instructionSelectionKey(
  documentId: string,
  ids: string[],
  chapterLead?: string,
): string {
  return JSON.stringify([documentId, [...new Set(ids)].sort(), chapterLead]);
}
export function instructionForSelection(draft: { key: string; text: string }, key: string): string {
  return draft.key === key ? draft.text : '';
}

/** Project the grant into document order without changing the author's selection anchor. */
export function aiTargets(
  document: string,
  order: Iterable<string>,
  selection: string[],
  chapterLead?: string,
) {
  const selected = new Set(selection);
  const ids: string[] = [];
  const bodyIds: string[] = [];
  for (const id of order) {
    if (selected.has(id)) ids.push(id);
    if (selected.has(id) || id === chapterLead) bodyIds.push(id);
  }
  const includesLead = ids.length > 0 && bodyIds.length > ids.length;
  const leadId = includesLead ? chapterLead : undefined;
  return {
    ids,
    bodyIds: includesLead ? bodyIds : ids,
    leadId,
    key: instructionSelectionKey(document, ids, leadId),
  };
}
export type AiTargets = ReturnType<typeof aiTargets>;

export const polishAction = {
  zh: '润色',
  en: 'Polish',
  hint: 'polishHint',
  instruction: '润色所选正文，使表达清楚流畅。',
} as const;
export const writingActions = [
  polishAction,
  {
    zh: '扩写',
    en: 'Elaborate',
    hint: 'elaborateHint',
    instruction: '扩写所选正文，补充解释和必要细节。',
  },
  { zh: '精简', en: 'Shorten', hint: 'shortenHint', instruction: '精简所选正文，保留核心信息。' },
  { zh: '更正式', en: 'More formal', hint: 'formalHint', instruction: '将所选正文改得更正式。' },
  {
    zh: '更口语',
    en: 'More conversational',
    hint: 'conversationalHint',
    instruction: '将所选正文改得更口语、自然。',
  },
  {
    zh: '续写',
    en: 'Continue writing',
    hint: 'continueHint',
    instruction: '保留所选正文，接着已有内容续写。',
  },
] as const;

export type WritingAction = (typeof writingActions)[number];

export function actionTargetIds(scope: AiTargets, mode: string, action?: WritingAction) {
  return mode === 'polish' && (!action || action === polishAction) ? scope.bodyIds : scope.ids;
}

export function writingInstruction(action: WritingAction, author: string) {
  return [action.instruction, author.trim()].filter(Boolean).join('\n');
}
