export interface KeyInput {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}
export function composing(event: Pick<KeyInput, 'isComposing' | 'keyCode'>) {
  return !!event.isComposing || event.keyCode === 229;
}
export function modifierKey() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘' : 'Ctrl';
}
export function nodeCommand(event: KeyInput, nodeFocused: boolean, editing: boolean) {
  if (composing(event)) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'f') return 'search';
  if (editing) return event.key === 'Escape' ? 'escape' : undefined;
  if (!nodeFocused) return;
  if (event.ctrlKey || event.metaKey) {
    if (key === 'a') return 'select-level';
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
    return;
  }
  if (event.altKey) {
    if (event.key === 'ArrowUp') return 'move-up';
    if (event.key === 'ArrowDown') return 'move-down';
    return;
  }
  const commands = {
    Enter: 'sibling',
    Tab: 'child',
    ' ': 'edit',
    F2: 'edit',
    Escape: 'escape',
    ArrowUp: 'previous',
    ArrowDown: 'next',
    ArrowLeft: 'parent',
    ArrowRight: 'first-child',
    Delete: 'delete',
    '?': 'help',
  } as const;
  return commands[event.key as keyof typeof commands];
}
