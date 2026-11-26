import React, { useEffect, useState } from 'react';
import { composing } from '../keyboard.ts';
import { ActionButton, type WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';

function SectionCard({ editor: c, name, initial }: WithEditor & { name: string; initial: string }) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(initial);
  const disabled = !title.trim() || c.busy || c.locked || !!c.recovery;
  return (
    <form
      className="mw-inline-editor mw-paste-card"
      aria-label={c.t('pasteAsSection')}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled)
          void c.perform(async () => {
            await c.savePasteSection(title.trim(), body);
          });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e.nativeEvent)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          c.dismissPaste();
        }
        if (e.key === 'Enter' && !e.shiftKey && e.target instanceof HTMLTextAreaElement) {
          e.preventDefault();
          if (!e.repeat) e.currentTarget.requestSubmit();
        }
      }}
    >
      <strong>{c.t('pasteSectionOf').replace('{title}', () => name)}</strong>
      <label>
        {c.t('nodeTitle')}
        <input
          autoFocus
          required
          maxLength={500}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        {c.t('body')}
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <footer>
        <button className="mw-primary" type="submit" disabled={disabled}>
          {c.t('saveEnter')}
        </button>
        <button type="button" onClick={c.dismissPaste}>
          {c.t('cancelEsc')}
        </button>
      </footer>
    </form>
  );
}
export function PasteFeedback({ editor: c }: WithEditor) {
  const f = c.pasteFeedback;
  const { size } = c.navigation;
  useEffect(() => {
    // The notice changes the map's viewport and therefore its canvas offset.
    if (f && f.stage !== 'section' && c.board.current?.clientHeight === size.height)
      c.navigation.ensure(f.at.id);
  }, [f, size]);
  if (!f) return null;
  if (f.stage === 'section')
    return <SectionCard key={f.token} editor={c} name={f.at.name} initial={f.text} />;
  let message: string;
  if (f.stage === 'done') {
    const { receipt, at } = f;
    const key =
      receipt.kind === 'sections'
        ? 'pasteSections'
        : at.after === undefined
          ? 'pasteAppended'
          : at.after === 0
            ? 'pasteAtStart'
            : 'pasteAfter';
    message = c
      .t(key)
      .replace('{n}', String(receipt.count))
      .replace('{p}', String(at.after))
      .replace('{title}', () => at.name);
    if (receipt.introCount)
      message += ' · ' + c.t('pasteIntro').replace('{n}', String(receipt.introCount));
    if (c.review.items.some((item) => item.entry.id === at.id && item.reason))
      message += ' · ' + c.t('pasteConflict');
  } else if (f.stage === 'review') message = c.t('pastePending').replace('{n}', String(f.count));
  else message = c.t('pasteShortcut');
  return (
    <div role="status" className="mw-notice mw-paste-notice">
      <span>{message}</span>
      {f.stage === 'review' && (
        <>
          <ActionButton
            key={f.consent}
            editor={c}
            label="pasteReview"
            className="mw-primary"
            autoFocus
            action={() => c.reviewPaste(false)}
          />
          <ActionButton editor={c} label="pasteAnyway" action={() => c.reviewPaste(true)} />
        </>
      )}
      {f.stage === 'done' && (
        <>
          <ActionButton editor={c} label="undo" action={() => c.history(false, false, f.token)} />
          {!f.at.preamble && (
            <ActionButton
              editor={c}
              label={f.receipt.kind === 'body' ? 'pasteAsSection' : 'pasteAsBody'}
              action={c.switchPaste}
            />
          )}
        </>
      )}
      <button type="button" aria-label={c.t('close')} onClick={c.dismissPaste}>
        <Icon name="close" />
      </button>
    </div>
  );
}
