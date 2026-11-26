import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { breakpoints } from '../../style-tokens.ts';
import React, { useEffect, useRef, useState } from 'react';
import type { MindNode } from '../../model.ts';
import type { WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';
import { composing } from '../keyboard.ts';

export function ChapterDirectory({ editor: c }: WithEditor) {
  const [panel, setPanel] = useState<string>();
  const nav = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const chapters = c.snapshot?.root.children.filter((n) => n.kind !== 'preamble') ?? [];
  const active = chapters.find((chapter) => chapter.id === panel);
  const wide = c.navigation.editorWidth >= breakpoints.wide;
  useEffect(() => {
    if (!panel) return;
    function outside(event: PointerEvent) {
      if (!nav.current?.contains(event.target as Node)) setPanel(undefined);
    }
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [panel]);
  function choose(chapter: MindNode) {
    c.navigation.expandChapter(chapter.id);
    setPanel(!wide && chapter.children.length ? chapter.id : undefined);
  }
  function articles(chapter: MindNode) {
    return chapter.children.map((article) => {
      const numbered = c.numbers.get(article.id);
      return (
        <button
          key={article.id}
          title={c.profile.legacy ? c.labels.get(article.id) : numbered?.heading}
          aria-label={c.profile.legacy ? undefined : numbered?.heading}
          onClick={() => {
            setPanel(undefined);
            c.focusNode(article.id);
          }}
        >
          {c.profile.legacy ? (
            numbered?.title
          ) : (
            <>
              {numbered?.prefix && <span className="mw-directory-prefix">{numbered.prefix}</span>}
              <span className="mw-directory-title">{numbered?.title}</span>
            </>
          )}
        </button>
      );
    });
  }
  return (
    <nav
      className="mw-directory"
      ref={nav}
      aria-label={c.t('chapterIndex')}
      onKeyDown={(event) => {
        if (!panel || event.key !== 'Escape' || composing(event.nativeEvent)) return;
        event.stopPropagation();
        setPanel(undefined);
        trigger.current?.focus();
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        className="mw-directory-trigger"
        ref={trigger}
        aria-label={c.t('contents')}
        title={c.t('contents')}
        aria-expanded={!!panel}
        disabled={!chapters.length}
        onClick={() => {
          c.setMenu(false);
          setPanel(panel ? undefined : 'index');
        }}
      >
        <Icon name="list" />
        <span>{c.t('contents')}</span>
      </Button>
      {panel && (
        <>
          <div className="mw-directory-scrim" onClick={() => setPanel(undefined)} />
          <div className="mw-chapter-popover" role="dialog" aria-label={c.t('contents')}>
            {active && !wide ? (
              <>
                <div className="mw-chapter-heading">
                  <button onClick={() => setPanel('index')}>{c.t('contents')}</button>
                  <strong>{c.numbers.get(active.id)?.heading}</strong>
                  <button aria-label={c.t('close')} onClick={() => setPanel(undefined)}>
                    <Icon name="close" />
                  </button>
                </div>
                <div className="mw-chapter-choices mw-article-choices">{articles(active)}</div>
              </>
            ) : (
              <div className="mw-chapter-choices" data-wide={wide}>
                {chapters.map((chapter) => {
                  const first = chapter.children[0],
                    last = chapter.children.at(-1);
                  const label = (id: string) => c.numbers.get(id)?.prefix.trim();
                  return (
                    <section key={chapter.id}>
                      <button
                        className="mw-chapter-choice"
                        title={chapter.title}
                        onClick={() => choose(chapter)}
                      >
                        <strong>{c.numbers.get(chapter.id)?.heading ?? chapter.title}</strong>
                        {!wide && first && last && label(first.id) && (
                          <small>
                            {label(first.id)}–{label(last.id)}
                          </small>
                        )}
                      </button>
                      {wide && articles(chapter)}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </nav>
  );
}
