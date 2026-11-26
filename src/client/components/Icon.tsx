import { styleTokens } from '../../style-tokens.ts';
import React from 'react';
/** Mindwrite's single, local line-icon set; all symbols share a 24px grid and stroke. */
const paths = {
  warning: 'M12 3L2 21h20L12 3zM12 9v5M12 17v.01',
  question:
    'M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 17-5M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 16h.01',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  right: 'M9 5l7 7-7 7',
  left: 'M15 5l-7 7 7 7',
  down: 'M5 9l7 7 7-7',
  edit: 'M14 5l5 5M4 20l5-1L20 8l-4-4L5 15z',
  note: 'M5 3h14v13l-5 5H5zM14 21v-5h5M8 7h8M8 11h6',
  body: 'M5 5h14M5 10h14M5 15h14M5 20h9',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  help: 'M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  undo: 'M8 4L3 9l5 5M3 9h11a6 6 0 0 1 0 12',
  redo: 'M16 4l5 5-5 5M21 9H10a6 6 0 0 0 0 12',
  fit: 'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6',
  locate: 'M12 2v4M12 18v4M2 12h4M18 12h4M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  child: 'M5 3v10a2 2 0 0 0 2 2h11M14 10l5 5-5 5',
  sibling: 'M4 6h15M4 12h9M4 18h6M18 13v8M14 17h8',
  moveTo: 'M3 7V5h7l2 3h9v11H3v-5M2 11h11m-3-3 3 3-3 3',
  map: 'M3 10h5v4H3zM16 3h5v5h-5zM16 16h5v5h-5zM8 12h4V6h4M12 12v6h4',
  comparison: 'M3 4h18v16H3zM12 4v16M6 9h3M15 9h3M6 14h3M15 14h3',
  selection: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 12l3 3 6-7',
  history: 'M3 5v5h5M4 9a9 9 0 1 1 0 7M12 7v5l4 2',
  quote: 'M3 5h18v12H9l-5 4v-4H3zM7 8h3l-2 5M13 8h3l-2 5',
  import: 'M5 3h9l5 5v13H5v-4M14 3v6h5M2 12h10m-3-3 3 3-3 3',
  ai: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  arrowUp: 'M12 20V4M5 11l7-7 7 7',
  arrowDown: 'M12 4v16M5 13l7 7 7-7',
  copy: 'M8 8h12v13H8zM16 5V3H3v13h2',
  paste: 'M8 5H5v16h14V5h-3M9 3h6v4H9z',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  briefcase: 'M3 8h18v12H3zM8 8V5h8v3M3 12l9 3 9-3',
  shorten: 'M3 6h18M6 12h12M9 18h6',
  check: 'M5 12l4 4L19 6',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="mw-icon"
      viewBox="0 0 24 24"
      width={styleTokens.icon.size}
      height={styleTokens.icon.size}
      fill="none"
      stroke="currentColor"
      strokeWidth={styleTokens.icon.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
