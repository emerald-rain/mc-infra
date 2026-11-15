/*
 * Kladnash pixel lettering ("KLADNASH", "START", "STOP").
 * 5-row bitmap font, letters 4 px wide (T is 3), 1 px between letters.
 * Colours: rows 0-2 yellow #f8c442, rows 3-4 orange #f17226,
 * plus a hard drop shadow offset +1,+1 in outline brown #893f34 (drawn first, underneath).
 * Only the letters used in the design are defined; add more in the same 5-row style.
 *
 *   renderWord('KLADNASH', { cell: 5 })  -> the 200x30 wordmark in the log header
 *   renderWord('START', { cell: 3 })     -> 69x18 session marker
 *   renderWord('STOP', { cell: 3 })      -> 57x18 session marker
 */
export const GLYPHS = {
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#...", "#...", "#...", "#...", "####"],
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  H: ["#..#", "#..#", "####", "#..#", "#..#"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "###.", "#...", "#..."]
};

export const PIXEL_COLORS = { top: '#f8c442', bottom: '#f17226', shadow: '#893f34' };

/** Returns the pixel map { w, h, px: Set of "x,y" } for a word (without shadow). */
export function wordPixels(text) {
  const px = new Set();
  let x = 0;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (!g) throw new Error('No pixel glyph for ' + ch);
    g.forEach((row, y) => [...row].forEach((c, i) => { if (c === '#') px.add((x + i) + ',' + y); }));
    x += g[0].length + 1;
  }
  return { w: x - 1, h: 5, px };
}

/** SVG markup: viewBox in pixels (+1 for the shadow), scaled by `cell` screen px per pixel. */
export function renderWord(text, { cell = 3, label = text } = {}) {
  const { w, h, px } = wordPixels(text);
  const W = w + 1, H = h + 1;
  const runs = (set, dx, dy, rows, fill) => {
    let out = '';
    for (const y of rows) {
      let x = 0;
      while (x < W) {
        if (!set.has((x - dx) + ',' + (y - dy))) { x++; continue; }
        const s = x;
        while (x < W && set.has((x - dx) + ',' + (y - dy))) x++;
        out += `<rect x="${s}" y="${y}" width="${x - s}" height="1" fill="${fill}"></rect>`;
      }
    }
    return out;
  };
  // shadow: the same pixels shifted +1,+1, drawn first so the letters sit on top of it
  const shadow = new Set([...px].map((p) => { const [a, b] = p.split(',').map(Number); return (a + 1) + ',' + (b + 1); }));
  const sh = runs(shadow, 0, 0, [...Array(H).keys()], PIXEL_COLORS.shadow);
  const top = runs(px, 0, 0, [0, 1, 2], PIXEL_COLORS.top);
  const bottom = runs(px, 0, 0, [3, 4], PIXEL_COLORS.bottom);
  return `<svg width="${W * cell}" height="${H * cell}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img" aria-label="${label}">${sh}${top}${bottom}</svg>`;
}
