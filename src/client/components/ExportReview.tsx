import React from 'react';
import { healthMessage } from '../../health.ts';
import { ActionButton, type WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';
export function ExportReview({ editor: c }: WithEditor) {
  if (c.drawer === 'export-formats')
    return (
      <aside className="mw-drawer mw-export-formats" aria-label={c.t('export')}>
        <div className="mw-drawer-heading">
          <strong>{c.t('chooseFormat')}</strong>
          <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="mw-drawer-content">
          <label>
            {c.t('filename')}
            <input
              aria-label={c.t('filename')}
              value={c.exportFilename}
              onChange={(e) => c.setExportFilename(e.target.value)}
            />
          </label>
          <p className="mw-muted">{c.t('notesExportHint')}</p>
          <div className="mw-drawer-actions">
            <ActionButton
              editor={c}
              label="downloadWord"
              className="mw-primary"
              disabled={!c.exportFilename.trim()}
              action={() => c.download('docx')}
            />
            <ActionButton
              editor={c}
              label="downloadMd"
              disabled={!c.exportFilename.trim()}
              action={() => c.download('md')}
            />
            <ActionButton editor={c} label="copy" action={c.copyText} />
          </div>
        </div>
      </aside>
    );
  const review = c.exportReview;
  if (c.drawer !== 'export' || !review) return null;
  function complete(id: string) {
    c.setView('map');
    c.focusNode(id);
    c.openDrawer('edit');
  }
  return (
    <aside className="mw-drawer mw-export-review" aria-label={c.t('exportReview')}>
      <div className="mw-drawer-heading">
        <strong>{c.t('exportReview')}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        {review.pendingCount > 0 && (
          <p className="mw-export-pending" role="status">
            {c.t('pendingExport').replace('{n}', String(review.pendingCount))}
          </p>
        )}
        {review.incomplete.length > 0 && (
          <section className="mw-incomplete">
            <h3>
              <Icon name="warning" /> {c.t('incompleteArticles')} ({review.incomplete.length})
            </h3>
            <ul>
              {review.incomplete.map((item) => (
                <li key={item.id}>
                  <button
                    title={c.labels.get(item.id) ?? item.title}
                    onClick={() => complete(item.id)}
                  >
                    <span className="mw-three-lines">{c.labels.get(item.id) ?? item.title}</span>
                    <small>{item.reason}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="mw-muted">{c.t('notesExportHint')}</p>
        {review.format !== 'text' && (
          <label className="mw-export-filename">
            {c.t('filename')}
            <input
              aria-label={c.t('filename')}
              title={c.t('filenameHint')}
              value={c.exportFilename}
              onChange={(e) => c.setExportFilename(e.target.value)}
            />
            <small>{c.t('filenameHint')}</small>
          </label>
        )}
        {!!review.health.filter((i) => i.severity !== 'error' && i.code !== 'reference').length && (
          <details open>
            <summary>
              {c.t('health')} (
              {review.health.filter((i) => i.severity !== 'error' && i.code !== 'reference').length}
              )
            </summary>
            <ul>
              {review.health
                .filter((i) => i.severity !== 'error' && i.code !== 'reference')
                .map((issue) => (
                  <li key={issue.id}>
                    <button onClick={() => complete(issue.nodeId)}>
                      {c.labels.get(issue.nodeId)}
                    </button>
                    <p>{healthMessage(issue, c.language)}</p>
                  </li>
                ))}
            </ul>
            <ActionButton
              editor={c}
              label="fixSafe"
              disabled={c.locked || !review.health.some((i) => i.after !== undefined)}
              action={c.fixHealth}
            />
          </details>
        )}
        {review.excluded.length > 0 && (
          <details>
            <summary>
              {c.t('excludedContent')} ({review.excluded.length})
            </summary>
            <ul>
              {review.excluded.map((item, index) => (
                <li key={index}>
                  <strong>
                    {item.title} · {c.t(item.field === 'note' ? 'noteExcluded' : 'articleTitle')}
                  </strong>
                  <p>{item.text}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
        {review.unresolved.length > 0 && (
          <details open>
            <summary>
              {c.t('unresolvedReferences')} ({review.unresolved.length})
            </summary>
            <ul>
              {review.unresolved.map((item, index) => (
                <li key={index}>
                  {item.sourceTitle} · {item.reference.text}
                </li>
              ))}
            </ul>
            <ActionButton
              editor={c}
              label="referenceReport"
              action={() => c.setDiagnostics('references')}
            />
          </details>
        )}
      </div>
      <div className="mw-drawer-footer">
        {review.pendingCount > 0 && (
          <button
            autoFocus
            className="mw-primary"
            onClick={() => {
              c.setView('preview');
              c.openDrawer(null);
            }}
          >
            {c.t('backToReview')}
          </button>
        )}
        {!review.pendingCount && review.incomplete.length > 0 && (
          <button
            autoFocus
            className="mw-primary"
            onClick={() => complete(review.incomplete[0].id)}
          >
            {c.t('goComplete')}
          </button>
        )}
        <ActionButton
          editor={c}
          className={review.pendingCount || review.incomplete.length ? undefined : 'mw-primary'}
          label={
            review.pendingCount
              ? review.format === 'text'
                ? 'copyAnyway'
                : 'exportAnyway'
              : review.incomplete.length
                ? 'exportPlaceholders'
                : 'confirmExport'
          }
          disabled={review.format !== 'text' && !c.exportFilename.trim()}
          action={() => c.completeExport(review.format, review)}
        />
      </div>
    </aside>
  );
}
