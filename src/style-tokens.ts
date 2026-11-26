// CSS pixels unless specified otherwise. Both themes use the same layout.
const role = (light: string, dark = light) => ({ light, dark });
const alias = (name: string) => `var(--${name})`;
const space = {
  small: 4,
  regular: 8,
  medium: 12,
  large: 16,
  section: 20,
  gutter: 24,
  indent: 28,
  page: 32,
} as const;
const type = {
  aux: { size: 12, line: 18 },
  body: { size: 13, line: 20 },
  chapter: { size: 15, line: 22 },
  doc: { size: 17, line: 24, narrow: 14 },
} as const;

// Physical document measurements are independent of the editor's four UI text sizes.
export const printLayout = {
  halfPointsPerPoint: 2,
  widthMm: 210,
  heightMm: 297,
  mmPerInch: 25.4,
  pixelsPerInch: 96,
  pointsPerInch: 72,
  official: { bodyPt: 16, smallBodyPt: 14, titlePt: 22, linePt: 28, footerPt: 14 },
  standard: { bodyPt: 12, headingPt: 13, chapterPt: 15, titlePt: 18, afterPt: 6, leading: 1.5 },
  revisionTable: {
    columnPercent: 33.33,
    tablePercent: 100,
    afterTwips: 80,
    marginVerticalMm: 20,
    marginHorizontalMm: 18,
  },
  margin: {
    official: { top: 37, bottom: 35, left: 28, right: 26, footer: 17.5 },
    standard: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4, footer: 12.7 },
  },
} as const;

const host = (name: string, fallback: string) => `var(--dsw-${name}, ${fallback})`;
// Some host surfaces (especially the dark platform) are brighter than the manuscript canvas.
const tuned = (name: string, fallback: string, share: number) =>
  `color-mix(in srgb, ${host(name, fallback)} ${share}%, ${fallback})`;

