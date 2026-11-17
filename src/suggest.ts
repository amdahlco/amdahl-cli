// src/suggest.ts
//
// "Did you mean …?" for a mistyped command, subcommand or connector: the
// closest known word within two edits, when exactly one is closest.

/** Levenshtein distance between `a` and `b`, with an adjacent swap counted as one edit. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min((d[i - 1]?.[j] ?? 0) + 1, (d[i]?.[j - 1] ?? 0) + 1, (d[i - 1]?.[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, (d[i - 2]?.[j - 2] ?? 0) + 1)
      ;(d[i] as number[])[j] = best
    }
  }
  return d[a.length]?.[b.length] ?? 0
}

/**
 * The candidate closest to `word` (case-insensitive), at most two edits away
 * (one for a word of four letters or fewer, so `nope` is not taken for `open`),
 * or a candidate that starts with it (`salesforc` → `salesforce`). Null when
 * nothing is that close, or two candidates tie.
 */
export function nearest(word: string, candidates: readonly string[]): string | null {
  const w = word.toLowerCase()
  if (!w) return null
  const max = w.length <= 4 ? 1 : 2
  let best: string | null = null
  let bestDistance = Infinity
  let tie = false
  for (const c of candidates) {
    const distance = editDistance(w, c.toLowerCase())
    if (distance < bestDistance) {
      best = c
      bestDistance = distance
      tie = false
    } else if (distance === bestDistance && c !== best) {
      tie = true
    }
  }
  if (best !== null && bestDistance <= max && !tie && bestDistance > 0) return best
  const prefixed = w.length >= 3 ? candidates.filter((c) => c.toLowerCase().startsWith(w)) : []
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null
}
