/**
 * Prefixes every selector of a dictionary's stylesheet with `scope`, so each
 * dictionary's bundled CSS only affects its own definitions. Rules inside
 * at-rule blocks such as `@media` are scoped too; `@font-face`, `@keyframes`
 * and similar descriptor blocks are kept as they are. Selector lists are split
 * on every comma, so a comma inside an attribute value is not supported.
 */
export function scopeCss(css: string, scope: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let index = 0;
  // Depth of blocks whose contents are not selectors (font-face, keyframes, ...).
  let opaqueDepth = 0;
  let depth = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    const close = source.indexOf('}', index);
    if (open < 0 && close < 0) {
      out += source.slice(index);
      break;
    }
    if (close >= 0 && (open < 0 || close < open)) {
      out += source.slice(index, close + 1);
      index = close + 1;
      depth -= 1;
      if (opaqueDepth > depth) opaqueDepth = 0;
      continue;
    }
    const prelude = source.slice(index, open);
    const trimmed = prelude.trim();
    depth += 1;
    if (opaqueDepth > 0 || trimmed === '') {
      out += prelude + '{';
    } else if (trimmed.startsWith('@')) {
      if (!/^@(media|supports|container|layer)\b/i.test(trimmed)) opaqueDepth = depth;
      out += prelude + '{';
    } else {
      const leading = prelude.slice(0, prelude.length - prelude.trimStart().length);
      const scoped = trimmed
        .split(',')
        .map((selector) => `${scope} ${selector.trim()}`)
        .join(', ');
      out += `${leading}${scoped} {`;
    }
    index = open + 1;
  }
  return out;
}
