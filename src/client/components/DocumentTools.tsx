import React from 'react';
import { documentHealth, healthMessage } from '../../health.ts';
import type { NodeInput } from '../../model.ts';
import { ActionButton, type WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';
function PreviewTree({ nodes }: { nodes: NodeInput[] }) {
  return (
    <ul>
      {nodes.map((node, index) => (
        <li key={index}>
          {node.title}
          {!!node.children?.length && <PreviewTree nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}
export function DocumentTools({ editor: c }: WithEditor) {
  if (c.drawer === 'health' && c.snapshot) {
    const issues = documentHealth(c.snapshot.root, c.snapshot.importReport, c.profile);
    return (
      <aside className="mw-drawer" aria-label={c.t('health')}>
        <div className="mw-drawer-heading">
          <strong>{c.t('health')}</strong>
          <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="mw-drawer-content">
          {issues.length ? (
            <ul className="mw-health-list">
              {issues.map((issue, i) => (
                <li key={i}>
                  <button
                    onClick={() => {
                      c.openDrawer(null);
                      c.focusNode(issue.nodeId);
                    }}
                  >
                    {healthMessage(issue, c.language)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{c.t('healthClean')}</p>
          )}
        </div>
      </aside>
    );
  }
  if (c.drawer !== 'paste' && c.drawer !== 'revisions') return null;
  const title = c.drawer === 'paste' ? 'pasteTree' : 'revisionTable';
  return (
    <aside
      className={'mw-drawer mw-document-tools mw-' + c.drawer + '-drawer'}
      aria-label={c.t(title)}
    >
      <div className="mw-drawer-heading">
        <strong>{c.t(title)}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        {c.drawer === 'paste' ? (
          <>
            <p>{c.t('pasteHint')}</p>
            <label>
              {c.t('parent')}
              <select
                aria-label={c.t('parent')}
                value={c.selected?.id ?? c.snapshot!.root.id}
                onChange={(e) => c.setSelection([e.target.value])}
              >
                <option value="" disabled>
                  {c.t('noSelection')}
                </option>
                {c.rows
                  .filter((r) => r.node.kind !== 'preamble')
                  .map((r) => (
                    <option value={r.node.id} key={r.node.id}>
                      {c.labels.get(r.node.id)}
                    </option>
                  ))}
              </select>
            </label>
            <textarea
              aria-label={c.t('pasteSource')}
              value={c.pasteText}
              onChange={(e) => {
                c.setPasteText(e.target.value);
                c.setPastePreview(null);
              }}
            />
            <ActionButton
              editor={c}
              label="pastePreview"
              className={c.pastePreview ? undefined : 'mw-primary'}
              disabled={!c.pasteText.trim()}
              action={c.previewPaste}
            />
            {c.pastePreview && (
              <section className="mw-paste-preview" aria-label={c.t('pastePreview')}>
                <h3>
                  {c.t('pastePreview')} · {c.pastePreview.count} {c.t('count')}
                </h3>
                <PreviewTree nodes={c.pastePreview.nodes} />
                {c.pastePreview.warnings.map((warning, i) => (
                  <p key={i}>{warning}</p>
                ))}
              </section>
            )}
          </>
        ) : (
          <>
            {!c.revisionData?.hasSource && <p>{c.t('noOriginal')}</p>}
            <p>{c.t('revisionNoteHint')}</p>
            <label>
              <input
                type="checkbox"
                checked={c.onlyChanges}
                onChange={(e) => c.setOnlyChanges(e.target.checked)}
              />
              {c.t('allChanges')}
            </label>
            <div className="mw-revision-rows">
              {c.revisionData?.rows
                .filter((row) => !c.onlyChanges || !row.flags.includes('未改动'))
                .map((row) => (
                  <article key={row.id} data-revision-row={row.id}>
                    <header>
                      <strong>{row.flags.join(' · ')}</strong>
                      {row.nodeId && (
                        <label>
                          <input
                            type="checkbox"
                            aria-label={c.labels.get(row.nodeId)}
                            checked={c.selection.includes(row.nodeId)}
                            onChange={(e) =>
                              c.setSelection(
                                e.target.checked
                                  ? [...c.selection, row.nodeId!]
                                  : c.selection.filter((id) => id !== row.nodeId),
                              )
                            }
                          />
                          {c.labels.get(row.nodeId)}
                        </label>
                      )}
                    </header>
                    <div className="mw-revision-columns">
                      <section>
                        <h4>{c.t('originalClause')}</h4>
                        <pre>{row.original}</pre>
                      </section>
                      <section>
                        <h4>{c.t('currentClause')}</h4>
                        <pre>{row.current}</pre>
                      </section>
                      <section>
                        <h4>{c.t('revisionReason')}</h4>
                        <pre>{row.note || '—'}</pre>
                      </section>
                    </div>
                  </article>
                ))}
            </div>
          </>
        )}
      </div>
      <div className="mw-drawer-footer">
        {c.drawer === 'paste' ? (
          <ActionButton
            editor={c}
            label="insertTree"
            className="mw-primary"
            disabled={!c.pastePreview || c.locked}
            action={c.insertPaste}
          />
        ) : (
          <>
            <ActionButton
              editor={c}
              label="exportRevisionTable"
              className="mw-primary"
              action={c.exportRevisions}
            />
            <ActionButton
              editor={c}
              label="draftReason"
              disabled={!c.selection.length || c.locked}
              action={() =>
                c.ai('note', {
                  task: '对照导入原文与当前条文，为选中的条款起草简短、准确的修改说明，说明变化及目的；没有依据的理由请标为待确认。只写 note，其他字段不变。',
                })
              }
            />
          </>
        )}
      </div>
    </aside>
  );
}
