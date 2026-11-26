import { styleTokens } from '../../style-tokens.ts';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { writingActions } from '../instruction.ts';
import type { CopyKey } from '../../locales.ts';
import { composing } from '../keyboard.ts';
import { copyNodeText } from '../node-clipboard.ts';
import type { EditorView } from '../hooks/useNavigation.ts';
import { Icon, type IconName } from './Icon.tsx';
import { InstructionForm, type WithEditor } from './toolbar.tsx';

export type MenuTarget = {
  paragraph?: number;
  original?: string;
  id: string;
  element: HTMLElement;
  returnFocus?: HTMLElement;
  x: number;
  y: number;
  path: string;
  documentId: string;
  selectionKey: string;
  view: EditorView;
};
type Submenu = 'ai' | 'move' | 'instruction';
type Item = {
  label: string;
  action?: () => void | Promise<void>;
  sub?: Submenu;
  hint?: string;
  icon?: IconName;
  disabled?: boolean;
  danger?: boolean;
};

export function NodeMenu({
  editor: c,
  target,
  close,
  addQuote,
}: WithEditor & {
  target: MenuTarget;
  close: () => void;
  addQuote: (id: string, kind?: 'quote' | 'reference', paragraph?: number) => Promise<void>;
}) {
  const [sub, setSub] = useState<Submenu>();
  const main = useRef<HTMLDivElement>(null),
    child = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>();
  const row = c.rows.find((r) => r.node.id === target.id);
  const off = c.locked || c.busy || !!c.recovery;
  const readable = !!navigator.clipboard?.readText && !c.clipboardBlocked;
  function dismiss() {
    close();
    const origin = target.returnFocus?.isConnected
      ? target.returnFocus
      : (target.element.querySelector?.<HTMLElement>('.mw-node-title') ?? target.element);
    if (origin.isConnected) c.focusWithoutSelecting(origin);
  }
  useLayoutEffect(() => {
    if (off) setSub(undefined);
  }, [off]);
  useLayoutEffect(() => {
    const root = main.current;
    if (!root) return;
    const outside = (e: PointerEvent) => {
      if (!root.contains(e.target as Node) && !child.current?.contains(e.target as Node)) dismiss();
    };
    const moved = (e: Event) => {
      if (
        !(e.target instanceof Node) ||
        (!root.contains(e.target) && !child.current?.contains(e.target))
      )
        dismiss();
    };
    root.querySelector<HTMLButtonElement>('button:enabled')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', moved);
    window.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('scroll', moved, true);
    };
  }, [target]);
  useLayoutEffect(() => {
    const parent = main.current,
      bounds = c.editorElement.current?.getBoundingClientRect?.();
    if (!parent || !bounds) return;
    const inset = styleTokens.space.small;
    const left = Math.max(0, bounds.left) + inset,
      right = Math.min(innerWidth, bounds.right) - inset;
    const top = Math.max(0, bounds.top) + inset,
      bottom = Math.min(innerHeight, bounds.bottom) - inset;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const width = right - left;
    const limitHeight = Math.max(0, bottom - top);
    function position(el: HTMLElement, x: number, y: number) {
      el.style.left = x - bounds!.left + 'px';
      el.style.top = y - bounds!.top + 'px';
    }
    parent.style.maxHeight = limitHeight + 'px';
    parent.style.maxWidth = Math.min(styleTokens.size.menuMax, width) + 'px';
    const pop = child.current;
    if (pop) {
      // Reserve two adjacent columns even at 359. Long destinations wrap in their column.
      pop.style.maxWidth =
        Math.min(
          styleTokens.size.menuMax,
          width / 2,
          Math.max(styleTokens.size.submenu, width - parent.offsetWidth),
        ) + 'px';
      pop.style.maxHeight = limitHeight + 'px';
      parent.style.maxWidth = Math.min(styleTokens.size.menuMax, width - pop.offsetWidth) + 'px';
    }
    const w = parent.offsetWidth,
      h = parent.offsetHeight;
    let x = clamp(target.x + w <= right ? target.x : target.x - w, left, right - w);
    if (target.view === 'map') {
      const card = target.element.getBoundingClientRect();
      if (card.right + inset + w <= right) x = card.right + inset;
      else if (card.left - inset - w >= left) x = card.left - inset - w;
    }
    const y = clamp(target.y + h <= bottom ? target.y : target.y - h, top, bottom - h);
    if (!pop || !trigger.current) {
      position(parent, x, y);
      return;
    }
    const anchor = (
      target.element.querySelector<HTMLElement>('.mw-outline-row') ?? target.element
    ).getBoundingClientRect();
    // A long reflow paragraph can extend beyond both viewport edges. Only its
    // visible portion occupies the editor, leaving the toolbar available for a scrollable menu.
    const viewport = target.element
      .closest('.mw-outline, .mw-map, .mw-preview')
      ?.getBoundingClientRect();
    const anchorTop = Math.max(anchor.top, viewport?.top ?? top);
    const anchorBottom = Math.min(anchor.bottom, viewport?.bottom ?? bottom);
    const childWidth = pop.offsetWidth;
    const onRight =
      x + w + childWidth <= right ||
      (x - childWidth < left && anchor.left + anchor.width / 2 <= left + width / 2);
    x = onRight ? Math.min(x, right - w - childWidth) : Math.max(x, left + childWidth);
    position(parent, x, y);
    const childX = onRight ? x + w : x - childWidth;
    let childY = clamp(trigger.current.getBoundingClientRect().top, top, bottom - pop.offsetHeight);
    if (
      childX < anchor.right &&
      childX + childWidth > anchor.left &&
      childY < anchorBottom &&
      childY + pop.offsetHeight > anchorTop
    ) {
      const below = bottom - anchorBottom,
        above = anchorTop - top;
      pop.style.maxHeight = Math.max(0, below >= above ? below : above) + 'px';
      childY = below >= above ? anchorBottom : anchorTop - pop.offsetHeight;
    }
    position(pop, childX, childY);
  }, [target, sub, c.navigation.editorWidth, c.navigation.editorHeight]);
  if (!row) return null;
  const { node, parent } = row,
    id = node.id;
  const scope = c.nodeTargets(id);
  const item = (
    key: CopyKey,
    action: Item['action'],
    options: Omit<Item, 'label' | 'action'> = {},
  ): Item => ({ label: c.t(key), action, ...options });
  const locate = (view: EditorView) => {
    c.navigation.markReading(id);
    c.setView(view);
    c.locateSelection(id);
  };
  const edit = () => {
    if (c.view === 'outline') {
      c.openDrawer(null);
      c.setOutlineEditing(id);
      c.setEditing(id);
    } else c.beginInlineEdit(node, target.element.dataset.fragment, c.view, false);
  };
  const destinations = [
    ['outline', 'toOutline', 'list'],
    ['map', 'toMap', 'map'],
    ['preview', 'toPreview', 'body'],
  ] as const;
  const groupLabels = [
    'menuAiGroup',
    'menuEditGroup',
    'menuViewGroup',
    'menuClipboardGroup',
  ] as const;
  const groups: Item[][] = [
    [
      item('reviseQuote', () => addQuote(id, 'quote', target.paragraph), {
        icon: 'quote',
        hint: 'Ctrl+L',
        disabled: off,
      }),
      item('askReference', () => addQuote(id, 'reference', target.paragraph), {
        icon: 'question',
        hint: 'Ctrl+Shift+L',
      }),
      ...(!target.paragraph
        ? [item('polish', undefined, { icon: 'ai', sub: 'ai', disabled: off })]
        : []),
    ],
    target.paragraph
      ? []
      : [
          item('editNode', edit, { icon: 'edit', disabled: off }),
          ...(node.kind !== 'preamble'
            ? [
                item('menuChild', () => c.add(true, node), {
                  icon: 'child',
                  hint: 'Tab',
                  disabled: off,
                }),
              ]
            : []),
          ...(parent
            ? [
                item('menuSibling', () => c.add(false, node), {
                  icon: 'sibling',
                  hint: 'Enter',
                  disabled: off,
                }),
                item('up', () => c.moveSelected(-1, id), {
                  icon: 'arrowUp',
                  hint: 'Alt+↑',
                  disabled: off || parent.children[0].id === id,
                }),
                item('down', () => c.moveSelected(1, id), {
                  icon: 'arrowDown',
                  hint: 'Alt+↓',
                  disabled: off || parent.children.at(-1)?.id === id,
                }),
                item('moveTarget', undefined, { icon: 'moveTo', sub: 'move', disabled: off }),
              ]
            : []),
        ],
    destinations
      .filter(([view]) => view !== c.view)
      .map(([view, key, icon]) => item(key, () => locate(view), { icon })),
    target.paragraph
      ? []
      : [
          item(
            'copyNode',
            () =>
              copyNodeText(
                c.labels.get(id) ?? node.title,
                c.value(node, 'title'),
                c.value(node, 'body'),
                c.profile.legacy ? undefined : c.numbers.get(id)?.heading,
              ),
            { icon: 'copy' },
          ),
          item(
            readable ? 'pasteBodyEnd' : 'pasteShortcut',
            () => c.menuPaste(id, target.element, readable),
            { icon: 'paste', disabled: c.busy || !!c.recovery },
          ),
          ...(node.children.length
            ? [item('fold', () => c.navigation.toggleFold(id), { icon: 'down' })]
            : []),
          ...(parent
            ? [
                item(
                  'remove',
                  async () => {
                    await c.remove([id], true);
                  },
                  { icon: 'trash', danger: true, hint: 'Del', disabled: off },
                ),
              ]
            : []),
        ],
  ];
  function openChild(which: Submenu, el: HTMLButtonElement, focus: boolean) {
    if (off) return;
    if (which === 'instruction') {
      c.setInstruction(c.instructionFor(scope), scope);
      setSub(which);
      return;
    }
    trigger.current = el;
    setSub(which);
    if (focus)
      requestAnimationFrame(() =>
        child.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus(),
      );
  }
  function key(e: React.KeyboardEvent<HTMLDivElement>, nested: boolean) {
    if (
      composing(e.nativeEvent) ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      (e.shiftKey && e.key !== 'Tab')
    )
      return;
    if (sub === 'instruction') {
      const fields = e.currentTarget.querySelectorAll('textarea:enabled,button:enabled');
      const edge = e.shiftKey ? fields[0] : fields[fields.length - 1];
      if (e.key === 'Escape' || (e.key === 'Tab' && e.target === edge)) {
        e.stopPropagation();
        e.preventDefault();
        dismiss();
      }
      return;
    }
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')];
    const current = e.target as HTMLButtonElement,
      index = buttons.indexOf(current);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.stopPropagation();
      e.preventDefault();
      buttons[
        (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus();
    } else if (e.key === 'ArrowRight' && current.dataset.sub) {
      e.stopPropagation();
      e.preventDefault();
      openChild(current.dataset.sub as Submenu, current, true);
    } else if (nested && (e.key === 'ArrowLeft' || e.key === 'Escape')) {
      e.stopPropagation();
      e.preventDefault();
      setSub(undefined);
      trigger.current?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.stopPropagation();
      e.preventDefault();
      dismiss();
    }
  }
  function button(it: Item, nested = false) {
    return (
      <button
        key={it.label}
        type="button"
        role="menuitem"
        aria-label={it.label}
        aria-haspopup={it.sub ? 'menu' : undefined}
        aria-expanded={it.sub ? sub === it.sub : undefined}
        data-sub={it.sub}
        data-danger={it.danger}
        disabled={it.disabled || (nested && off)}
        onPointerEnter={(e) => {
          if (!nested) {
            if (it.sub) openChild(it.sub, e.currentTarget, false);
            else setSub(undefined);
          }
        }}
        onClick={(e) => {
          if (it.sub) openChild(it.sub, e.currentTarget, true);
          else {
            dismiss();
            if (it.action)
              void c.perform(async () => {
                await it.action!();
              });
          }
        }}
      >
        <span>{it.icon && <Icon name={it.icon} />}</span>
        {it.label}
        {it.hint && <kbd>{it.hint}</kbd>}
        {it.sub && <Icon name="right" />}
      </button>
    );
  }
  const destinationsForMove = sub === 'move' ? c.moveDestinations(scope.ids) : [];
  const subItems =
    sub === 'ai'
      ? c.profile.type !== 'regulation'
        ? writingActions.map((a) => ({
            label: c.language.startsWith('zh') ? a.zh : a.en,
            action: () => c.ai('polish', { nodeScope: scope, action: a }),
          }))
        : [
            item('menuPolish', () => c.ai('polish', { nodeScope: scope, task: '' })),
            item('menuTitle', () => c.ai('title', { nodeScope: scope, task: '' })),
            ...(node.kind === 'preamble'
              ? []
              : [
                  item('menuExpand', () =>
                    c.ai('expand', { nodeScope: scope, task: '', depth: 'one' }),
                  ),
                ]),
          ]
      : sub === 'move'
        ? destinationsForMove.map((r) => ({
            label: c.labels.get(r.node.id) ?? r.node.title,
            action: () => c.moveTo(r.node.id, scope.ids),
          }))
        : [];
  return (
    <>
      <div
        className="mw-node-menu"
        ref={main}
        role="menu"
        aria-label={c.t('nodeMenu')}
        onKeyDown={(e) => key(e, false)}
      >
        <div className="mw-menu-target">
          <strong>
            {target.paragraph
              ? c.targetLine('onlyParagraph', scope.ids, target.paragraph)
              : c.targetLine('onlyNode', scope.ids)}
          </strong>
          {c.targets.ids.length > 1 && (
            <small>{c.t('useTopForSelection').replace('{n}', String(c.targets.ids.length))}</small>
          )}
        </div>
        {sub === 'instruction' ? (
          <InstructionForm editor={c} nodeScope={scope} beforeSend={dismiss} />
        ) : (
          groups.map(
            (group, i) =>
              group.length > 0 && (
                <div role="group" key={i} aria-label={c.t(groupLabels[i])}>
                  <div className="mw-menu-group-label">{c.t(groupLabels[i])}</div>
                  {group.map((it) => button(it))}
                </div>
              ),
          )
        )}
      </div>
      {sub && sub !== 'instruction' && !off && (
        <div
          className="mw-node-menu mw-submenu"
          role="menu"
          ref={child}
          aria-label={c.t(sub === 'ai' ? 'polish' : 'moveTarget')}
          onKeyDown={(e) => key(e, true)}
        >
          {subItems.map((it) => button(it, true))}
          {sub === 'ai' &&
            button(item('customNodeAction', undefined, { sub: 'instruction' }), true)}
        </div>
      )}
    </>
  );
}
