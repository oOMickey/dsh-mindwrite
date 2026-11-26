import { breakpoints, printLayout } from '../../style-tokens.ts';
import React, { useRef } from 'react';
import type { CopyKey } from '../../locales.ts';
import { composing, modifierKey } from '../keyboard.ts';
import type { Expansion } from '../../model.ts';
import type { ArticleTitle, Numbering } from '../../format.ts';
import type { WithEditor } from './toolbar.tsx';
import { LayoutSelect } from './MindMapView.tsx';
import { Icon, type IconName } from './Icon.tsx';
export function ExportSettings({ editor: c }: WithEditor) {
  return (
    <div className="mw-export-settings">
      {c.profile.type === 'regulation' && (
        <label className="mw-title-setting">
          {c.t('articleTitle')}
          <select
            aria-label={c.t('articleTitle')}
            value={c.articleTitle}
            onChange={(e) => c.setArticleTitle(e.target.value as ArticleTitle)}
          >
            <option value="omit">{c.t('articleOmit')}</option>
            <option value="bracket">{c.t('articleBracket')}</option>
            <option value="separate">{c.t('articleSeparate')}</option>
          </select>
          <small>{c.t('articleTitleHint')}</small>
        </label>
      )}
      <div className="mw-settings-row">
        <label>
          {c.t('scheme')}
          <select
            aria-label={c.t('scheme')}
            value={c.scheme}
            onChange={(e) => c.setScheme(e.target.value as Numbering)}
          >
            <option value="official">{c.t('official')}</option>
            <option value="heading">{c.t('heading')}</option>
            <option value="decimal">1 / 1.1 / 1.1.1</option>
            <option value="none">{c.t('none')}</option>
          </select>
        </label>
        {c.pageStyle === 'official' && (
          <label>
            {c.t('font')}
            <select
              aria-label={c.t('font')}
              value={c.fontSize}
              onChange={(e) => c.setFontSize(Number(e.target.value))}
            >
              <option value={printLayout.official.bodyPt}>
                {printLayout.official.bodyPt} pt / 三号
              </option>
              <option value={printLayout.official.smallBodyPt}>
                {printLayout.official.smallBodyPt} pt
              </option>
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
function QuickReference({ editor: c }: WithEditor) {
  const close = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const mod = modifierKey();
  const click = c.t('quickClick');
  const groups: [string, [string, CopyKey, IconName][]][] = [
    [
      c.t('quickSelection'),
      [
        [click, 'quickSelectOne', 'locate'],
        [mod + ' + ' + click, 'quickSelectMore', 'plus'],
        ['Shift + ' + click, 'quickSelectRange', 'list'],
        [mod + ' + A', 'selectLevel', 'list'],
        [c.t('pickByChapter'), 'quickPick', 'selection'],
      ],
    ],
    [
      c.t('quickCanvas'),
      [
        [c.t('quickBlankLeft'), 'quickBox', 'selection'],
        [
          c.t(c.navigation.editorWidth < breakpoints.narrow ? 'quickBlankLeft' : 'quickPanKeys'),
          'quickPan',
          'locate',
        ],
        [
          (c.navigation.wheelMode === 'scroll' ? mod + ' + ' : '') + c.t('quickWheel'),
          'quickZoom',
          'search',
        ],
        [mod + ' + 0', 'center', 'fit'],
        [c.t('quickDrag'), 'quickMove', 'arrowUp'],
      ],
    ],
    [
      c.t('quickEdit'),
      [
        ['Tab', 'guideChild', 'plus'],
        ['Enter', 'guideSibling', 'plus'],
        ['F2', 'keyEdit', 'edit'],
        ['Delete', 'keyDelete', 'trash'],
        [mod + ' + Z', 'undo', 'undo'],
      ],
    ],
    [
      'AI',
      [
        [c.t('polish'), 'quickAi', 'ai'],
        [c.t('reviewState'), 'quickReview', 'check'],
      ],
    ],
    [
      c.t('preview'),
      [
        [click, 'quickQuote', 'note'],
        [mod + ' + Shift + L', 'quickReadOnly', 'question'],
      ],
    ],
  ];
  return (
    <div
      className="mw-help-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) c.closeHelp();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={c.t('keyboard')}
        className="mw-drawer mw-quick-reference"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (composing(e.nativeEvent)) return;
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            c.closeHelp();
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            (e.target === close.current ? content : close).current?.focus();
          }
        }}
      >
        <div className="mw-drawer-heading">
          <strong>{c.t('keyboard')}</strong>
          <button ref={close} autoFocus aria-label={c.t('close')} onClick={c.closeHelp}>
            <Icon name="close" />
          </button>
        </div>
        <div className="mw-drawer-content" tabIndex={0} ref={content}>
          {[groups.slice(0, 2), groups.slice(2)].map((column) => (
            <div className="mw-help-column" key={column[0][0]}>
              {column.map(([name, actions]) => (
                <section key={name}>
                  <h3>{name}</h3>
                  <dl>
                    {actions.map(([key, label, icon]) => (
                      <div key={label}>
                        <dt>
                          <Icon name={icon} />
                          {c.t(label)}
                        </dt>
                        <dd>
                          <kbd>{key}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
export function Settings({ editor: c }: WithEditor) {
  if (c.drawer === 'help') return <QuickReference editor={c} />;
  if (c.drawer !== 'settings') return null;
  return (
    <aside className="mw-drawer mw-settings" aria-label={c.t('settings')}>
      <div className="mw-drawer-heading">
        <strong>{c.t('settings')}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        {c.profile.legacy && (
          <label className="mw-setting-check">
            <input
              type="checkbox"
              checked={c.arabic}
              onChange={(e) => c.setArabic(e.target.checked)}
            />
            {c.t('arabicNumbers')}
          </label>
        )}
        {c.snapshot && (
          <>
            <div className="mw-import-counts">
              <button disabled={c.locked} onClick={() => c.openDrawer('profile')}>
                {c.t('documentProfile')}
              </button>
              {c.snapshot.importReport && (
                <button onClick={() => c.setDiagnostics('import')}>{c.t('importReport')}</button>
              )}
            </div>
            <label>
              {c.t('arrangement')}
              <LayoutSelect editor={c} />
            </label>
            <label>
              {c.t('wheelBehavior')}
              <select
                aria-label={c.t('wheelBehavior')}
                value={c.navigation.wheelMode}
                onChange={(e) =>
                  c.navigation.setWheelMode(e.target.value === 'scroll' ? 'scroll' : 'zoom')
                }
              >
                <option value="zoom">{c.t('wheelZoom')}</option>
                <option value="scroll">{c.t('wheelScroll')}</option>
              </select>
            </label>
            <h3>{c.t('exportTitle')}</h3>
            <ExportSettings editor={c} />
          </>
        )}
        {c.snapshot && (
          <label>
            {c.t('defaultExpansion')}
            <select
              aria-label={c.t('defaultExpansion')}
              disabled={c.locked}
              value={c.snapshot.expansionDefault ?? 'one'}
              onChange={(e) =>
                void c.perform(() => c.setExpansionDefault(e.target.value as Expansion))
              }
            >
              {(['one', 'articles', 'unlimited'] as const).map((depth) => (
                <option key={depth} value={depth}>
                  {c.t(depth === 'articles' ? 'toArticles' : depth)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button onClick={() => c.setLanguage(c.language.startsWith('zh') ? 'en' : 'zh')}>
          中文 / English
        </button>
        <details>
          <summary>{c.t('about')}</summary>
          <p>{c.t('hostWriteLimit')}</p>
        </details>
      </div>
    </aside>
  );
}
