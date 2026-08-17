/**
 * Indent inference (§7). The indent unit is read from the file, never
 * configured: the most common leading-whitespace delta between
 * consecutively-nested lines. Falls back to two spaces for a file with no
 * nesting. Tab files naturally infer '\t' because that's the dominant delta.
 */
export function inferIndentUnit(lines) {
  const counts = new Map();
  let prev = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const ws = /^[ \t]*/.exec(line)[0];
    if (prev !== null && ws.length > prev.length && ws.startsWith(prev)) {
      const delta = ws.slice(prev.length);
      counts.set(delta, (counts.get(delta) ?? 0) + 1);
    }
    prev = ws;
  }
  let best = null;
  let bestCount = 0;
  for (const [delta, count] of counts) {
    if (count > bestCount) {
      best = delta;
      bestCount = count;
    }
  }
  return best ?? '  ';
}