const softColors = {
  'mw-surface': role(host('alias-bg-base', '#FFFFFF'), tuned('alias-bg-base', '#1C1D21', 20)),
  'mw-canvas': role(
    tuned('alias-bg-module-platform', '#F7F8FA', 20),
    tuned('alias-bg-module-platform', '#151517', 10),
  ),
  'mw-card': role(host('alias-bg-layer-1', '#FFFFFF'), tuned('alias-bg-layer-1', '#25272C', 25)),
  'mw-outline-fade': role('linear-gradient(to bottom, transparent, var(--mw-canvas))'),
  'mw-card-root': role('#F2F6FF', '#22293A'),
  'mw-dot': role('#DBE0E8', '#2A2C32'),
  'mw-dot-pattern': role('radial-gradient(circle, var(--mw-dot) 1px, transparent 1px)'),
  'mw-track': role(
    tuned('alias-bg-module-platform', '#EEF0F4', 15),
    tuned('alias-bg-module-platform', '#27292F', 15),
  ),
  'mw-thumb': role(
    host('alias-bg-layer-1', '#FFFFFF'),
    tuned('alias-button-elevated-fill', '#353841', 15),
  ),
  'mw-popover': role(host('alias-bg-layer-2', '#FFFFFF'), tuned('alias-bg-layer-2', '#26282E', 25)),
  'mw-card-ring': role(
    host('alias-border-l1', 'rgba(15,23,42,.06)'),
    host('alias-border-l2', 'rgba(255,255,255,.08)'),
  ),
  'mw-border-input': role('#7C8798', '#8C96A6'),
  'mw-hover': role(
    host('alias-interactive-bg-hover', 'rgba(38,49,72,.06)'),
    host('alias-interactive-bg-hover', 'rgba(255,255,255,.08)'),
  ),
  'mw-fg': role(host('alias-label-primary', '#111827'), host('alias-label-primary', '#F3F4F6')),
  'mw-fg-secondary': role(
    tuned('alias-label-secondary', '#525C6C', 30),
    tuned('alias-label-secondary', '#A3ACBA', 30),
  ),
  'mw-fg-muted': role('#5E6878', '#A3ACBA'),
  'mw-brand': role('#2655D1', '#73A4FF'),
  // Dark primary keeps white type legible. Channel offsets derive the button fill from the accent.
  'mw-brand-btn': role(
    alias('mw-brand'),
    'rgb(from var(--mw-brand) calc(r - 59) calc(g - 54) calc(b - 23))',
  ),
  'mw-brand-btn-fg': role(host('alias-label-on-color', '#FFFFFF')),
  'mw-sel-bg': role('#F2F6FF', '#1E2940'),
  'mw-sel-ring': role(alias('mw-brand')),
  'mw-marquee-fill': role('color-mix(in srgb, var(--mw-brand) 8%, transparent)'),
  'mw-edge': role('#717E91', '#717B8C'),
  'mw-edge-active': role(alias('mw-brand')),
  'mw-check-ink': role(alias('mw-brand-btn-fg'), alias('mw-canvas')),
  'mw-pencil-bg': role('color-mix(in srgb, var(--mw-brand) 16%, var(--mw-card))'),
  'mw-pending-current': role('#662E05', '#FFFAEE'),
  'mw-revision-insert': role('#FBEACB', '#45351F'),
  'mw-tooltip-bg': role(host('alias-tooltip-bg', '#2C2C2E'), host('alias-tooltip-bg', '#43454A')),
  'mw-tooltip-fg': role(host('alias-tooltip-label', '#FFFFFF')),
  'bg-surface': role(alias('mw-surface')),
  'bg-canvas': role(alias('mw-canvas')),
  'bg-sticky': role(alias('mw-track')),
  'bg-card': role(alias('mw-card')),
  'bg-para': role('#F9FAFC', alias('mw-card')),
  'bg-popover': role(alias('mw-popover')),
  'bg-paper': role('#FFFFFF', '#1C1D21'),
  'bg-hover': role(alias('mw-hover')),
  'bg-selected': role(alias('mw-sel-bg')),
  'border-subtle': role(host('alias-border-l2', '#E0E4EA'), host('alias-border-l2', '#383B42')),
  'border-card': role('#CFD8E3', '#38414E'),
  'border-paper': role('#D5DCE6', alias('border-card')),
  'border-strong': role('#B9C5D4', '#41546C'),
  'border-selected': role(alias('mw-sel-ring')),
  'border-control': role(alias('mw-border-input')),
  'bg-tree-selection': role(alias('mw-sel-bg')),
  'text-primary': role(alias('mw-fg')),
  'text-secondary': role(alias('mw-fg-secondary')),
  'text-disabled': role(alias('mw-fg-muted')),
  'brand-fg': role(alias('mw-brand')),
  'brand-btn-bg': role(alias('mw-brand-btn')),
  'brand-btn-fg': role(alias('mw-brand-btn-fg')),
  overlay: role(
    host('alias-bg-mask-1', 'rgba(15,23,42,.24)'),
    host('alias-bg-mask-1', 'rgba(0,0,0,.5)'),
  ),
  'status-pending-bar': role('#D67606', '#D97706'),
  'status-pending-text': role('#924505', '#F5B041'),
  'status-pending-bg': role('#FFF7E8', '#282115'),
  'status-conflict-bar': role('#C8332B', '#EF4444'),
  'status-conflict-text': role('#BC241A', '#F88379'),
  'status-conflict-bg': role('#FEF2F2', '#2A191B'),
  'status-adopted-bar': role('#2F855A', '#3B8764'),
  'status-adopted-text': role('#176B43', '#68C797'),
  'status-adopted-bg': role('#ECFDF3', '#16251F'),
  'rev-del-text': role(alias('text-secondary')),
  'rev-ins-text': role(alias('brand-fg')),
  'rev-key-text': role('#5C2D04', '#FDECC8'),
  'rev-key-bg': role('#FDECC8', '#5C3409'),
  'warn-text': role(alias('status-pending-text')),
  'warn-bg': role(alias('status-pending-bg')),
  'error-text': role(alias('status-conflict-text')),
  'error-border': role(alias('status-conflict-bar')),
  'danger-text': role(alias('status-conflict-text')),
  'success-text': role(alias('status-adopted-text')),
  'map-line': role(alias('border-strong')),
} as const;

