import React, { useState } from 'react';
import {
  documentTypes,
  typeOptions,
  numberingSchemes,
  presets,
  schemeExamples,
  type PageStyle,
} from '../../document-profile.ts';
import { makeNode } from '../../model.ts';
import { compose } from '../../format.ts';
import type { WithEditor } from './toolbar.tsx';

export function DocumentProfile({ editor: c }: WithEditor) {
  const [type, setType] = useState(c.profile.type);
  const [authorScheme, setAuthorScheme] = useState(c.scheme);
  const [usePreset, setUsePreset] = useState(false);
  const scheme = usePreset ? presets[type].scheme : authorScheme;
  const [layout, setLayout] = useState<PageStyle>(c.pageStyle);
  const language = c.language.startsWith('zh') ? 'zh' : 'en';
  const root = c.snapshot!.root;
  const previewRoot = React.useMemo(() => {
    const section = root.children.find((n) => n.kind !== 'preamble');
    if (section) return { ...root, children: [section] };
    return makeNode({
      title: root.title,
      children: [
        {
          title: language === 'zh' ? '一级小节' : 'Section',
          children: [{ title: language === 'zh' ? '二级小节' : 'Subsection' }],
        },
      ],
    });
  }, [root, language]);
  const sections = compose(previewRoot, { ...c.profile, scheme });
  const preview = sections.slice(1, 3);
  const sample =
    (sections.find((p) => p.body.trim())?.body || '').trim().split(/[，。；！？\r\n]/u)[0] ||
    c.t('previewParagraph');
  const options = (key: typeof scheme) =>
    key === 'official' ? c.t('chapterArticle') : key === 'none' ? c.t('none') : schemeExamples[key];
  return (
    <section
      className="mw-profile-panel"
      role="dialog"
      aria-label={c.t('documentProfile')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          c.openDrawer(null);
        }
      }}
    >
      <fieldset>
        <legend>
          <span>{c.t('documentType')}</span>
        </legend>
        <div className="mw-profile-grid">
          {documentTypes.map((t) => (
            <button
              key={t}
              aria-pressed={t === type}
              onClick={() => {
                if (t === type) return;
                setType(t);
                setUsePreset(t !== c.profile.type);
                setLayout(t === c.profile.type ? c.pageStyle : presets[t].layout);
              }}
            >
              {language === 'zh' ? typeOptions[t] : presets[t].en}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{c.t('scheme')}</legend>
        <div className="mw-profile-grid">
          {numberingSchemes.map((s) => (
            <button
              key={s}
              aria-pressed={s === scheme}
              onClick={() => {
                setAuthorScheme(s);
                setUsePreset(false);
              }}
            >
              {options(s)}
            </button>
          ))}
        </div>
        {usePreset && scheme !== authorScheme && (
          <div className="mw-import-counts" role="status">
            <p>
              {c
                .t('numberingChange')
                .replace('{from}', options(authorScheme))
                .replace('{to}', options(scheme))}
            </p>
            <button onClick={() => setUsePreset(false)}>
              {c.t('keepNumbering').replace('{scheme}', options(authorScheme))}
            </button>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>{c.t('pageStyle')}</legend>
        <div className="mw-profile-grid">
          {(['standard', 'official'] as const).map((s) => (
            <button
              key={s}
              className="mw-layout-choice"
              aria-pressed={s === layout}
              onClick={() => setLayout(s)}
            >
              <span>{c.t(s === 'standard' ? 'standardPage' : 'officialPage')}</span>
              <small>{c.t(s === 'standard' ? 'standardPageDetail' : 'officialPageDetail')}</small>
            </button>
          ))}
        </div>
      </fieldset>
      <strong>{c.t('livePreview')}</strong>
      <div className="mw-profile-preview" data-layout={layout}>
        {preview.length ? (
          preview.map((p) => (
            <div key={p.id} data-depth={p.depth}>
              {p.heading}
            </div>
          ))
        ) : (
          <div>{c.snapshot!.root.title}</div>
        )}
        <p>{sample}</p>
      </div>
      <footer>
        <button onClick={() => c.openDrawer(null)}>{c.t('cancel')}</button>
        <button
          className="mw-primary"
          disabled={c.busy || c.locked}
          onClick={() => void c.perform(() => c.setDocumentProfile(type, scheme, layout))}
        >
          {c.t('applyProfile')}
        </button>
      </footer>
    </section>
  );
}
