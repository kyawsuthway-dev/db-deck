// Line icons for the webviews, drawn here so no icon package is needed (core.md rule 7).
// 16×16, stroked with currentColor, so they follow the theme. Paths are constants, never data.

const PATHS = {
  database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  fileDb: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8.5h4M6 11h4',
  globe: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM1.5 8h13M8 1.5c1.8 1.8 2.6 4 2.6 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.4 5.5 5.4 8s.8 4.7 2.6 6.5',
  hash: 'M6.5 2L5 14M11 2L9.5 14M2.5 5.5h11M2 10.5h11',
  user: 'M8 8a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  key: 'M10.5 1.5a4 4 0 1 0 0 8a4 4 0 0 0 0-8zM7.7 8.3L1.5 14.5M3.5 12.5l2 2M5 11l1.5 1.5M11.5 4.5h.01',
  lock: 'M3.5 7h9v7.5h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 10v2',
  link: 'M6.5 9.5l3-3M7 4.5l1.2-1.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5',
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z',
  folderOpen: 'M1.5 13.5v-10h4.5l1.5 1.5h6V7M1.5 13.5l2-6h11l-2 6z',
  palette: 'M8 1.5a6.5 6.5 0 1 0 0 13c1 0 1.5-.6 1.5-1.4 0-1.1-1-1.4-1-2.3 0-.8.6-1.3 1.5-1.3h1.8c1.8 0 3.2-1.4 3.2-3.2C15 3.9 11.8 1.5 8 1.5zM4.75 8h.01M6 4.75h.01M9.75 4.5h.01',
  tunnel: 'M2 5.5h10M9.5 3L12 5.5 9.5 8M14 10.5H4M6.5 8L4 10.5 6.5 13',
  plug: 'M5.5 1.5V5M10.5 1.5V5M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v2.5',
  shield: 'M8 1.5l5.5 2v4.5c0 3.3-2.4 5.6-5.5 6.5-3.1-.9-5.5-3.2-5.5-6.5V3.5z',
  check: 'M3 8.5l3 3 7-7',
  close: 'M4 4l8 8M12 4l-8 8',
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4a2 2 0 0 0 0 4z',
  eyeOff: 'M2 2l12 12M6.6 3.7c.4-.1.9-.2 1.4-.2 4.1 0 6.5 4.5 6.5 4.5s-.7 1.3-1.9 2.5M10.6 11.9c-.8.4-1.7.6-2.6.6-4.1 0-6.5-4.5-6.5-4.5s.8-1.5 2.4-2.8M6.6 6.6a2 2 0 0 0 2.8 2.8',
  plus: 'M8 3v10M3 8h10',
  alert: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM8 4.5v4.25M8 11.25h.01',
  checkCircle: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM5 8.2l2 2 4-4',
  info: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM8 7.25v4M8 4.75h.01',
  spinner: 'M8 1.5a6.5 6.5 0 1 1-6.5 6.5',
  table: 'M2 2.5h12v11H2zM2 6h12M2 9.75h12M6.5 6v7.5',
  rows: 'M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7',
  structure: 'M2.5 2.5h4v4h-4zM9.5 9.5h4v4h-4zM4.5 6.5v5h5M9.5 4.5h4M11.5 2.5v4',
  search: 'M7 2a5 5 0 1 0 0 10a5 5 0 0 0 0-10zM10.6 10.6L14 14',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  save: 'M8 2v8M4.75 6.75L8 10l3.25-3.25M2.5 11v2.5h11V11',
  play: 'M4.5 2.5v11l9-5.5z',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4M6.75 6.5v5M9.25 6.5v5',
  warning: 'M8 1.75L14.75 14H1.25zM8 6v3.75M8 12h.01',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3',
} as const;

export type IconName = keyof typeof PATHS;

const SVG = 'http://www.w3.org/2000/svg';

/** An icon element. Decorative (aria-hidden): the text next to it carries the meaning. */
export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name}${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

