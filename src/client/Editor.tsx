import { breakpoints } from '../style-tokens.ts';
import { Icon } from './components/Icon.tsx';
import React, { useEffect, useId, useState } from 'react';
import { useBlockQuotes } from './hooks/useBlockQuotes.ts';
import { composing } from './keyboard.ts';
import { NodeMenu, type MenuTarget } from './components/NodeMenu.tsx';
import { documentKey, type EditorProps } from './types.ts';
import { useEditor } from './hooks/useEditor.ts';
import { MindMapView } from './components/MindMapView.tsx';
import { OutlineView } from './components/OutlineView.tsx';
import { FullTextView, QuoteFeedback } from './components/FullTextView.tsx';
import { SelectionBar } from './components/SelectionBar.tsx';
import { NodeDetails, NewHeadingInput } from './components/NodeEditor.tsx';
import { OnboardingHint } from './components/OnboardingHint.tsx';
import { CompactToolbar } from './components/CompactToolbar.tsx';
import { Diagnostics } from './components/Diagnostics.tsx';
import { ActionDrawer } from './components/ActionDrawer.tsx';
import { ExportReview } from './components/ExportReview.tsx';
import { ActionButton } from './components/toolbar.tsx';
import { NavigationBar } from './components/NavigationBar.tsx';
import { Settings } from './components/Settings.tsx';
import { ConflictReview } from './components/ConflictReview.tsx';
import { AiReview } from './components/AiReview.tsx';
import { DocumentTools } from './components/DocumentTools.tsx';
import { PasteFeedback } from './components/PasteFeedback.tsx';

