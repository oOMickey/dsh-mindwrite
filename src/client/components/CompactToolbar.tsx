import React, { useEffect, useId, useRef } from 'react';
import { breakpoints } from '../../style-tokens.ts';
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import { composing, modifierKey } from '../keyboard.ts';
import { actionTargetIds, polishAction, writingActions } from '../instruction.ts';
import { DocumentProfile } from './DocumentProfile.tsx';
import { profileLabel } from '../../document-profile.ts';
import { Icon, type IconName } from './Icon.tsx';
import { ChapterDirectory } from './ChapterDirectory.tsx';
import { ChapterSelection } from './ChapterSelection.tsx';
import { ActionButton, InstructionForm, SelectionChips, type WithEditor } from './toolbar.tsx';

const presetIcons = {
  polishHint: 'ai',
  elaborateHint: 'body',
  shortenHint: 'shorten',
  formalHint: 'briefcase',
  conversationalHint: 'question',
  continueHint: 'edit',
} as const;

function WritingMenu({
  editor: c,
  close,
  focusInput,
}: WithEditor & { close: () => void; focusInput: boolean }) {
  const regulation = c.profile.type === 'regulation';
  const lead = c.targets.leadId;
  const presetGroupId = useId();
  return (
    <div
      role="dialog"
      aria-label={c.t('polish')}
      className="mw-writing-actions"
      onKeyDown={(event) => {
        if (
          !composing(event.nativeEvent) &&
          event.key === 'Escape' &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.stopPropagation();
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="mw-writing-heading">
        <Icon name="ai" />
        <strong>{c.t('polish')}</strong>
        <button
          className="mw-ghost"
          autoFocus={!focusInput}
          onClick={close}
          aria-label={c.t('close')}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-scope-chips" tabIndex={0}>
        <SelectionChips editor={c} />
        {lead && (
          <span
            className="mw-target-chip mw-lead-chip"
            title={c.targetLine('leadNames', c.targets.bodyIds)}
          >
            {c.targetLine(
              'writingLead',
              [lead],
              actionTargetIds(c.targets, 'polish', polishAction).length,
            )}
          </span>
        )}
      </div>
      <div className="mw-preset-grid">
        {(regulation ? [polishAction] : writingActions).map((action) => {
          const label = regulation
            ? c.t('menuPolish')
            : c.language.startsWith('zh')
              ? action.zh
              : action.en;
          const hintId = presetGroupId + '-' + action.hint;
          return (
            <button
              key={action.en}
              aria-label={label}
              aria-describedby={hintId}
              disabled={c.busy || c.locked}
              onClick={() =>
                void c.perform(() => (regulation ? c.ai('polish') : c.ai('polish', { action })))
              }
            >
              <Icon name={presetIcons[action.hint]} />
              <span>
                <strong>{label}</strong>
                <small id={hintId}>{c.t(action.hint)}</small>
              </span>
            </button>
          );
        })}
      </div>
      <InstructionForm editor={c} focusInput={focusInput} />
    </div>
  );
}

const moreIcons = {
  actions: 'selection',
  editBodyNote: 'edit',
  undo: 'undo',
  redo: 'redo',
  pasteTree: 'paste',
  searchLabel: 'search',
  fullscreen: 'fit',
  locate: 'locate',
  allChapters: 'list',
  focusChapter: 'map',
  health: 'check',
  revisionTable: 'comparison',
  aiReviewHistory: 'history',
  saveAs: 'copy',
  importDraft: 'import',
  settings: 'settings',
  keyboard: 'help',
} as const satisfies Record<string, IconName>;

function MenuAction(
  props: React.ComponentProps<typeof ActionButton> & {
    label: keyof typeof moreIcons;
    shortcut?: string;
  },
) {
  const { shortcut, ...button } = props;
  return (
    <ActionButton
      {...button}
      icon={
        <>
          <Icon name={moreIcons[props.label]} />
          <span>{props.editor.t(props.label)}</span>
          {shortcut && <kbd>{shortcut}</kbd>}
        </>
      }
    />
  );
}

export function CompactToolbar({ editor: c }: WithEditor) {
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!c.menu && c.drawer !== 'profile' && c.drawer !== 'writing-actions') return;
    const close = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) {
        c.setMenu(false);
        if (c.drawer === 'profile' || c.drawer === 'writing-actions') c.openDrawer(null);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [c.menu, c.drawer]);
  const files = new Map(c.files.map((file) => [file.path, file.title]));
  if (c.snapshot) files.set(c.snapshot.path, c.snapshot.root.title);
  const hasContent = c.navigation.hasContent;
  const aiButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const opener = useRef('');
  const mod = modifierKey();
  const reason = c.locked
    ? c.t('processing')
    : c.busy
      ? c.t('saving')
      : c.aiReviewCount
        ? ''
        : !hasContent
          ? c.t('createBeforeAi')
          : c.view === 'preview'
            ? c.t('quoteBeforeAi')
            : !c.targets.ids.length
              ? c.t('selectBeforeAi')
              : '';
  const aiLabel = c.aiReviewCount
    ? c.t('pendingAi').replace('{n}', String(c.aiReviewCount))
    : !c.targets.ids.length
      ? c.t('polish')
      : c
          .t(c.navigation.editorWidth < breakpoints.compact ? 'compactAi' : 'selectedAi')
          .replace('{n}', String(c.targets.ids.length));
  return (
    <header className="mw-topbar" ref={header}>
      <div className="mw-topbar-main">
        <span className="mw-file-picker">
          <span aria-hidden="true">{c.snapshot?.root.title ?? c.t('file')}</span>
          <Icon name="down" />
          <select
            aria-label={c.t('file')}
            title={c.snapshot?.root.title ?? c.t('file')}
            value={c.snapshot?.path ?? ''}
            disabled={c.locked}
            onChange={(event) => {
              const value = event.target.value;
              if (value === ':new') void c.startFromEmpty('new');
              else void c.perform(() => c.selectDocument(value));
            }}
          >
            <option value="" disabled>
              {c.t('file')}
            </option>
            {[...files].map(([path, title]) => (
              <option key={path} value={path}>
                {title}
              </option>
            ))}
            <option value=":new">{c.t('new')}</option>
          </select>
        </span>
        {c.snapshot && (
          <Pill
            className="mw-profile-tag"
            aria-label={c.t('documentProfile')}
            aria-expanded={c.drawer === 'profile'}
            disabled={c.locked}
            onClick={() => c.openDrawer(c.drawer === 'profile' ? null : 'profile')}
          >
            {profileLabel(
              c.profile.type,
              c.snapshot.root.title,
              c.language.startsWith('zh') ? 'zh' : 'en',
            )}
            <span className="mw-scheme-label">
              {' '}
              ·{' '}
              {c.scheme === 'none'
                ? c.t('none')
                : c.scheme === 'heading'
                  ? '一、（一）'
                  : c.scheme === 'decimal'
                    ? '1 / 1.1'
                    : c.t('chapterArticle')}
            </span>
          </Pill>
        )}
        {c.snapshot && c.drawer === 'profile' && (
          <DocumentProfile editor={c} key={c.snapshot.path} />
        )}
        <div className="mw-ai-control">
          <Button
            variant="primary"
            size="sm"
            ref={aiButton}
            onPointerDown={(event) => {
              opener.current = event.pointerType;
            }}
            onKeyDown={() => {
              opener.current = 'keyboard';
            }}
            className="mw-primary"
            type="button"
            aria-disabled={!!reason}
            aria-describedby={reason ? reasonId : undefined}
            aria-haspopup="dialog"
            aria-expanded={
              c.aiReviewCount ? c.drawer === 'ai-review' : c.drawer === 'writing-actions'
            }
            onClick={(event) => {
              if (reason) {
                event.currentTarget.focus();
                return;
              }
              if (c.aiReviewCount) c.openDrawer('ai-review');
              else c.openDrawer(c.drawer === 'writing-actions' ? null : 'writing-actions');
            }}
          >
            {aiLabel}
          </Button>
          {reason && (
            <span role="tooltip" id={reasonId} className="mw-ai-reason">
              {reason}
            </span>
          )}
        </div>
        {c.drawer === 'writing-actions' && !c.aiReviewCount && !!c.targets.ids.length && (
          <WritingMenu
            key={c.targets.key}
            focusInput={
              opener.current === 'keyboard' ||
              (opener.current !== 'touch' &&
                opener.current !== 'pen' &&
                !matchMedia('(pointer: coarse)').matches)
            }
            editor={c}
            close={() => {
              c.openDrawer(null);
              aiButton.current?.focus();
            }}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mw-ghost"
          disabled={!hasContent || c.busy}
          onClick={() =>
            void c.perform(async () => {
              c.setExportFilename(c.snapshot!.root.title);
              c.openDrawer(c.drawer === 'export-formats' ? null : 'export-formats');
            })
          }
        >
          {c.t('export')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          ref={moreButton}
          className="mw-more-trigger"
          aria-label={c.t('more')}
          title={c.t('more')}
          aria-expanded={c.menu}
          onClick={() => c.setMenu(!c.menu)}
        >
          <Icon name="more" />
        </Button>
      </div>
      <div className="mw-topbar-navigation">
        <nav className="mw-view-switch mw-segments" aria-label={c.t('document')}>
          {(['outline', 'map', 'preview'] as const).map((view) => (
            <button
              key={view}
              aria-pressed={c.view === view}
              disabled={!hasContent && !(view === 'preview' && c.aiReviewCount)}
              onClick={() =>
                void c.perform(async () => {
                  await c.flush();
                  c.setView(view);
                  c.openDrawer(null);
                })
              }
            >
              {c.t(view)}
            </button>
          ))}
        </nav>
        <ChapterDirectory key={c.snapshot?.id} editor={c} />
        {c.snapshot && c.view !== 'preview' && (
          <ChapterSelection key={c.snapshot?.path} editor={c} />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mw-help-trigger"
          aria-label={c.t('keyboard')}
          title={c.t('keyboard')}
          aria-haspopup="dialog"
          onClick={(e) => c.openHelp(e.currentTarget)}
        >
          <Icon name="help" />
        </Button>
      </div>
      {c.menu && (
        <div className="mw-more-menu" role="dialog" aria-label={c.t('more')}>
          {c.snapshot && (
            <div role="group">
              <MenuAction
                editor={c}
                label="actions"
                disabled={c.locked}
                action={() => {
                  c.openDrawer('actions');
                }}
              />
              <MenuAction
                editor={c}
                label="editBodyNote"
                disabled={!c.selected}
                action={() => {
                  if (c.view === 'outline') {
                    c.setOutlineEditing(c.selected!.id);
                    c.openDrawer(null);
                  } else {
                    c.setView('map');
                    c.openDrawer('edit');
                  }
                }}
              />

              <MenuAction
                editor={c}
                queueable
                shortcut={mod + '+Z'}
                label="undo"
                disabled={!c.snapshot.canUndo || c.locked}
                action={() => c.history()}
              />
              <MenuAction
                editor={c}
                queueable
                shortcut={mod + '+Shift+Z'}
                label="redo"
                disabled={!c.snapshot.canRedo || c.locked}
                action={() => c.history(true)}
              />
              {c.snapshot.historyLimited && <small>{c.t('historyLimited')}</small>}
              <MenuAction
                editor={c}
                label="pasteTree"
                disabled={c.locked}
                action={() => {
                  if (!c.selected) c.setSelection([c.snapshot!.root.id]);
                  c.openDrawer('paste');
                }}
              />
              <MenuAction
                editor={c}
                shortcut={mod + '+F'}
                label="searchLabel"
                action={() => {
                  c.setMenu(false);
                  c.setSearchOpen(true);
                }}
              />
              <MenuAction
                editor={c}
                label="fullscreen"
                action={() => {
                  c.setMenu(false);
                  c.fullscreen();
                }}
              />
              <details>
                <summary>
                  <Icon name="right" />
                  <span>{c.t('navigation')}</span>
                  <Icon name="down" />
                </summary>
                <MenuAction
                  editor={c}
                  label="locate"
                  disabled={!c.selected}
                  action={() => {
                    c.setMenu(false);
                    c.locateSelection();
                  }}
                />
                {c.view === 'map' && (
                  <>
                    <MenuAction
                      editor={c}
                      label={c.navigation.focused ? 'allChapters' : 'focusChapter'}
                      action={() => {
                        const next = c.navigation.focused ? 'all' : 'chapter';
                        if (next === 'chapter' && c.navigation.chapter)
                          c.focusNode(c.navigation.chapter);
                        c.navigation.setFocusMode(next);
                        c.setMenu(false);
                      }}
                    />
                  </>
                )}
              </details>
            </div>
          )}
          {c.snapshot && (
            <div role="group">
              <MenuAction editor={c} label="health" action={() => c.openDrawer('health')} />
              <MenuAction editor={c} label="revisionTable" action={c.reviewRevisions} />
              <MenuAction
                editor={c}
                label="aiReviewHistory"
                action={() => c.openDrawer('ai-history')}
              />
              <MenuAction editor={c} label="saveAs" action={c.saveAs} />
            </div>
          )}
          <div role="group">
            <MenuAction
              editor={c}
              label="importDraft"
              disabled={c.locked}
              action={() => {
                c.setMenu(false);
                c.inputFile.current?.click();
              }}
            />
            <MenuAction editor={c} label="settings" action={() => c.openDrawer('settings')} />
            <MenuAction
              editor={c}
              label="keyboard"
              shortcut="?"
              action={() => c.openHelp(moreButton.current)}
            />
          </div>
        </div>
      )}
    </header>
  );
}
