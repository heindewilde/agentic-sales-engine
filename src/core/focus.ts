/**
 * Focused excerpts: keep the paragraphs of a page that matter for the questions being researched, so the model
 * reads hundreds of words instead of thousands. The full page is still stored as the raw snapshot, so every quote
 * stays verifiable. Deterministic and provider-independent.
 */

const STOP = new Set(
  "the a an and or of to in on for with by at from is are was were be been this that these those it its as their our your we you they he she them his her not no do does did have has had will would can could should what which who whom whose when where why how about into over under than then there here also any all each per via".split(" "),
);

export function terms(focus: string): string[] {
  return [...new Set(focus.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

/**
 * Pick paragraphs by relevance to the focus terms (plus the page's opening, which usually says what the company
 * is), keep their original order, and stop at maxChars. Returns the full text when it already fits.
 */
export function focusText(text: string, focus: string, maxChars = 3000): string {
  if (text.length <= maxChars) return text;
  const t = terms(focus);
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!t.length) return text.slice(0, maxChars);
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    let hits = 0;
    for (const w of t) if (low.includes(w)) hits++;
    // prefer short, dense paragraphs; numbers often carry the facts we need
    const digits = /\d/.test(p) ? 0.3 : 0;
    return { i, p, score: hits / Math.sqrt(Math.max(1, p.length / 200)) + digits + (i === 0 ? 1 : 0) };
  });
  const keep = new Set<number>();
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (s.score <= 0.3 && keep.size > 0) break;
    const len = Math.min(s.p.length, 1200) + 2;
    if (used + len > maxChars) continue;
    keep.add(s.i);
    used += len;
  }
  const out = scored.filter((s) => keep.has(s.i)).map((s) => (s.p.length > 1200 ? `${s.p.slice(0, 1200)}…` : s.p));
  return `${out.join("\n\n")}\n\n[focused excerpt: ${out.length}/${paras.length} paragraphs; full page in raw_ref]`;
}
