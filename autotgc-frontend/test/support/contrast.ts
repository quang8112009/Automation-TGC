/**
 * Test-support: pure WCAG 2.1 relative-luminance contrast ratio.
 *
 * Used by Property 5 (Feature: frontend-ui-redesign) to verify every real theme
 * token pair meets WCAG AA. This is test-only code — it is NOT a UI/CSS
 * framework and never ships in the runtime bundle (Requirement 11.1).
 *
 * Formulae per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio.
 */

/** Parse a #rgb or #rrggbb hex string into [r, g, b] (0–255 each). */
export function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.trim().replace(/^#/, '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const int = parseInt(full, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/** Linearize a single 0–255 channel to its sRGB-linear value. */
function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an [r, g, b] color (0–1). */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/**
 * WCAG contrast ratio between two hex colors. Symmetric, and always within
 * [1, 21]. Pure and total for valid hex input.
 */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg));
  const l2 = relativeLuminance(hexToRgb(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A foreground/background token pair, with the WCAG "large text" relaxation. */
export interface ContrastPair {
  /** Token name (documentation only). */
  name: string;
  fg: string;
  bg: string;
  /** Large text (≥ 18px, or ≥ 14px bold) ⇒ AA threshold 3.0 instead of 4.5. */
  large: boolean;
}

/**
 * The real theme token pairs taken from `src/styles.css` :root (Dark Editorial).
 *
 * Text roles on the two dark canvases (background + surface), button labels on
 * their solid fills, each status -fg on its -bg, and the gold-text role on both
 * canvases. The status -bg tokens are dark-translucent rgba() in the stylesheet;
 * here they are mirrored as the OPAQUE hex they composite to over `--surface`
 * (#161714), which is the visible background a badge label actually sits on — so
 * the contrast assertion matches what users see. If a token value changes, this
 * list must be updated to match (it is the assertion target for Property 5).
 */
export const AA_PAIRS: readonly ContrastPair[] = [
  // ---- Text roles on the app canvas (#101110) and on surface (#161714) ----
  { name: 'text-body / background', fg: '#D8D5CE', bg: '#101110', large: false },
  { name: 'text-body / surface', fg: '#D8D5CE', bg: '#161714', large: false },
  { name: 'text-muted / background', fg: '#9A968C', bg: '#101110', large: false },
  { name: 'text-muted / surface', fg: '#9A968C', bg: '#161714', large: false },
  { name: 'text-strong / background', fg: '#F4F2ED', bg: '#101110', large: false },
  { name: 'text-strong / surface', fg: '#F4F2ED', bg: '#161714', large: false },
  { name: 'text-faint / background', fg: '#88847B', bg: '#101110', large: false },
  { name: 'text-faint / surface', fg: '#88847B', bg: '#161714', large: false },

  // ---- Button/label text on the solid button fills ----
  { name: 'dark / primary pill (btn-primary)', fg: '#161714', bg: '#F4F2ED', large: false },
  { name: 'light / neutral-dark (btn-blue)', fg: '#F4F2ED', bg: '#1C1D1A', large: false },
  { name: 'white / danger (btn-danger)', fg: '#FFFFFF', bg: '#C8433C', large: false },

  // ---- Status: each -fg on its -bg composited over surface (badges / notices) ----
  { name: 'success-fg / success-bg', fg: '#7FD7A8', bg: '#1C2D23', large: false },
  { name: 'warning-fg / warning-bg', fg: '#E8C078', bg: '#322B1A', large: false },
  { name: 'danger-fg / danger-bg', fg: '#F0938C', bg: '#331F1C', large: false },
  { name: 'info-fg / info-bg (role-pill)', fg: '#9BBAF5', bg: '#202833', large: false },
  { name: 'neutral-fg / neutral-bg (badge)', fg: '#BDB9B0', bg: '#262724', large: false },

  // ---- Gold text role (eyebrow/kicker) on both canvases ----
  { name: 'gold-text / background', fg: '#E6B45A', bg: '#101110', large: false },
  { name: 'gold-text / surface', fg: '#E6B45A', bg: '#161714', large: false },
];
