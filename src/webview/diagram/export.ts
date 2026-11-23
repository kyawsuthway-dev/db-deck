// Export the diagram as a standalone SVG (theme colors written in, so it looks the same outside VS Code) or
// as a PNG drawn from that SVG at 2×. The image is loaded from a blob: URL, which the diagram panel's CSP
// allows for images only.
import type { Box } from './geometry';

const SVG = 'http://www.w3.org/2000/svg';
/** Presentation properties copied from the live diagram, where CSS variables are resolved. */
const PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'display', 'visibility'];
const MARGIN = 24;
/** Browsers refuse bigger canvases; large diagrams are scaled down to fit. */
const MAX_CANVAS = 16000;

/** The diagram (`world`) cut to `area`, as SVG text with every color inlined. */
export function toSvg(world: SVGGElement, area: Box, background: string): string {
  const clone = world.cloneNode(true) as SVGGElement;
  const live = [world, ...Array.from(world.querySelectorAll('*'))];
  const copied = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const hits: Element[] = [];
  live.forEach((el, i) => {
    const target = copied[i] as SVGElement;
    // Hover targets are invisible but wide: left out of the file.
    if (el.classList.contains('edge-hit')) hits.push(target);
    const style = getComputedStyle(el);
    for (const p of PROPS) {
      const v = style.getPropertyValue(p);
      if (v) target.style.setProperty(p, v);
    }
    target.removeAttribute('class');
    target.removeAttribute('data-vscode-context');
    target.removeAttribute('data-table');
    target.removeAttribute('data-group');
  });
  for (const hit of hits) hit.remove();
  clone.removeAttribute('transform');
  const x = area.x - MARGIN;
  const y = area.y - MARGIN;
  const width = Math.ceil(area.width + MARGIN * 2);
  const height = Math.ceil(area.height + MARGIN * 2);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const bg = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x, y, width, height, fill: background })) bg.setAttribute(k, String(v));
  svg.append(bg, clone);
  return new XMLSerializer().serializeToString(svg);
}

/** The SVG text drawn into a canvas; resolves to the PNG as base64 (no data: prefix). */
export function toPng(svgText: string, width: number, height: number): Promise<string> {
  const scale = Math.min(2, MAX_CANVAS / Math.max(width, height));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('This view can’t draw images.');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The diagram couldn’t be drawn as an image.'));
    };
    img.src = url;
  });
}

/** Width and height of an SVG produced by `toSvg`. */
export function svgSize(svgText: string): { width: number; height: number } {
  const m = /width="(\d+)" height="(\d+)"/.exec(svgText);
  return { width: Number(m?.[1] ?? 800), height: Number(m?.[2] ?? 600) };
}