const softStyle = {
  colors: softColors,
  shadow: {
    card: role('none'),
    paper: role('0 1px 3px rgba(24,34,48,.04)'),
    node: role(
      '0 1px 2px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.04), 0 0 0 1px var(--mw-card-ring)',
      '0 1px 2px rgba(0,0,0,.25), 0 4px 12px rgba(0,0,0,.18), 0 0 0 1px var(--mw-card-ring)',
    ),
    root: role(
      '0 2px 6px color-mix(in srgb, var(--mw-brand) 8%, transparent), 0 6px 18px rgba(15,23,42,.05), 0 0 0 1px color-mix(in srgb, var(--mw-brand) 16%, transparent)',
      '0 4px 16px rgba(0,0,0,.3), 0 0 0 1px var(--mw-card-ring)',
    ),
    selected: role(
      '0 0 0 5px color-mix(in srgb, var(--mw-sel-ring) 14%, transparent), 0 4px 12px color-mix(in srgb, var(--mw-brand) 8%, transparent)',
      '0 0 0 5px color-mix(in srgb, var(--mw-sel-ring) 22%, transparent)',
    ),
    pop: role(
      '0 12px 32px rgba(15,23,42,.12), 0 2px 6px rgba(15,23,42,.06), 0 0 0 1px var(--mw-card-ring)',
      'inset 0 1px 0 var(--mw-card-ring), 0 12px 32px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.24), 0 0 0 1px var(--mw-card-ring)',
    ),
    floating: role(
      '0 4px 16px rgba(15,23,42,.08), 0 0 0 1px var(--mw-card-ring)',
      'inset 0 1px 0 var(--mw-card-ring), 0 4px 16px rgba(0,0,0,.32), 0 0 0 1px var(--mw-card-ring)',
    ),
    thumb: role('0 1px 3px rgba(15,23,42,.12)', '0 1px 3px rgba(0,0,0,.28)'),
    drawer: role('none'),
  },
  type,
  radius: { main: 6, small: 6, button: 8, card: 10, panel: 12, pill: 999 },
  controlSize: {
    writingMenu: 368,
    menuRow: 30,
    cornerReserve: 176,
    promptMax: 120,
    outlineColumn: 960,
    dotPitch: 20,
  },
  manuscript: {
    widths: [216, 226, 316],
    columnGap: 52,
    curveTension: 0.52,
    corner: 6,
    portRadius: 2,
    checkSize: 18,
    ordinalSize: 11,
    chapterSize: 14,
  },
  controlInset: { floatInset: 14, trackInset: 2 },
} as const;

const editorStyles = {
  soft: softStyle,
};

