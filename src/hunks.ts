import { structuredPatch } from 'diff';
export interface Hunk { oldStart: number; oldLines: number; lines: string[] }
export const norm = (s: string) => s.replace(/\r\n/g, '\n');
export function computeHunks(original: string, proposed: string): Hunk[] {
  return structuredPatch('a', 'b', norm(original), norm(proposed), '', '', { context: 3 }).hunks
    .map(h => ({ oldStart: h.oldStart, oldLines: h.oldLines, lines: h.lines.filter(l => !l.startsWith('\\')) }));
}
/** Original text with only the kept hunks applied (rejected hunks leave the original lines untouched). */
export function mergeHunks(original: string, hunks: Hunk[], keep: boolean[]): string {
  const lines = norm(original).split('\n'); const out: string[] = []; let cursor = 0;
  hunks.forEach((h, i) => {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    out.push(...lines.slice(cursor, start));
    out.push(...h.lines.filter(l => l[0] !== (keep[i] ? '-' : '+')).map(l => l.slice(1)));
    cursor = start + h.oldLines;
  });
  out.push(...lines.slice(cursor));
  return out.join('\n');
}
