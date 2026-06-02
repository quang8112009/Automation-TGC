# Design System Master File — AutoTGC (Thanh Giang) · "Academia" Redesign

> **LOGIC:** When building a specific page, first check `design-system/autotgc---thanh-giang/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file. Otherwise follow the rules below.

---

**Project:** AutoTGC — Thanh Giang (XKLĐ / labor-export marketing + recruitment platform)
**Redesign:** v2 "Academia" — prestige-university editorial aesthetic
**Generated:** 2026-06-01
**Category:** Academic-Editorial Operations Console
**Inspiration:** Harvard, MIT, Stanford, Oxford, Cambridge institutional web — scholarly, refined, confident, art-directed.

---

## North Star

A serious, beautiful operations console that feels like the digital home of a **prestigious institution**, not a generic SaaS dashboard. Calm ivory canvas, deep academic navy as the structural spine, an Oxford-crimson accent used sparingly with editorial confidence, and a refined serif display face (Crimson Pro) paired with a hyper-legible sans (Inter). The feel: scholarly authority + modern editorial layout + generous whitespace + crisp hairlines. Every screen should read like a well-set page in a university journal: clear hierarchy, drop-cap-worthy headlines, quiet motion, and zero cheap ornament.

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable | Usage |
|------|-----|--------------|-------|
| Primary (Academic Navy) | `#0F1E3D` | `--color-primary` | Sidebar spine, headings, structural elements |
| Primary-700 | `#16294f` | `--color-primary-700` | Hover/darker navy |
| Secondary (Slate Blue) | `#334766` | `--color-secondary` | Secondary text, chart series |
| Accent (Oxford Crimson) | `#8C1D27` | `--color-accent` | THE primary action / brand accent (editorial, sparing) |
| Accent-hover | `#6E141C` | `--color-accent-hover` | Crimson hover |
| Gold (Prestige) | `#B08542` | `--color-gold` | Highlights, awards, "this matters" series, dividers |
| Background (Ivory) | `#F7F4EF` | `--color-background` | App canvas (warm paper) |
| Surface | `#FFFFFF` | `--surface` | Cards, tables, modals |
| Text (Ink) | `#1A1A1A` | `--color-text` | Body ink on paper |

**Color Notes:** Navy structure + crimson editorial accent + gold prestige highlight on warm ivory paper. Crimson is rare and intentional (single CTA discipline). Gold is for hairline flourishes, active markers, and award/KPI emphasis — never as a fill on large areas.

### Neutral ramp (warm stone, not cold slate)

`--stone-50 #F7F4EF` · `--stone-100 #EFEAE1` · `--stone-200 #E3DCD0` · `--stone-300 #CDC3B4` · `--stone-400 #A89E8E` · `--stone-500 #82786A` · `--stone-600 #5E564B` · `--stone-700 #433D35` · `--stone-800 #2A2620` · `--stone-900 #181613`

### Typography

- **Display / Heading Font:** Crimson Pro (serif, scholarly). Weights 400/500/600/700.
- **Body / UI Font:** Inter (sans, hyper-legible). Weights 300/400/500/600/700.
- **Mono (IDs, codes, metrics):** IBM Plex Mono.
- **Mood:** academic, scholarly, editorial, refined, prestigious, timeless.
- **Google Fonts:**
```html
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

**Type scale** (editorial, larger display sizes for art-direction):
- Display H1 (page title, serif): 34px / 1.15, weight 600, letter-spacing -0.01em
- H2 (section, serif): 24px / 1.25, weight 600
- H3 (card title, serif): 18px / 1.3, weight 600
- Body: 15px / 1.6 (Inter)
- Small / table: 13px / 1.5
- Caption / label: 12px / 1.4, uppercase tracking 0.08em
- KPI number (serif): 40px / 1.0, weight 600

### Spacing Variables

`--space-xs 4px` · `--space-sm 8px` · `--space-md 16px` · `--space-lg 24px` · `--space-xl 32px` · `--space-2xl 48px` · `--space-3xl 64px`

Editorial breathing room: card padding 24–28px, section gaps 32px, page top→first-row 28px.

### Radius

Sharper, more editorial than the previous rounded look:
`--radius-sm 3px` · `--radius-md 6px` · `--radius-lg 8px` · `--radius-xl 12px` · `--radius-pill 9999px`

### Shadow Depths (soft, paper-like)

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(26,26,26,0.04)` | Subtle lift |
| `--shadow-md` | `0 4px 12px rgba(15,30,61,0.06)` | Cards, dropdowns |
| `--shadow-lg` | `0 12px 28px rgba(15,30,61,0.10)` | Modals, popovers |
| `--shadow-xl` | `0 24px 48px rgba(15,30,61,0.14)` | Hero / featured |