export const styleTokens = {
  ...softStyle,
  space,
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  progressGradient: 'linear-gradient(90deg, transparent, var(--brand-fg), transparent)',
  leading: { review: 1.88, reflow: 1.9 },
  font: {
    ui: "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif",
    heiti: "SimHei, 'Heiti SC', var(--mw-font-ui)",
    standard: "SimSun, '宋体', 'Songti SC', 'Noto Serif CJK SC', serif",
    official: "FangSong, 'FangSong_GB2312', 'STFangsong', 'Noto Serif CJK SC', serif",
    title:
      "'FZXiaoBiaoSong-B05S', '方正小标宋简体', SimSun, 'Songti SC', 'Noto Serif CJK SC', serif",
    kai: "KaiTi, STKaiti, 'Noto Serif CJK SC', serif",
  },
  // Hairline and optical offsets are independent of the spacing grid.
  detail: {
    hairline: 1,
    focus: 2,
    bar: 3,
    hoverOffset: 5,
    numberColumn: 42,
    summaryGap: 10,
    panelInset: 10,
  },
  icon: { size: 16, stroke: 1.5 },
  motion: { move: 180, fade: 110, handles: 150, spin: 1000, progress: 1500, initialOpacity: 0.55 },
  opacity: { mutedAction: 0.62 },
  size: {
    iconSmall: 12,
    fold: 20,
    controlSmall: 24,
    button: 28,
    capsule: 32,
    heading: 36,
    row: 40,
    rowWide: 44,
    toolbar: 48,
    menuClearance: 60,
    fieldMin: 64,
    fieldNote: 72,
    editorMin: 76,
    paneMin: 80,
    topbar: 82,
    topbarWide: 88,
    field: 96,
    list: 100,
    directoryCell: 104,
    chapterCell: 120,
    fieldBody: 132,
    diffCompact: 140,
    submenu: 148,
    conflictText: 160,
    diff: 180,
    errorDetails: 200,
    drawerMin: 220,
    menu: 224,
    menuMax: 240,
    drawer: 260,
    moreMenu: 284,
    settings: 300,
    editorCard: 320,
    actionDrawer: 340,
    reviewDrawer: 360,
    message: 400,
    profile: 412,
    documentDrawer: 420,
    readingColumn: 480,
    editorFallback: 620,
  },
  zoom: {
    actual: 1,
    mapMin: 0.05,
    mapMax: 3,
    pageMin: 0.2,
    step: 1.15,
    percent: 100,
    wheelLine: 16,
    wheelLimit: 600,
    wheelSensitivity: 0.0018,
  },
  resize: { min: 120, initial: 180, max: 420 },
  outline: { indentStart: 2, maxIndent: 6 },
  relative: { targetList: '6em', editorLines: '12em', docPicker: '32rem' },
  breakpoint: { phone: 390, compact: 450, narrow: 600, panel: 680, wide: 800 },
  map: {
    minExtent: 1,
    glyphAdvanceEm: { separator: 0.28, narrow: 0.4, digit: 0.56, latin: 0.7, full: 1 },
    stroke: 1.5,
    margin: space.large,
    fitInset: 2 * space.large,
    initialWidth: 359,
    denseAbove: 80,
    hideLabelsBelow: 0.2,
    card: {
      border: 1,
      padX: space.medium,
      padY: space.medium,
      tightX: space.small,
      tightY: space.small,
      denseY: 1,
      gap: space.small,
      fold: 20,
      smallFold: 16,
      minHeight: 54,
      denseMinHeight: 23,
      minLines: 1,
      maxLines: 2,
      narrowRootLines: 3,
      prefixShare: 0.5,
    },
    right: {
      widths: softStyle.manuscript.widths,
      narrowWidths: [146, 136, 180],
      narrowMinHeights: [62, 66, 46],
      columnGap: softStyle.manuscript.columnGap,
      narrowGap: space.large,
      chapterGap: space.page,
      rowGap: space.large,
      denseGap: 2,
      anchorOffset: space.regular,
    },
    down: {
      rootMin: 218,
      rootMax: 480,
      chapter: 232,
      compactChapter: 200,
      indent: space.page,
      columnGap: space.large,
      rootGap: 64,
      chapterGap: space.section,
      rowGap: space.section,
      ringClearance: space.regular,
      bend: space.large,
    },
    directory: {
      indent: space.gutter,
      wideWidth: 480,
      minWidth: 160,
      maxWidth: 280,
      gap: space.regular,
    },
    edge: {
      directoryInset: 8,
      downInset: space.regular,
      tension: softStyle.manuscript.curveTension,
      radius: softStyle.manuscript.corner,
    },
  },
} as const;

export const { map: mapTokens, breakpoint: breakpoints } = styleTokens;