export function Editor(props: EditorProps) {
  const c = useEditor(props);
  const pasteNameHintId = useId();
  const quotes = useBlockQuotes(c, props);
  const [menu, setMenu] = useState<MenuTarget>();
  useEffect(() => setMenu(undefined), [c.view, c.targets.key]);
  function target(e: React.SyntheticEvent) {
    const el = e.target as HTMLElement;
    if (el.closest('input,textarea,select,[contenteditable=true],.mw-measure,.mw-inline-editor'))
      return;
    const node = el.closest<HTMLElement>('[data-node-id]');
    return node && node.dataset.nodeId !== c.newHeading?.node.id ? node : undefined;
  }
  function show(el: HTMLElement, x: number, y: number) {
    if (!c.snapshot || !el.dataset.nodeId) return;
    const paragraph = el.dataset.bodyOrdinal ? Number(el.dataset.bodyOrdinal) : undefined;
    const original =
      paragraph === undefined ? undefined : c.paragraphOriginal(el.dataset.nodeId, paragraph);
    if (paragraph !== undefined && original === undefined) return;
    setMenu({
      id: el.dataset.nodeId,
      paragraph,
      original,
      x,
      y,
      element: el,
      returnFocus:
        document.activeElement &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : undefined,
      path: c.snapshot.path,
      documentId: c.snapshot.id,
      selectionKey: c.targets.key,
      view: c.view,
    });
  }
  const sameParagraph =
    !menu?.paragraph || c.paragraphOriginal(menu.id, menu.paragraph) === menu.original;
  useEffect(() => {
    if (!sameParagraph) setMenu(undefined);
  }, [sameParagraph]);
  const treeWorkspace = c.navigation.hasContent && c.view !== 'preview';
  const footer = (c.busy ||
    c.hasDraft ||
    c.locked ||
    (c.view !== 'preview' && c.targets.ids.length > 0)) && (
    <footer className="mw-footer">
      <SelectionBar editor={c} />
      {(c.busy || c.hasDraft) && <span role="status">{c.t(c.busy ? 'saving' : 'draft')}</span>}
      {c.locked && <ActionButton editor={c} label="stop" action={c.cancelAi} />}
    </footer>
  );
  return (
    <section
      ref={c.editorElement}
      className="mw-app mw-compact"
      data-mw-style="soft"
      lang={c.language}
      style={{ '--mw-editor-height': c.navigation.editorHeight + 'px' } as React.CSSProperties}
      data-wide={c.navigation.editorWidth >= breakpoints.wide}
      data-testid="mindwrite"
      tabIndex={0}
      onPointerDownCapture={(e) => {
        if (e.button === 2 && target(e) && !(e.target as HTMLElement).closest('[data-review-key]'))
          e.preventDefault();
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-review-key]')) {
          // Keep the native selection/copy menu. A projected fragment grants no manuscript access.
          setMenu(undefined);
          return;
        }
        const el = target(e);
        if (el) {
          e.preventDefault();
          show(el, e.clientX, e.clientY);
        }
      }}
      onKeyDownCapture={(e) => {
        if (composing(e.nativeEvent)) return;
        const el = target(e);
        if (!el?.dataset.nodeId) return;
        if (el.dataset.reviewKey !== undefined) {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          const rect = el.getBoundingClientRect();
          show(el, rect.left, rect.bottom);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat && (!c.locked || e.shiftKey))
            void c.perform(() =>
              quotes.add(
                el.dataset.nodeId!,
                e.shiftKey ? 'reference' : 'quote',
                el.dataset.bodyOrdinal ? Number(el.dataset.bodyOrdinal) : undefined,
              ),
            );
        }
      }}
      onKeyDown={c.keydown}
      onPaste={c.paste}
      aria-label={c.t('title')}
    >
      <CompactToolbar editor={c} />
      {menu &&
        sameParagraph &&
        c.snapshot?.path === menu.path &&
        c.snapshot.id === menu.documentId &&
        c.targets.key === menu.selectionKey &&
        c.numbers.has(menu.id) &&
        c.view === menu.view && (
          <NodeMenu
            key={menu.id + menu.x + '/' + menu.y}
            editor={c}
            target={menu}
            addQuote={(id, kind, paragraph) =>
              quotes.add(id, kind, paragraph, undefined, menu.original)
            }
            close={() => setMenu(undefined)}
          />
        )}
      {c.recovery && (
        <div className="mw-recovery" role="status">
          <strong>{c.t('recoverDraft')}</strong>
          <p>{c.t('recoverDraftHint')}</p>
          <button className="mw-primary" onClick={() => void c.perform(c.restoreDraft)}>
            {c.t('restoreDraft')}
          </button>
          <button onClick={c.discardDraft}>{c.t('discardDraft')}</button>
        </div>
      )}
      {c.localError && (
        <div className="mw-error" role="alert">
          {c.localError}
        </div>
      )}
      {c.pollHealth.message && !c.pollHealth.dismissed && (
        <div className="mw-connection-error" role="status">
          <Icon name="warning" />
          <span>
            {c.t('pollRetrying')}
            <details>
              <summary>{c.t('details')}</summary>
              <pre>{c.pollHealth.message}</pre>
            </details>
          </span>
          <button aria-label={c.t('close')} onClick={c.dismissPollError}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <input
        type="file"
        ref={c.inputFile}
        accept=".md,.docx"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void c.perform(() => c.importFile(file));
          e.currentTarget.value = '';
        }}
      />
      {c.creating && (
        <form
          className="mw-drawer mw-create"
          onSubmit={(e) => {
            e.preventDefault();
            void c.perform(c.createDocument);
          }}
        >
          <div className="mw-drawer-heading">
            <strong>
              {c.t(
                c.startAction === 'structure'
                  ? 'startStructure'
                  : c.startAction === 'paste'
                    ? 'pasteTree'
                    : c.startAction === 'manual'
                      ? 'manualChapter'
                      : 'new',
              )}
            </strong>
            <button
              type="button"
              disabled={c.busy}
              aria-label={c.t('close')}
              onClick={() => c.setCreating(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="mw-drawer-content">
            {c.startAction === 'paste' && <p id={pasteNameHintId}>{c.t('pasteNameHint')}</p>}
            <label>
              {c.t('newTitle')}
              <input
                autoFocus
                required
                aria-describedby={c.startAction === 'paste' ? pasteNameHintId : undefined}
                value={c.newTitle}
                onChange={(e) => c.setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !composing(e.nativeEvent) && !c.busy) {
                    e.stopPropagation();
                    c.setCreating(false);
                  }
                }}
              />
            </label>
          </div>
          <div className="mw-drawer-footer">
            <button className="mw-primary" type="submit" disabled={c.busy}>
              {c.t(c.startAction === 'paste' ? 'nextStep' : 'create')}
            </button>
          </div>
        </form>
      )}
      {c.queueNotice && (
        <div className="mw-error mw-queue-notice" role="status">
          {c.queueNotice}
        </div>
      )}
      {(c.error || c.integrityAlert) &&
        !(!c.integrityAlert && c.drawer === 'conflicts' && c.conflicts.length) && (
          <div className="mw-error" role="alert">
            <span>{c.integrityAlert?.message || c.error}</span>
            {c.errorDetails && (
              <details className="mw-error-details">
                <summary>{c.t('details')}</summary>
                <pre>{c.errorDetails}</pre>
              </details>
            )}
            {c.error && (
              <button aria-label={c.t('close')} onClick={() => c.setError('')}>
                <Icon name="close" />
              </button>
            )}
            {c.integrityAlert?.kind === 'staging' && (
              <>
                <ActionButton editor={c} label="retryStaging" action={c.retryStaging} />
                <ActionButton editor={c} label="cancel" action={c.cancelAi} />
              </>
            )}
            {c.hasDraft && (
              <>
                <small>{c.t('savingHint')}</small>
                <ActionButton editor={c} label="retryDraft" action={c.retryDraft} />
                <ActionButton editor={c} label="discardDraft" action={c.discardDraft} />
              </>
            )}
          </div>
        )}
      {(c.snapshot || c.loaded) &&
        !c.creating &&
        !c.navigation.hasContent &&
        !(c.view === 'preview' && c.aiReviewCount) && (
          <div className="mw-empty">
            <span className="mw-empty-icon">
              <Icon name="note" />
            </span>
            <div className="mw-empty-root mw-block" data-node-id={c.snapshot?.root.id}>
              <h2
                className="mw-node-title"
                tabIndex={c.snapshot ? 0 : undefined}
                {...(c.snapshot && c.focusProps(c.snapshot.root.id))}
              >
                {c.t('emptyGuide')}
              </h2>
            </div>
            <div className="mw-empty-actions">
              <ActionButton
                editor={c}
                label="startStructure"
                className="mw-primary"
                disabled={c.locked}
                action={() => c.startFromEmpty('structure')}
              />
              <div className="mw-empty-secondary">
                <ActionButton
                  editor={c}
                  label="manualChapter"
                  disabled={c.locked || !!c.recovery}
                  action={() => c.startFromEmpty('manual')}
                />
                <ActionButton
                  editor={c}
                  label="pasteTree"
                  disabled={c.locked || !!c.recovery}
                  action={() => c.startFromEmpty('paste')}
                />
                <ActionButton
                  editor={c}
                  label="importDraft"
                  disabled={c.locked}
                  action={() => c.inputFile.current?.click()}
                />
              </div>
            </div>
            {!!c.aiReviewCount && (
              <ActionButton editor={c} label="aiReview" action={() => c.openDrawer('ai-review')} />
            )}
          </div>
        )}
      {c.snapshot && (
        <>
          <Diagnostics key={c.snapshot.path} editor={c} />
          <NavigationBar editor={c} />
          {(!c.notice || c.pasteFeedback?.stage === 'section') && <PasteFeedback editor={c} />}
          {(c.navigation.hasContent || (c.view === 'preview' && c.aiReviewCount > 0)) && (
            <main className="mw-workspace">
              {c.view === 'map' && <MindMapView editor={c} openMenu={show} />}
              {c.view === 'outline' && <OutlineView editor={c} />}
              {c.view === 'preview' && (
                <>
                  {c.newHeading && (
                    <div className="mw-new-paper-heading">
                      <NewHeadingInput editor={c} node={c.newHeading.node} />
                    </div>
                  )}
                  <FullTextView
                    key={props.sessionId + c.snapshot.path}
                    editor={c}
                    quotes={quotes}
                  />
                </>
              )}
              <QuoteFeedback editor={c} quotes={quotes} />
              {treeWorkspace && footer}
            </main>
          )}
          <OnboardingHint editor={c} />
          <ActionDrawer editor={c} />
          <ExportReview editor={c} />
          <ConflictReview editor={c} />
          <AiReview
            key={JSON.stringify([props.sessionId, documentKey(c.snapshot)])}
            editor={c}
            addReview={quotes.addReview}
          />
          <DocumentTools editor={c} />
          {c.view === 'map' && <NodeDetails editor={c} />}
          {!treeWorkspace && footer}
        </>
      )}
      <Settings editor={c} />
      {!c.loaded && !c.snapshot && (
        <div className="mw-loading" role="status">
          {c.t('loadingDocument')}
        </div>
      )}
      {c.notice && (
        <div className="mw-notice" role="status">
          <span>{c.notice}</span>
          {c.notice.startsWith(c.t('deletedCount').split('{n}')[0]) && (
            <ActionButton editor={c} label="undo" action={() => c.history()} />
          )}
          <button aria-label={c.t('close')} onClick={() => c.setNotice('')}>
            <Icon name="close" />
          </button>
        </div>
      )}
    </section>
  );
}
