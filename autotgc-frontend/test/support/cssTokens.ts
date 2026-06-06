/**
 * Test-support: a tiny, pure CSS-custom-property parser + alias resolver.
 *
 * Backs Property 6 (Feature: frontend-ui-redesign): every alias token in the
 * `:root` block of `src/styles.css` must resolve, through any chain of
 * `var(--…)` references, to a base token holding a literal value — with no
 * dangling references and no cycles. Test-only; ships nothing to runtime.
 */

/** Map of token name (without leading `--`) → its raw declared value. */
export type TokenMap = Record<string, string>;

/**
 * Parse the first `:root { … }` block of a stylesheet into a TokenMap of its
 * custom properties (`--name: value;`). Only `--*` declarations are captured;
 * ordinary properties (e.g. `font-family`) are ignored. Pure: same input always
 * yields the same map.
 */
export function parseRootTokens(css: string): TokenMap {
  const rootStart = css.indexOf(':root');
  if (rootStart === -1) return {};
  const braceStart = css.indexOf('{', rootStart);
  if (braceStart === -1) return {};

  // Walk to the matching closing brace (the :root block has no nested braces).
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return {};

  const body = css.slice(braceStart + 1, end);
  // Strip block comments so commented-out declarations are not captured.
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '');

  const tokens: TokenMap = {};
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(withoutComments)) !== null) {
    const name = match[1].slice(2); // drop leading "--"
    tokens[name] = match[2].trim();
  }
  return tokens;
}

/** A `var(--token)` reference appearing inside a value, if any (first match). */
const VAR_REF_RE = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/;

/** Does this token value reference another token via `var(--…)`? */
export function isAliasValue(value: string): boolean {
  return VAR_REF_RE.test(value);
}

export interface ResolveResult {
  /** Final literal value the chain terminates at. */
  value: string;
  /** Whether resolution succeeded (terminates at a literal, no cycle). */
  resolved: boolean;
  /** Reason for failure, when `resolved` is false. */
  reason?: 'dangling' | 'cycle';
  /** The ordered chain of token names visited (for diagnostics). */
  chain: string[];
}

/**
 * Resolve a token `name` through its `var(--…)` chain in `tokenMap` to a literal
 * value. Pure and total: never throws. Detects dangling references (a `var()`
 * pointing at an undefined token) and cycles, reporting them rather than looping
 * forever.
 *
 * A value may embed a `var()` among other text (e.g. a shadow). Resolution
 * follows the *first* `var()` reference: in this token layer every alias is a
 * pure single-reference indirection, which is exactly what the property asserts.
 */
export function resolveToken(name: string, tokenMap: TokenMap): ResolveResult {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = name;

  for (;;) {
    if (seen.has(current)) {
      return { value: '', resolved: false, reason: 'cycle', chain };
    }
    seen.add(current);
    chain.push(current);

    const value = tokenMap[current];
    if (value === undefined) {
      return { value: '', resolved: false, reason: 'dangling', chain };
    }

    const ref = VAR_REF_RE.exec(value);
    if (!ref) {
      // Literal value — chain terminates here.
      return { value, resolved: true, chain };
    }
    current = ref[1].slice(2); // follow the referenced token (drop "--")
  }
}