### Signature editorial devices (use tastefully)

- **Gold hairline accent** under page titles (a 2px gold rule, ~48px wide) — the "institutional underline".
- **Serif drop-style headlines** with a thin stone divider beneath section headers.
- **Crimson left-rule** (3px) on active nav and selected rows.
- **Small-caps tracked labels** for KPI/section captions.

---

## Component Specs (token-driven)

### Buttons

```css
/* Primary = Oxford crimson (the single editorial CTA) */
.btn-primary {
  background: var(--color-accent);
  color: #FFFFFF;                 /* white on #8C1D27 = ~8.9:1 PASS */
  border: 1px solid var(--color-accent);
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font-family: var(--font-body);
  font-weight: 600;
  transition: background 200ms ease, box-shadow 200ms ease;
  cursor: pointer;
}
.btn-primary:hover { background: var(--color-accent-hover); box-shadow: var(--shadow-sm); }

/* Secondary = navy outline */
.btn-secondary {
  background: transparent;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
}
.btn-secondary:hover { background: rgba(15,30,61,0.06); }
```

No layout-shifting transforms on hover — color + shadow only.

### Cards

```css
.card {
  background: var(--surface);
  border: 1px solid var(--stone-200);
  border-radius: var(--radius-lg);
  padding: 26px;
  box-shadow: var(--shadow-sm);
}
.card--interactive:hover { box-shadow: var(--shadow-md); border-color: var(--stone-300); cursor: pointer; }
```
Static info cards do NOT get cursor:pointer or transforms.

### Inputs

```css
.input {
  padding: 9px 13px;
  border: 1px solid var(--stone-300);
  border-radius: var(--radius-md);
  background: var(--surface);
  font-size: 15px;
}
.input:focus { border-color: var(--color-primary); outline: none; box-shadow: 0 0 0 3px rgba(15,30,61,0.15); }
```

### Modals

```css
.modal-overlay { background: rgba(15,30,61,0.45); backdrop-filter: blur(3px); }
.modal { background: var(--surface); border-radius: var(--radius-xl); padding: 32px; box-shadow: var(--shadow-xl); max-width: 560px; }
```

---

## Style Guidelines

**Style:** Editorial Grid / Magazine × Swiss Modernism 2.0 (both WCAG AAA, ⚡ excellent performance)

**Keywords:** scholarly, editorial, asymmetric grid, serif headlines, hairline rules, generous whitespace, refined, institutional, art-directed, timeless.

**Best For:** Operations consoles, knowledge platforms, institutional dashboards, anything that should feel prestigious and trustworthy.

**Key Effects:** quiet reveal-on-mount (≤300ms), KPI count-up, hover tint on rows, gold underline flourish, soft paper shadows, chart entrance ≤300ms, hover tooltips. Respect `prefers-reduced-motion`.

---

## Anti-Patterns (Do NOT Use)

- ❌ Cheap visuals, gaudy gradients-as-skin, glassmorphism, neon.
- ❌ Emojis as icons — use SVG (Lucide).
- ❌ Layout-shifting hovers (scale/translate that nudge neighbors).
- ❌ Missing cursor:pointer on clickables; cursor:pointer on static cards.
- ❌ Low-contrast text (< 4.5:1). Crimson/gold never used for long body text.
- ❌ Instant state changes (always 150–300ms transitions).
- ❌ Invisible focus states.
- ❌ More than one crimson CTA competing per view.
- ❌ Rainbow chart palettes — single coherent navy→slate→gold ramp.

---

## Pre-Delivery Checklist

- [ ] No emojis as icons (SVG/Lucide only)
- [ ] All icons from one set (Lucide)
- [ ] cursor:pointer on all clickable elements; not on static cards
- [ ] Hover states with smooth transitions (150–300ms), no layout shift
- [ ] Light mode text contrast ≥ 4.5:1 (crimson CTA white text, navy ink body)
- [ ] Focus states visible for keyboard nav
- [ ] prefers-reduced-motion respected
- [ ] Responsive: 375 / 768 / 1024 / 1440px
- [ ] No content hidden behind fixed topbar
- [ ] No horizontal scroll on mobile (tables scroll inside their card)
- [ ] Single font system: Crimson Pro (display) + Inter (body) + IBM Plex Mono (numerals); no stray hex outside :root
- [ ] Class names preserved across ~22 pages (restyle, never rename)