/** Emit scoped variables and materialize container conditions, which cannot resolve var(). */
export function compileStyle(source: string): string {
  const t = styleTokens;
  const px = (prefix: string, values: Readonly<Record<string, number>>) =>
    Object.entries(values).map(([name, value]) => `  --${prefix}-${name}: ${value}px;`);
  const values = (prefix: string, items: Readonly<Record<string, string | number>>) =>
    Object.entries(items).map(([key, value]) => `  --${prefix}-${key}: ${value};`);
  const shared = [
    ...values('mw-segments', { views: 3, review: 2 }),
    ...px('mw-space', t.space),
    ...px('mw-breakpoint', t.breakpoint),
    `  --mw-progress-gradient: ${t.progressGradient};`,
    ...px('mw-detail', t.detail),
    ...px('mw-size', t.size),
    ...values('mw-weight', t.weight),
    ...values('mw-opacity', t.opacity),
    ...Object.entries(t.motion)
      .filter(([name]) => name !== 'initialOpacity')
      .map(([name, ms]) => `  --mw-motion-${name}: ${ms}ms;`),
    ...values('mw-leading', t.leading),
    ...values('mw-relative', t.relative),
    ...values('mw-font', t.font),
    `  --mw-icon-size: ${t.icon.size}px;`,
    `  --mw-map-stroke: ${t.map.stroke};`,
    `  --mw-paper-width: ${printLayout.widthMm}mm;`,
    `  --mw-paper-height: ${printLayout.heightMm}mm;`,
    `  --mw-paper-line: ${printLayout.official.linePt}pt;`,
    `  --mw-paper-title: ${printLayout.official.titlePt}pt;`,
    `  --mw-paper-footer: ${printLayout.official.footerPt}pt;`,
    ...Object.entries(printLayout.standard).map(
      ([key, value]) => `  --mw-print-${key}: ${value}${key.endsWith('Pt') ? 'pt' : ''};`,
    ),
    ...px('mw-map', {
      border: t.map.card.border,
      'pad-x': t.map.card.padX,
      'pad-y': t.map.card.padY,
      'tight-x': t.map.card.tightX,
      'tight-y': t.map.card.tightY,
      'dense-y': t.map.card.denseY,
      gap: t.map.card.gap,
      fold: t.map.card.fold,
      'small-fold': t.map.card.smallFold,
    }),
    `  --mw-map-prefix-max: ${100 * t.map.card.prefixShare}%;`,
  ];
  function theme(style: keyof typeof editorStyles, name: 'light' | 'dark') {
    const visual = editorStyles[style];
    const declarations = [
      ...Object.entries(visual.colors).map(([key, color]) => `  --${key}: ${color[name]};`),
      ...Object.entries(visual.shadow).map(
        ([key, shadow]) => `  --shadow-${key}: ${shadow[name]};`,
      ),
    ];
    if (name === 'light') {
      declarations.push(
        ...Object.entries(visual.type).flatMap(([key, font]) => px(`mw-${key}`, font)),
        ...px('mw-radius', visual.radius),
        ...px('mw-size', visual.controlSize),
        ...px('mw-detail', visual.controlInset),
        ...px('mw-ordinal', { size: visual.manuscript.ordinalSize }),
        ...px('mw-map-chapter', { size: visual.manuscript.chapterSize }),
        ...px('mw-map-check', { size: visual.manuscript.checkSize }),
      );
    }
    return `${name === 'dark' ? 'body[data-ds-dark-theme] ' : ''}.mw-app[data-mw-style="${style}"] {\n${declarations.join('\n')}\n}\n`;
  }
  const rules = source.replace(
    /(@container\s*\([\w-]+:\s*)var\(--mw-breakpoint-(\w+)\)/g,
    (_, start, key: string) => {
      if (!Object.hasOwn(breakpoints, key)) throw Error(`Unknown container breakpoint: ${key}`);
      return start + breakpoints[key as keyof typeof breakpoints] + 'px';
    },
  );
  const chat = (dark: boolean) =>
    `${dark ? 'body[data-ds-dark-theme] ' : ''}.mw-chat-integrity { --error-border: ${t.colors['status-conflict-bar'][dark ? 'dark' : 'light']}; --mw-detail-hairline: ${t.detail.hairline}px; --mw-radius-main: ${t.radius.main}px; --mw-space-regular: ${space.regular}px; --mw-space-medium: ${space.medium}px; --mw-body-line: ${type.body.line}px; }\n`;
  const reviewQuote = (name: 'light' | 'dark') =>
    `${name === 'dark' ? 'body[data-ds-dark-theme] ' : ''}[data-mw-review-quote] { ${(['status-pending-text', 'status-pending-bg', 'status-pending-bar'] as const).map((key) => `--${key}: ${t.colors[key][name]};`).join(' ')} --mw-detail-hairline: ${t.detail.hairline}px; }\n`;
  return (
    `.mw-app {\n${shared.join('\n')}\n}\n` +
    (Object.keys(editorStyles) as (keyof typeof editorStyles)[])
      .map((style) => theme(style, 'light') + theme(style, 'dark'))
      .join('') +
    chat(false) +
    chat(true) +
    reviewQuote('light') +
    reviewQuote('dark') +
    rules
  );
}
