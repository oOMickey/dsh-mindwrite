import { presets, schemeExamples, type Numbering } from '../../document-profile.ts';
import { Icon } from './Icon.tsx';
import React, { useState } from 'react';
import { numbering } from '../../numbering.ts';
import type { ReferenceCheck } from '../../references.ts';
import type { CopyKey } from '../../locales.ts';
import { ActionButton, type WithEditor } from './toolbar.tsx';
const issueLabels: Record<string, CopyKey> = {
  'duplicate-article': 'duplicateArticle',
  'missing-article': 'missingArticle',
  'duplicate-chapter': 'duplicateChapter',
  'missing-chapter': 'missingChapter',
  unfinished: 'unfinished',
};
const statusLabels: Record<string, CopyKey> = {
  resolved: 'referenceResolved',
  ambiguous: 'referenceAmbiguous',
  dangling: 'referenceDangling',
  deleted: 'referenceDeleted',
  edited: 'referenceEdited',
  'level-changed': 'referenceLevel',
};
const numberingWarnings = new Map<string, CopyKey>([
  ['gap', 'importGap'],
  ['duplicate', 'importDuplicate'],
  ['out-of-order', 'importOrder'],
  ['ambiguous', 'importAmbiguous'],
  ['mixed-scheme', 'importMixed'],
  ['numbering-conflict', 'importConflict'],
]);
function ConfirmReference({ editor: c, row }: WithEditor & { row: ReferenceCheck }) {
  const [chosen, setChosen] = useState('');
  const numbers = numbering(c.snapshot!.root);
  const candidates = c.rows.filter(({ node }) => numbers.get(node.id)?.unit === row.reference.unit);
  const options = candidates.flatMap(({ node }) =>
    row.reference.item === undefined
      ? [{ value: node.id, label: c.labels.get(node.id) ?? node.title }]
      : node.children.map((child) => ({
          value: `${node.id}/${child.id}`,
          label: `${c.labels.get(node.id)} / ${c.labels.get(child.id)}`,
        })),
  );
  return (
    <div className="mw-reference-confirm">
      <select
        aria-label={c.t('referenceTarget')}
        value={chosen}
        disabled={c.locked}
        onChange={(e) => setChosen(e.target.value)}
      >
        <option value="">{c.t('referenceTarget')}…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ActionButton
        editor={c}
        label="confirmReference"
        className="mw-primary"
        disabled={!chosen || c.locked}
        action={async () => {
          const [targetId, itemId] = chosen.split('/');
          await c.change([
            {
              type: 'confirm-reference',
              id: row.sourceId,
              referenceId: row.reference.id,
              targetId,
              itemId,
            },
          ]);
          setChosen('');
        }}
      />
    </div>
  );
}
export function Diagnostics({ editor: c }: WithEditor) {
  const report = c.snapshot?.importReport;
  const [details, setDetails] = useState(false);
  const [located, setLocated] = useState<number>();
  if (!c.diagnostics) return null;
  const summary = c.snapshot?.importSummary;
  const compact = c.profile.type !== 'regulation' && !details;
  const schemeLabel = (scheme: Numbering) =>
    scheme === 'none'
      ? c.t('none')
      : scheme === 'official'
        ? c.t('chapterArticle')
        : schemeExamples[scheme];
  const detection = c.snapshot?.detection;
  const warnings = c.snapshot?.importNumbering?.warnings ?? [];
  const warningCount = c.t('importWarnings').replace('{n}', String(warnings.length));
  const language = c.language.startsWith('zh') ? 'zh' : 'en';
  const savedSettings = presets[c.profile.type][language] + ' · ' + schemeLabel(c.scheme);
  const importCount =
    summary &&
    c
      .t('importCounts')
      .replace('{levels}', String(summary.levels))
      .replace('{paragraphs}', String(summary.paragraphs));
  const schemeText = (
    <>
      {detection && (
        <p>
          {c.t('importDetected')} ·{' '}
          <strong>
            {presets[detection.documentType][language]} · {schemeLabel(detection.numberingScheme)}
          </strong>
        </p>
      )}
      {(!detection ||
        c.profile.type !== detection.documentType ||
        c.scheme !== detection.numberingScheme) && (
        <p>
          {c.t('importCurrent')} · <strong>{savedSettings}</strong>
        </p>
      )}
      {detection ? (
        <p>
          {c
            .t('importReason')
            .replace('{type}', c.t(detection.typeReason))
            .replace(
              '{scheme}',
              c.t(detection.schemeReason).replace('{n}', String(detection.votes)),
            )}
        </p>
      ) : (
        c.snapshot?.importNumbering && (
          <p>
            {c
              .t('importSavedEvidence')
              .replace(
                '{n}',
                String(Object.keys(c.snapshot.importNumbering.prefixes ?? {}).length),
              )}
          </p>
        )
      )}
    </>
  );
  const actions = (
    <>
      {c.scheme !== 'none' && (
        <button
          disabled={c.locked || c.busy}
          onClick={() =>
            void c.perform(() => c.setDocumentProfile(c.profile.type, 'none', c.pageStyle))
          }
        >
          {c.t('removeNumbering')}
        </button>
      )}
      <button disabled={c.locked} onClick={() => c.openDrawer('profile')}>
        {c.t('importChange')}
      </button>
      {compact && (
        <button onClick={() => setDetails(true)}>
          {warnings.length ? warningCount : c.t('importDetails')}
        </button>
      )}
    </>
  );
  if (importCount && compact && c.diagnostics === 'import')
    return (
      <aside
        className="mw-diagnostics mw-drawer mw-import-summary"
        aria-label={c.t('importReport')}
      >
        <div className="mw-import-head">
          <strong>{c.t('importReport')}</strong>
          <span>{importCount}</span>
          <button aria-label={c.t('close')} onClick={() => c.setDiagnostics(null)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="mw-import-counts">{schemeText}</div>
        <div className="mw-import-counts">{actions}</div>
      </aside>
    );
  const counts = importCount && (
    <div className="mw-import-counts">
      <div className="mw-import-facts">
        <span>{importCount}</span>
        {schemeText}
      </div>
      <div>{actions}</div>
    </div>
  );

  return (
    <aside
      className="mw-diagnostics mw-drawer"
      data-report={c.diagnostics}
      aria-label={c.t('checks')}
    >
      <div className="mw-diagnostic-tabs mw-drawer-heading">
        <strong>{c.t(c.diagnostics === 'import' ? 'importReport' : 'referenceReport')}</strong>
        <span className="mw-spacer" />
        <button aria-label={c.t('close')} onClick={() => c.setDiagnostics(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-diagnostic-content mw-drawer-content" tabIndex={0}>
        {c.diagnostics === 'import' && report ? (
          <>
            {counts}
            {!!warnings.length && (
              <section className="mw-table-report mw-import-counts mw-numbering-notes">
                <h3>{warningCount}</h3>
                <ul>
                  {warnings.map((w, i) => {
                    const exists = c.labels.has(w.nodeId);
                    const origin = c.t('importParagraph').replace('{n}', String(w.paragraph));
                    return (
                      <li key={i}>
                        <strong>
                          {origin} · {c.t(numberingWarnings.get(w.code) ?? 'importOtherWarning')}
                        </strong>
                        <p>
                          <bdi>{w.marker}</bdi>
                          {w.related !== undefined && (
                            <>
                              {' '}
                              / <bdi>{w.related}</bdi>
                            </>
                          )}
                        </p>
                        {(located === w.paragraph || !exists) && (
                          <p role="status">
                            {origin} · {summary?.excerpts?.[w.paragraph] ?? w.marker}
                          </p>
                        )}
                        <button
                          disabled={!exists}
                          aria-label={origin + ' · ' + c.t('importLocate')}
                          onClick={() => {
                            setLocated(w.paragraph);
                            c.focusNode(w.nodeId);
                          }}
                        >
                          {exists && <Icon name="locate" />}{' '}
                          {c.t(exists ? 'importLocate' : 'importRemoved')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <p>
              {report.chapters} {c.t('chapters')} · {report.articles} {c.t('articles')} ·{' '}
              {report.preambleParagraphs} {c.t('preambleParagraphs')}
            </p>
            {report.source === 'docx' && (
              <p>
                {c.t('revisionsAccepted')}：{report.revisions.insertions} {c.t('insertions')}，
                {report.revisions.deletions} {c.t('deletions')}
              </p>
            )}
            {report.issues.length ? (
              <ul>
                {report.issues.map((issue, i) => (
                  <li key={i}>
                    <strong>{c.t(issueLabels[issue.code])}</strong>：
                    {issue.code !== 'unfinished' && issue.numbers.join('、')}
                    {issue.code === 'unfinished' &&
                      issue.nodeIds.map((id) => (
                        <span key={id}> · {c.labels.get(id) ?? c.t('referenceDeleted')}</span>
                      ))}
                  </li>
                ))}
              </ul>
            ) : (
              !warnings.length && <p>{c.t('noImportIssues')}</p>
            )}
            {report.nativeListItems !== undefined && (
              <p>
                {c.t('nativeLists')}：{report.nativeListItems}
              </p>
            )}
            {!!report.tableCount && (
              <section className="mw-table-report">
                <h3>
                  {c.t('tables')} · {report.tableCount}
                </h3>
                <ul>
                  {report.tables?.map((table) => (
                    <li key={table.index}>
                      <button
                        onClick={() => {
                          c.focusNode(table.nodeId);
                          c.setDiagnostics(null);
                          c.openDrawer('edit');
                        }}
                      >
                        {c.labels.get(table.nodeId)}
                      </button>
                      <p>
                        {table.rows} × {table.columns} ·{' '}
                        {c.t(table.method === 'column-values' ? 'tableConverted' : 'tableInNotes')}
                      </p>
                      {table.reason && <p role="note">{table.reason}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!!report.losses?.length && (
              <>
                <strong>
                  {c.t('headingLoss')} / {c.t('listLoss')}
                </strong>
                <ul>
                  {report.losses.map((loss, i) => (
                    <li key={i}>
                      {c.t('paragraph')} {loss.paragraph}：
                      {c.t(
                        loss.kind === 'heading'
                          ? loss.reason === 'missing-parent'
                            ? 'headingGap'
                            : 'headingNumberConflict'
                          : loss.reason === 'missing-definition'
                            ? 'missingListDefinition'
                            : 'unsupportedListPattern',
                      )}{' '}
                      {loss.marker}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>{c.t('renumberHint')}</p>
            {c.autoTitleIds.length > 0 && (
              <div>
                <p>{c.targetLine('autoTitleTargets', c.autoTitleIds)}</p>
                <ActionButton
                  editor={c}
                  label="autoTitles"
                  disabled={c.locked}
                  action={c.generateTitles}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <p>{c.t('referenceHint')}</p>
            {c.references.length ? (
              <ul className="mw-reference-list">
                {c.references.map((row, i) => (
                  <li key={`${row.sourceId}:${i}`} data-status={row.status}>
                    <button
                      className="mw-reference-source"
                      title={c.labels.get(row.sourceId) ?? row.sourceTitle}
                      onClick={() => c.focusNode(row.sourceId)}
                    >
                      <span className="mw-two-lines">
                        {c.labels.get(row.sourceId) ?? row.sourceTitle}
                      </span>
                    </button>
                    <strong>
                      {row.reference.text} → {row.current} → {row.targetTitles.join('；') || '—'}
                    </strong>
                    <span>{c.t(statusLabels[row.status])}</span>
                    {row.status !== 'resolved' && <ConfirmReference editor={c} row={row} />}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{c.t('noReferences')}</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
