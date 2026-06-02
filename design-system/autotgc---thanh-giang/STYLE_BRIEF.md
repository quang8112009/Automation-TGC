# STYLE BRIEF — AutoTGC (Thanh Giang) · "Academia" Redesign

> **Authority chain:** `MASTER.md` defines the tokens and the law. This brief
> **operationalizes** MASTER into build-ready, plain-CSS instructions and never
> contradicts it. If a `pages/[page-name].md` override exists for a page, it wins
> over both. Light mode only.
>
> **Stack reality:** React 18 + Vite + a single global `src/styles.css`. **No
> Tailwind, no CSS-in-JS.** Everything below is authored as `:root` custom
> properties + plain selectors. **Restyle, never rename** the ~22 pages' classes.
>
> **Language:** Product UI stays **Vietnamese**. This brief is the design contract;
> UI labels ("Đơn hàng", "Ứng viên", "Xu hướng", "Thu gọn", …) are not translated.

---

## 1. North Star

AutoTGC should feel like the digital home of a **prestigious institution** — a
university press journal that happens to run a labor-export (XKLĐ) recruitment and
marketing operation — not a generic SaaS dashboard. The canvas is warm ivory paper,
the structural spine is deep **Academic Navy (#0F1E3D)**, **Oxford Crimson (#8C1D27)**
is the single editorial action color used with discipline, and **Prestige Gold
(#B08542)** appears only as a rare hairline flourish (the "institutional underline").
Typography carries the prestige: a refined serif display face (**Crimson Pro**) for
headlines and KPI numerals, **Inter** for hyper-legible body and dense tables, and
**IBM Plex Mono** for IDs, codes, and aligned metrics. Every screen reads like a
well-set page — confident hierarchy, generous whitespace, crisp hairlines, and quiet
motion — so an operator scanning leads and content feels the same calm authority they
would on a leading university's site. Reference grounding (paraphrased): leading
institutional sites pair an editorial serif for display with a clean sans for body,
discipline their palette to two or three institutional colors, and lean on heraldry/
wordmark consistency and whitespace rather than ornament
([Stanford typography](https://identity.stanford.edu/), [Yale heraldry](https://yaleidentity.yale.edu/guidelines/heraldry), [Harvard GSD editorial-serif options](https://sites.gsd.harvard.edu/global-options/typography/)). *Content was rephrased for compliance with licensing restrictions.*

---

## 2. Complete `:root` Token Block

Replace the **entire** existing `:root` in `src/styles.css` with the block below.
It is a faithful operationalization of MASTER: same hexes, expanded into the surface/
border/text/status/layout roles the pages already consume, **plus** back-compat
aliases so legacy token names used inline across pages keep resolving. Drop-in.

```css
:root {
  /* ============================================================ BRAND
     (MASTER — Academia. DO NOT change these hexes.) */
  --color-primary:        #0F1E3D;  /* Academic Navy — sidebar spine, headings, structure */
  --color-primary-700:    #16294F;  /* darker/hover navy */
  --color-primary-hover:  #16294F;  /* legacy alias → navy hover */
  --color-secondary:      #334766;  /* Slate Blue — secondary text, chart series */
  --color-accent:         #8C1D27;  /* Oxford Crimson — THE single CTA / brand accent */
  --color-accent-hover:   #6E141C;  /* crimson hover */
  --color-gold:           #B08542;  /* Prestige Gold — hairline flourish, active marker, KPI emphasis */
  --color-gold-soft:      #EBDFC6;  /* gold tint for rare soft fills (≤AA on text avoided) */
  --color-background:     #F7F4EF;  /* warm ivory paper — app canvas */
  --color-text:           #1A1A1A;  /* ink on paper */

  /* ---- Legacy CTA aliases → now crimson (pages reference --color-cta) ---- */
  --color-cta:            var(--color-accent);
  --color-cta-hover:      var(--color-accent-hover);

  /* ============================================ NEUTRAL RAMP (warm stone) */
  --stone-50:  #F7F4EF;
  --stone-100: #EFEAE1;
  --stone-200: #E3DCD0;
  --stone-300: #CDC3B4;
  --stone-400: #A89E8E;
  --stone-500: #82786A;
  --stone-600: #5E564B;
  --stone-700: #433D35;
  --stone-800: #2A2620;
  --stone-900: #181613;

  /* ---- Legacy gray-* aliases → mapped onto the warm stone ramp so any page
          still using --gray-N inherits the academic neutrals automatically. */
  --gray-50:  var(--stone-50);
  --gray-100: var(--stone-100);
  --gray-200: var(--stone-200);
  --gray-300: var(--stone-300);
  --gray-400: var(--stone-400);
  --gray-500: var(--stone-500);
  --gray-600: var(--stone-600);
  --gray-700: var(--stone-700);
  --gray-800: var(--stone-800);
  --gray-900: var(--stone-900);

  /* ================================================ SURFACES & BORDERS */
  --surface:          #FFFFFF;   /* cards, tables, modals */
  --surface-raised:   #FFFFFF;   /* popovers/panels */
  --surface-sunken:   #FBF9F5;   /* inset wells, zebra, disabled inputs (ivory-tinted) */
  --surface-hover:    #F4F0E9;   /* row/control hover tint (warm) */
  --surface-active:   #F0EFF4;   /* selected/active wash (cool navy tint on ivory) */
  --border:           var(--stone-200);   /* default hairline */
  --border-strong:    var(--stone-300);   /* emphasized hairline / table head rule */

  /* ---- Sidebar (Academic Navy spine) ---- */
  --sidebar-bg:        #0F1E3D;  /* Academic Navy */
  --sidebar-bg-raised: #16294F;  /* group hovers/active fill on navy */
  --sidebar-fg:        #C9D2E2;  /* legible cool-gray on navy (~9:1) */
  --sidebar-fg-muted:  #7F8CA6;  /* group labels / inactive detail */
  --sidebar-active-bg: #16294F;  /* active item fill */
  --sidebar-active-fg: #FFFFFF;  /* active item text */
  --sidebar-accent:    var(--color-accent);  /* crimson left-rule on active */
  --sidebar-brand-gold:var(--color-gold);     /* gold brand mark accent */

  /* ====================================================== TEXT ROLES */
  --text-strong: #1A1A1A;  /* ink — headings, KPI, primary cells */
  --text-body:   #2A2620;  /* stone-800 — body copy, default cell text */
  --text-muted:  #5E564B;  /* stone-600 — captions, secondary (≥7:1 on ivory) */
  --text-faint:  #82786A;  /* stone-500 — placeholders, disabled hints (≥4.5:1) */
  --text-on-dark:#F7F4EF;  /* ivory text on navy */
  --text-link:   var(--color-accent);        /* crimson links (editorial) */
  --text-link-hover: var(--color-accent-hover);

  /* ============================== STATUS (base / soft-bg / on-soft fg)
     Tuned for the ivory canvas; *-fg values clear ≥4.5:1 on their *-bg. */
  --success: #2E7D5B;  --success-bg: #E2F0E8;  --success-fg: #1F5C42;
  --warning: #B08542;  --warning-bg: #F3E9D6;  --warning-fg: #7A5A21;  /* warm/gold-leaning */
  --danger:  #B3261E;  --danger-bg:  #F6E1DF;  --danger-fg:  #8C1D27;  /* crimson family */
  --info:    #334766;  --info-bg:    #E6EAF0;  --info-fg:    #243349;  /* slate-blue */
  --neutral: #A89E8E;  --neutral-bg: #EFEAE1;  --neutral-fg: #433D35;  /* warm stone */

  /* =========================================================== SPACING */
  --space-xs: 4px;  --space-sm: 8px;  --space-md: 16px;
  --space-lg: 24px; --space-xl: 32px; --space-2xl: 48px; --space-3xl: 64px;

  /* ============================================= RADIUS (sharper/editorial) */
  --radius-sm:   3px;
  --radius-md:   6px;
  --radius-lg:   8px;
  --radius-xl:   12px;
  --radius-pill: 9999px;

  /* ====================================== SHADOWS (soft, paper-like) */
  --shadow-sm: 0 1px 2px rgba(26,26,26,0.04);
  --shadow-md: 0 4px 12px rgba(15,30,61,0.06);
  --shadow-lg: 0 12px 28px rgba(15,30,61,0.10);
  --shadow-xl: 0 24px 48px rgba(15,30,61,0.14);
  --shadow-focus: 0 0 0 3px rgba(15,30,61,0.15);   /* navy focus ring */
  --shadow-focus-crimson: 0 0 0 3px rgba(140,29,39,0.22); /* for crimson controls */

  /* ======================================================= TYPOGRAPHY */
  --font-display: 'Crimson Pro', Georgia, 'Times New Roman', serif;  /* H1–H3, KPI numbers */
  --font-heading: var(--font-display);   /* legacy alias → now serif display */
  --font-body:    'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono:    'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace;

  /* Type scale (editorial — serif display sizes per MASTER) */
  --fs-display: 40px;  --lh-display: 44px;   /* hero / oversized serif (1.0) */
  --fs-h1:      34px;  --lh-h1:      39px;   /* page title — serif 600, -0.01em */
  --fs-h2:      24px;  --lh-h2:      30px;   /* section — serif 600 */
  --fs-h3:      18px;  --lh-h3:      24px;   /* card title — serif 600 */
  --fs-body:    15px;  --lh-body:    24px;   /* Inter body 1.6 */
  --fs-sm:      13px;  --lh-sm:      20px;   /* tables / dense */
  --fs-xs:      12px;  --lh-xs:      17px;   /* captions / small-caps labels */
  --fs-kpi:     40px;  --lh-kpi:     40px;   /* KPI number — serif 600, 1.0 */

  --tracking-label: 0.08em;  /* small-caps section/KPI labels */
  --tracking-tight: -0.01em; /* serif display negative tracking */

  --fw-light: 300; --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;

  /* ============================================================ MOTION
     Editorial reveals are slow & quiet (400–600ms); UI micro-interactions
     stay snappy (150–300ms). Both respect prefers-reduced-motion. */
  --ease:          cubic-bezier(0.4, 0, 0.2, 1);     /* standard UI */
  --ease-editorial:cubic-bezier(0.22, 1, 0.36, 1);   /* slow reveal (easeOutQuint-ish) */
  --dur-fast:   150ms;   /* hover tint, focus */
  --dur-base:   200ms;   /* buttons, inputs */
  --dur-slow:   300ms;   /* row select, chart bars, micro-interaction ceiling */
  --dur-reveal: 480ms;   /* page/section mount reveal (editorial) */
  --dur-reveal-lg: 600ms;/* hero/featured reveal */

  /* ============================================================ LAYOUT */
  --sidebar-w:           256px;
  --sidebar-w-collapsed: 64px;
  --topbar-h:            64px;   /* roomier editorial topbar */
  --content-max:         1320px; /* editorial measure (1280–1440 band) */
  --content-max-wide:    1440px; /* opt-in for data-dense full-bleed pages */
  --content-pad:         32px;   /* generous page gutter (collapses on mobile) */

  /* ============================================ BACK-COMPAT ALIASES
     (legacy token names referenced by pages / inline styles) */
  --bg: var(--color-background);
  --text: var(--text-strong);
  --primary: var(--color-primary);
  --sidebar-text: var(--sidebar-fg);
  --sidebar-active: var(--sidebar-active-bg);
  --radius: var(--radius-md);
  --shadow: var(--shadow-sm);

  font-family: var(--font-body);
  color-scheme: light;
}
```

**Base element rules to update alongside the token swap** (these already exist —
only the values change):

```css
body {
  background: var(--color-background);
  color: var(--text-body);
  font-family: var(--font-body);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}

/* Headings now serif display. */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display);
  color: var(--text-strong);
  font-weight: var(--fw-semibold);
  line-height: 1.2;
  letter-spacing: var(--tracking-tight);
}

a { color: var(--text-link); }
a:hover { color: var(--text-link-hover); text-decoration: underline; text-underline-offset: 2px; }

/* Mono numerals helper — unchanged contract, now IBM Plex Mono. */
.mono, code, .kpi-num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
```
---

## 3. Layout & Density — Editorial Grid

The console keeps its `app-shell` (sidebar + `.main` with `.topbar` + `.content`).
Density is **editorial, not cramped**: generous gutters, hairline separators, and a
clear page rhythm. Target rhythm top-to-bottom per page:

```
[ content gutter 32px ]
  .page-header        → serif H1 + GOLD hairline underline flourish + actions row
[ 28px ]
  first .section / KPI grid
[ section gaps 32px between blocks ]
```

### Content measure & grid
- `.content` centers children at `--content-max` (1320px). Data-dense pages (tables
  with many columns) may opt into `--content-max-wide` (1440px) via a page wrapper.
- Base grid is a 12-col mental model expressed with CSS Grid `auto-fit`/`minmax`
  (the existing `.grid-2` / `.grid-4` already do this — keep the contract, retune gaps).
- Section gap = `--space-xl` (32px). Card padding = 26px (MASTER). KPI tiles 24px.

### Page-header pattern — the institutional underline
The signature device: a **2px Prestige Gold rule, ~48px wide**, sits directly under
the serif H1. Restyle `.page-header` / `.page-title` (do not add markup the pages
don't render — use `::after` on the title):

```css
.page-header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: var(--space-md); flex-wrap: wrap;
  margin-bottom: var(--space-xl);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border);   /* full-width hairline under the whole header */
}
.page-title {
  font-family: var(--font-display);
  font-size: var(--fs-h1); line-height: var(--lh-h1);
  font-weight: var(--fw-semibold); letter-spacing: var(--tracking-tight);
  color: var(--text-strong); margin: 0;
  position: relative; padding-bottom: 12px;
}
/* GOLD hairline flourish */
.page-title::after {
  content: ""; position: absolute; left: 0; bottom: 0;
  width: 48px; height: 2px; background: var(--color-gold);
}
```

A short subtitle (Vietnamese deck line) may sit beneath the title in `--text-muted`,
`--fs-sm`. The actions cluster (filters, the single crimson CTA) right-aligns in the
header on desktop, wraps below on mobile.

### Section-header pattern — serif label + stone divider
Sections use a serif H2/H3 with a **thin stone divider** beneath. Reuse `.section`
and the existing `.card-title`:

```css
.section { margin-bottom: var(--space-xl); }
.section > h2, .card-title {
  font-family: var(--font-display);
  font-size: var(--fs-h3); font-weight: var(--fw-semibold);
  color: var(--text-strong); margin: 0 0 var(--space-md);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--stone-200);   /* stone divider */
}
.divider { height: 1px; background: var(--stone-200); border: 0; margin: var(--space-lg) 0; }
```

Optional **small-caps tracked label** above a section title (an editorial kicker) —
add as an additive helper, never required by pages:

```css
.eyebrow {            /* additive — institutional kicker */
  font-family: var(--font-body);
  font-size: var(--fs-xs); font-weight: var(--fw-semibold);
  text-transform: uppercase; letter-spacing: var(--tracking-label);
  color: var(--color-gold); margin-bottom: var(--space-xs);
}
```

### KPI grid
KPI tiles (`.stat`) sit in `.grid-4` / `.grid-kpi` (`auto-fit, minmax(220px, 1fr)`),
gap 24px, usually 4-up on desktop, 2-up tablet, 1-up mobile. See §5 for the tile spec.

### Bento (dashboard only)
The Operational Dashboard uses an asymmetric **bento** built from `.card`s on a grid —
no new required class names; pages compose with the existing `.grid` + width utilities
or an additive `.bento` wrapper:

```css
.bento {                      /* additive — dashboard only */
  display: grid; gap: var(--space-lg);
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows: minmax(120px, auto);
}
.bento > .card { margin-bottom: 0; }       /* grid owns spacing */
.bento__feature { grid-column: span 8; grid-row: span 2; }  /* hero KPI / approval queue */
.bento__side    { grid-column: span 4; }                    /* sync freshness, alerts */
.bento__half    { grid-column: span 6; }
@media (max-width: 1024px) { .bento { grid-template-columns: repeat(6, 1fr); }
  .bento__feature, .bento__side, .bento__half { grid-column: 1 / -1; } }
```

### Reveal-on-mount (quiet, editorial)
Page sections fade+rise on mount over `--dur-reveal` with `--ease-editorial`,
staggered ≤80ms. Keep it subtle (8px rise, no scale). Disable under reduced motion.

```css
@keyframes reveal-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.reveal { animation: reveal-rise var(--dur-reveal) var(--ease-editorial) both; }
```

---

## 4. Sidebar Spec — Academic Navy Spine

Keep the existing collapsible spine (**256px ↔ 64px**, persisted to
`localStorage`, off-canvas drawer ≤768px) and the **exact** structure in
`Layout.tsx`: 5 Vietnamese groups, one Lucide `<Icon>` per item, `.sidebar-brand`
with brand mark + wordmark, `.sidebar__footer` with the connection pill + collapse
toggle. **Recolor only** — no markup or class renames.

### Recolor map
| Element | Before (slate) | After (Academia) |
|---|---|---|
| Sidebar bg | `#0F172A` | **`#0F1E3D` Academic Navy** (`--sidebar-bg`) |
| Idle link text | slate-300 | `--sidebar-fg` `#C9D2E2` |
| Group label | slate-500 | `--sidebar-fg-muted` `#7F8CA6`, small-caps, tracked |
| Hover fill | white 6% | `--sidebar-bg-raised` `#16294F` |
| **Active left-rule** | amber | **Oxford Crimson `#8C1D27`** (`--sidebar-accent`) |
| Active fill / text | blue-800 / white | `#16294F` / `#FFFFFF` |
| Brand mark chip | amber bg | **gold accent** (`--sidebar-brand-gold`) |
| Wordmark font | mono | **Crimson Pro** serif wordmark |

### Brand lockup
`.sidebar-brand` keeps the `sparkles` icon in a small chip + "AutoTGC" wordmark.
The wordmark becomes a serif (Crimson Pro) "academic press" wordmark; the chip is a
**gold-accent** crest mark (gold glyph on a subtle navy-raised tile, or gold tile with
navy glyph — pick the gold-glyph-on-navy variant for restraint). Treat it like an
institutional wordmark: consistent, never stretched, ivory/gold on navy
(cf. institutional two-color shield+wordmark practice, paraphrased
[Notre Dame](https://onmessage.nd.edu/university-branding/website-requirements/minimum-web-standards/header-requirements/),
[Yale heraldry](https://yaleidentity.yale.edu/guidelines/heraldry)).

```css
.sidebar { background: var(--sidebar-bg); color: var(--sidebar-fg); }

.sidebar-brand {
  height: var(--topbar-h); padding: 0 18px; gap: var(--space-sm);
  font-family: var(--font-display);          /* serif wordmark */
  font-size: 20px; font-weight: var(--fw-bold); letter-spacing: 0.3px;
  color: #FFFFFF; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.sidebar-brand .brand-mark {
  width: 28px; height: 28px; border-radius: var(--radius-md);
  background: rgba(176,133,66,0.14);         /* faint gold tile */
  color: var(--color-gold);                  /* gold glyph */
  display: inline-flex; align-items: center; justify-content: center;
}

.sidebar__label {
  font-family: var(--font-body);
  font-size: var(--fs-xs); font-weight: var(--fw-semibold);
  text-transform: uppercase; letter-spacing: var(--tracking-label);
  color: var(--sidebar-fg-muted);
  padding: var(--space-sm) 10px var(--space-xs);
}

.sidebar-link {
  color: var(--sidebar-fg);
  border-left: 3px solid transparent;        /* reserved rule track — no layout shift */
  border-radius: var(--radius-md);
  font-weight: var(--fw-medium);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.sidebar-link:hover { background: var(--sidebar-bg-raised); color: #FFFFFF; }

.sidebar-link.active,
.sidebar__item--active {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-active-fg);
  border-left-color: var(--sidebar-accent);  /* CRIMSON rule, not amber */
}
/* Collapsed rail keeps the crimson marker as an inset shadow (no width shift). */
.sidebar--collapsed .sidebar-link.active { box-shadow: inset 3px 0 0 var(--sidebar-accent); }
```

### Preserve exactly (from `Layout.tsx`)
The 5 groups and Lucide icon mapping are **unchanged** — restyle never touches them:

| Group (VI) | Items → Lucide icon |
|---|---|
| **Tổng quan** | Dashboard → `layout-dashboard` |
| **CRM tuyển dụng** | Leads → `user-plus` · Đơn hàng → `clipboard-list` · Ứng viên → `users` · Phân tích tuyển dụng → `bar-chart-3` |
| **Marketing AI** | Strategy & Personas → `compass` · Xu hướng → `trending-up` · Insights → `lightbulb` · Tư vấn AI → `bot` · Autopilot → `plane` · Workflows → `workflow` |
| **Nội dung** | Kế hoạch nội dung → `calendar-days` · Xưởng nội dung → `pen-tool` · Drafts → `file-text` · Publishing → `send` · Tài sản thương hiệu → `palette` · Cơ sở tri thức → `book-open` |
| **Hệ thống** | Platform Tokens → `key` · Settings → `settings` |

RBAC visibility (ADMIN-only items hidden for SALES), collapse persistence, mobile
drawer + scrim, and the footer connection pill all stay as-is. Update `theme-color`
meta and any hardcoded `#0F172A` to `#0F1E3D`.

---

## 5. Component Redesign Notes (restyle each preserved class — do NOT rename)

> Every class below already exists and is consumed by the 22 pages. Change the
> *declarations*, keep the *selectors*. Additive modifiers (`.btn--ghost`,
> `.data--dense`, `.stat__delta--up`, …) stay working.

### `.card`
Ivory-paper card: white surface, **sharper** radius (`--radius-lg` = 8px), warm stone
hairline, soft paper shadow, 26px padding. Static cards get **no** cursor/transform;
only `.card--interactive` lifts (shadow + border, never transform).
```css
.card {
  background: var(--surface); border: 1px solid var(--stone-200);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  padding: 26px; margin-bottom: var(--space-lg);
}
.card--interactive { cursor: pointer; transition: box-shadow var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease); }
.card--interactive:hover { box-shadow: var(--shadow-md); border-color: var(--stone-300); }
.card-title { font-family: var(--font-display); font-size: var(--fs-h3); font-weight: var(--fw-semibold); color: var(--text-strong); }
```

### `.btn` (base — neutral)
Quiet outline button on paper: white surface, stone border, body text. Inter,
medium. Hover = warm tint + stronger border. No transform.
```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-sm);
  padding: 10px 18px; border-radius: var(--radius-md);
  border: 1px solid var(--stone-300); background: var(--surface);
  color: var(--text-body); font-family: var(--font-body);
  font-size: var(--fs-body); font-weight: var(--fw-medium); line-height: 1; white-space: nowrap;
  transition: background var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease),
              box-shadow var(--dur-base) var(--ease), color var(--dur-base) var(--ease);
}
.btn:hover { background: var(--surface-hover); border-color: var(--stone-400); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
```

### `.btn-primary` / `.btn--primary` — **the single Oxford-Crimson CTA**
Crimson fill, **white text** (white-on-#8C1D27 ≈ 8.9:1, AAA). This is the one
high-emphasis action per view. Hover = darker crimson + subtle shadow, no shift.
```css
.btn-primary, .btn--primary {
  background: var(--color-accent); border-color: var(--color-accent);
  color: #FFFFFF; font-weight: var(--fw-semibold);
}
.btn-primary:hover, .btn--primary:hover { background: var(--color-accent-hover); border-color: var(--color-accent-hover); box-shadow: var(--shadow-sm); }
.btn-primary:focus-visible, .btn--primary:focus-visible { box-shadow: var(--shadow-focus-crimson); }
```
> **Migration note:** the legacy CTA was amber with dark text. Now crimson + white.
> Audit each page so only **one** crimson CTA competes per view; demote the rest to
> `.btn` (neutral) or `.btn-secondary` (navy outline).

### `.btn-secondary` / `.btn--secondary` — navy outline
```css
.btn-secondary, .btn--secondary {
  background: transparent; border: 1px solid var(--color-primary);
  color: var(--color-primary); font-weight: var(--fw-semibold);
}
.btn-secondary:hover, .btn--secondary:hover { background: rgba(15,30,61,0.06); border-color: var(--color-primary); }
```

### `.btn-danger` / `.btn--danger`
Destructive. Use the crimson-family danger (`--danger`) with white text (≥4.5:1).
Keep it visually distinct from the primary CTA by reserving danger for delete/destroy.
```css
.btn-danger, .btn--danger { background: var(--danger); border-color: var(--danger); color: #FFFFFF; font-weight: var(--fw-semibold); }
.btn-danger:hover, .btn--danger:hover { background: #8C1D27; border-color: #8C1D27; }
```
> Keep additive `.btn--ghost`, `.btn--blue`, `.btn-sm/.btn--sm`, `.btn--lg`,
> `.btn--icon`. Rework `.btn--blue` to a navy solid (`--color-primary` / white) so it
> never reads as a second CTA. `.btn--ghost` hover = `--surface-hover`.

### `.stat` (KPI tile)
Serif KPI number, small-caps tracked label, trend delta. Number is **Crimson Pro**
(not mono) for the editorial "journal figure" feel; keep tabular alignment via
`font-variant-numeric`. Optional gold top hairline on a "featured" tile.
```css
.stat {
  background: var(--surface); border: 1px solid var(--stone-200);
  border-radius: var(--radius-lg); padding: var(--space-lg);
  box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: var(--space-xs);
}
.stat-label, .stat__label {
  font-family: var(--font-body); font-size: var(--fs-xs); font-weight: var(--fw-semibold);
  text-transform: uppercase; letter-spacing: var(--tracking-label); color: var(--text-muted);
}
.stat-value, .stat__value {
  font-family: var(--font-display);          /* serif KPI numeral */
  font-variant-numeric: tabular-nums lining-nums;
  font-size: var(--fs-kpi); line-height: var(--lh-kpi);
  font-weight: var(--fw-semibold); color: var(--text-strong); margin-top: var(--space-xs);
}
.stat__delta { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--fs-sm); font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
.stat__delta--up   { color: var(--success-fg); }   /* green up */
.stat__delta--down { color: var(--danger-fg); }    /* red down */
.stat__delta--flat { color: var(--text-muted); }
.stat__delta--invert.stat__delta--up   { color: var(--danger-fg); }   /* cost/leak: up = bad */
.stat__delta--invert.stat__delta--down { color: var(--success-fg); }
.stat--featured { border-top: 2px solid var(--color-gold); }  /* rare gold emphasis */
.stat__spark { margin-top: var(--space-sm); color: var(--color-secondary); }
```
KPI count-up on mount ≤ `--dur-reveal`; respect reduced motion.

### `table.data` / `.data`
The data backbone. **Sticky header**, hairline rows, legible **sans** cells (never
serif), **mono right-aligned numerals**, warm row-hover tint, and a **crimson
left-rule** on selected rows. Header is small-caps tracked on a faint ivory fill.
```css
.table-wrap { overflow-x: auto; border-radius: var(--radius-md); border: 1px solid var(--stone-200); }
table.data { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-family: var(--font-body); }
table.data th, table.data td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--stone-200); white-space: nowrap; color: var(--text-body); }
table.data th {
  position: sticky; top: 0; z-index: 1;
  font-size: var(--fs-xs); font-weight: var(--fw-semibold);
  text-transform: uppercase; letter-spacing: var(--tracking-label); color: var(--text-muted);
  background: var(--stone-50); border-bottom: 1px solid var(--border-strong);
}
table.data tbody tr { transition: background var(--dur-fast) var(--ease); }
table.data tbody tr:hover { background: var(--surface-hover); }
table.data tbody tr.is-selected { background: var(--surface-active); box-shadow: inset 3px 0 0 var(--color-accent); }
.data--dense th, .data--dense td { padding: 8px 12px; }
.data--zebra tbody tr:nth-child(even) { background: var(--surface-sunken); }
.data__num, table.data td.data__num, table.data th.data__num {
  text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
}
.data__actions { display: flex; gap: var(--space-xs); justify-content: flex-end; }
```

### `.badge` (+ `badge-green/red/blue/yellow/gray` & `--success/--danger/--info/--warning/--neutral`)
Pill badges using the soft-bg / fg status pairs (warm/editorial, not neon). Optional
`.badge__dot` uses `currentColor`.
```css
.badge {
  display: inline-flex; align-items: center; gap: var(--space-xs);
  padding: 2px 10px; border-radius: var(--radius-pill);
  font-size: var(--fs-xs); font-weight: var(--fw-medium); line-height: 1.5;
  background: var(--neutral-bg); color: var(--neutral-fg);
}
.badge__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-green,  .badge--success { background: var(--success-bg); color: var(--success-fg); }
.badge-red,    .badge--danger  { background: var(--danger-bg);  color: var(--danger-fg); }
.badge-blue,   .badge--info    { background: var(--info-bg);    color: var(--info-fg); }
.badge-yellow, .badge--warning { background: var(--warning-bg); color: var(--warning-fg); }
.badge-gray,   .badge--neutral { background: var(--neutral-bg); color: var(--neutral-fg); }
```

### `.input` (and bare `input/select/textarea`, `.field`, `label`)
Calm paper inputs: stone border, sharper radius, **navy** focus ring. 38px control
height retained for density.
```css
input, select, textarea, .input {
  height: 38px; padding: 9px 13px;
  border: 1px solid var(--stone-300); border-radius: var(--radius-md);
  background: var(--surface); color: var(--text-strong); width: 100%;
  font: inherit;
  transition: border-color var(--dur-base) var(--ease), box-shadow var(--dur-base) var(--ease);
}
textarea { resize: vertical; min-height: 100px; height: auto; line-height: var(--lh-body); }
input::placeholder, textarea::placeholder { color: var(--text-faint); }
input:focus, select:focus, textarea:focus, .input:focus {
  outline: none; border-color: var(--color-primary); box-shadow: var(--shadow-focus);
}
input:disabled, select:disabled, textarea:disabled { background: var(--surface-sunken); color: var(--text-faint); cursor: not-allowed; }
label { display: block; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-body); margin-bottom: var(--space-xs); }
.field { margin-bottom: 14px; }
```

### `.modal` / `.modal-overlay` / `.modal-backdrop`
Navy-tinted scrim with a soft blur; modal is white paper, `--radius-xl`, big soft
shadow, 32px padding. Header title is serif. Keep `.modal--lg`, `.modal-header`,
`.modal-close`, `.modal-actions`.
```css
.modal-overlay, .modal-backdrop {
  position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
  padding: var(--space-lg);
  background: rgba(15,30,61,0.45);            /* navy scrim */
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
}
.modal {
  background: var(--surface); border-radius: var(--radius-xl); padding: var(--space-xl);
  width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-xl);
}
.modal-header h2 { font-family: var(--font-display); font-size: var(--fs-h2); font-weight: var(--fw-semibold); color: var(--text-strong); }
.modal-actions { display: flex; gap: var(--space-sm); justify-content: flex-end; margin-top: var(--space-lg); }
```
> Scrim blur is a quiet depth cue on the modal backdrop only — **not** glassmorphism
> on content surfaces (which is banned).

### `.toolbar`
Filter/action bar above tables. Aligns controls to the baseline, wraps gracefully;
the single crimson CTA (if present) sits at the far right.
```css
.toolbar { display: flex; gap: var(--space-sm) var(--space-md); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--space-md); }
.toolbar .field { margin-bottom: 0; min-width: 150px; }
.chip { /* active-filter pill */
  display: inline-flex; align-items: center; gap: var(--space-xs); padding: 4px 10px;
  border-radius: var(--radius-pill); background: var(--surface-active); color: var(--color-primary);
  font-size: var(--fs-xs); font-weight: var(--fw-medium); border: 1px solid var(--stone-200);
}
```

### `.page-header` / `.page-title`
See §3 (gold underline flourish). This is a signature device — apply on every page.

### `.tabs` (+ `.tab`, `.tab--active`)
Underline tabs with a navy active rule (editorial, not pill tabs).
```css
.tabs { display: flex; gap: var(--space-xs); border-bottom: 1px solid var(--stone-200); margin-bottom: var(--space-lg); }
.tabs button, .tab {
  border: none; background: transparent; padding: 10px 14px;
  font-family: var(--font-body); font-size: var(--fs-body); font-weight: var(--fw-medium);
  color: var(--text-muted); border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.tabs button:hover, .tab:hover { color: var(--text-body); }
.tab--active, .tabs button.tab--active { color: var(--color-primary); border-bottom-color: var(--color-primary); }
```

### `.skeleton` (+ `--text`, `--row`, `.skeleton-stack`, `.spinner`)
Warm-stone shimmer (ivory family, not blue-gray). Reduced-motion disables shimmer.
```css
.skeleton {
  display: block; background: var(--stone-200); border-radius: var(--radius-sm);
  background-image: linear-gradient(90deg, var(--stone-200) 0%, var(--stone-100) 50%, var(--stone-200) 100%);
  background-size: 200% 100%; animation: skeleton-shimmer 1.2s ease-in-out infinite;
}
@keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
```

### `.empty-state`
Centered Lucide icon (faint stone), serif title, muted sub, and a single action
(crimson CTA only if it's the obvious next step).
```css
.empty-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-sm); padding: var(--space-2xl) var(--space-lg); text-align: center; color: var(--text-muted); }
.empty-state .icon { color: var(--stone-400); }
.empty-state__title { font-family: var(--font-display); font-size: var(--fs-h3); font-weight: var(--fw-semibold); color: var(--text-body); }
```

### `.auth-wrap` / `.auth-card` — editorial login
Replace the blue gradient with an **editorial split**: a navy crest panel beside an
ivory form card (collapses to a centered card on mobile). The crest panel is Academic
Navy with a faint gold hairline frame, the serif wordmark, a one-line Vietnamese
positioning deck, and quiet gold rule — like a university journal cover. The form side
sits on ivory; primary submit is the crimson CTA.
```css
.auth-wrap {
  min-height: 100vh; display: grid; grid-template-columns: 1.1fr 1fr;
  background: var(--color-background);
}
/* Left crest panel (navy). Use ::before for the gold hairline frame. */
.auth-wrap::before {
  content: ""; grid-column: 1; background:
    radial-gradient(120% 120% at 20% 0%, #16294F 0%, #0F1E3D 60%);
  border-right: 1px solid rgba(176,133,66,0.35);
}
.auth-card {
  grid-column: 2; align-self: center; justify-self: center;
  background: var(--surface); border: 1px solid var(--stone-200);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lg);
  padding: var(--space-2xl); width: 100%; max-width: 400px;
}
.auth-card h1 { font-family: var(--font-display); font-size: var(--fs-h2); color: var(--text-strong); margin: 0 0 var(--space-xs); position: relative; padding-bottom: 10px; }
.auth-card h1::after { content: ""; position: absolute; left: 0; bottom: 0; width: 44px; height: 2px; background: var(--color-gold); }
.auth-sub { color: var(--text-muted); margin-bottom: var(--space-lg); font-size: var(--fs-sm); }
.auth-switch { margin-top: var(--space-md); text-align: center; font-size: var(--fs-sm); color: var(--text-muted); }
@media (max-width: 768px) {
  .auth-wrap { display: flex; align-items: center; justify-content: center; padding: var(--space-lg);
    background: radial-gradient(140% 120% at 50% -20%, #16294F 0%, #0F1E3D 55%, var(--color-background) 55%); }
  .auth-wrap::before { display: none; }
  .auth-card { grid-column: auto; }
}
```
> If the auth pages render their own crest markup, expose an additive
> `.auth-crest` / `.auth-crest__wordmark` for the navy panel content (wordmark in
> Crimson Pro, gold rule, Vietnamese deck). Do not require new classes from existing pages.

### Signature editorial devices (additive helpers — opt-in)
```css
/* Gold title underline already baked into .page-title::after and .auth-card h1::after. */
/* Drop-cap for hero/editorial intro paragraphs (Dashboard welcome, empty-state hero). */
.dropcap::first-letter {
  float: left; font-family: var(--font-display); font-weight: var(--fw-semibold);
  font-size: 3.2em; line-height: 0.8; padding: 4px 10px 0 0; color: var(--color-primary);
}
/* Small-caps section label (reuse .eyebrow from §3). */
```

---

## 6. Chart Guidance

Charts are **dependency-free SVG/CSS** primitives (`BarChart`, `FunnelChart`,
`DonutChart` in `components/charts.tsx`, plus the CSS `.bar-*`, `.funnel-*`,
`.donut-*` classes). Keep that approach. The current code hardcodes a blue+amber
palette — **swap the constants to the Academia ramp**. Gold is the single highlight
series; everything else is a navy→slate→light-blue progression.

### Series palette (single coherent ramp — no rainbow)
Sequence (cool depth → highlight): **Navy → Slate → Muted Slate → Light Blue-Gray**,
with **Gold** reserved as the single highlight series. Add as additive `:root` vars:
```css
  --chart-1: #0F1E3D   /* Academic Navy   — primary series / largest */
  --chart-2: #334766   /* Slate Blue      — second series */
  --chart-3: #5B7088   /* Muted Slate     — third */
  --chart-4: #8CA0B8   /* Light Blue-Gray — fourth / minor */
  --chart-highlight: #B08542  /* Prestige Gold — the ONE "this matters" series */
  --chart-track: var(--stone-200)   /* unfilled track / donut remainder */
  --chart-grid:  var(--stone-200)   /* axis/gridlines, hairline */
```
Add these as additive `:root` vars and reference them from `charts.tsx` (replace the
`PALETTE`, `ACCENT`, `RAMP`, donut track `#E2E8F0`, and bar fallbacks):
- `ACCENT` → `#B08542` (gold highlight: top bar, worst funnel drop, focus series).
- `PALETTE` / `RAMP` → `['#0F1E3D','#334766','#5B7088','#8CA0B8']`.
- Donut base track `#E2E8F0` → `var(--stone-200)`; donut value text → `--text-strong`
  serif (`.donut-value { font-family: var(--font-display); }`).

### Per-chart specs
- **Funnel** (`.funnel-*`): descending stage bars, navy→light-blue ramp by depth;
  the **leakiest step gets the gold fill** + a Vietnamese note ("rớt nhiều nhất").
  Stage count/percent in `--text-muted`, mono numerals. Bars animate width over
  `--dur-slow` on mount.
- **Horizontal bar** (`.bar-*`): sorted descending; **top bar = gold**, rest = slate
  `#334766`. Label left (`--fs-sm`, ellipsis), mono value right-aligned, track
  `--stone-100`. Hover dims fill slightly (`filter: brightness(0.94)`), no shift.
- **Donut** (`.donut-*`): single ratio; ring in navy (or gold when it's the headline
  metric), remainder `--stone-200`, rounded cap, serif center value, muted caption.
- **Line / area** (if/when added): 1.75px navy stroke; area = navy at 8–12% alpha
  fill; gold reserved for a single emphasized line. Gridlines hairline `--stone-200`;
  axis labels `--text-muted` `--fs-xs`.
- **Sparkline** (`.stat__spark`): 1.5px stroke in `--color-secondary` (slate) by
  default; gold only if the tile is the featured KPI. No fill, no axis.

### Tooltips & accessibility
- Tooltips: white surface, `--stone-200` border, `--shadow-md`, `--radius-md`,
  `--fs-sm`; label in `--text-muted`, value mono `--text-strong`. (Native `title`
  attributes are already used — keep them; a styled tooltip is an enhancement.)
- Every bar/segment keeps `role="img"` + a Vietnamese `aria-label` (already present).
- **AAA contrast:** chart text/labels are stone/ink on ivory (≥7:1). Never rely on
  color alone to convey state — pair gold highlight with a text note or icon. Do not
  put long labels in gold or crimson.
- Chart entrance ≤ `--dur-slow`; respect `prefers-reduced-motion` (no width tween).

---

## 7. MUST-PRESERVE Class Names (restyle only — never rename)

The ~22 pages depend on these selectors. Restyle declarations; keep the names.
Removing or renaming any of these is a regression.

**Core / structural**
`.card` · `.btn` · `.btn-primary` · `.btn-secondary` · `.btn-danger` ·
`.sidebar` · `.sidebar-link` · `table.data` / `.data` · `.stat` · `.badge`
(+ color modifiers `.badge-green` / `.badge-red` / `.badge-blue` / `.badge-yellow` /
`.badge-gray`) · `.toolbar` · `.modal` · `.modal-overlay` / `.modal-backdrop` ·
`.input` · `.page-header` · `.page-title` · `.grid` / `.grid-2` / `.grid-4` ·
`.table-wrap` · `.kv` · `.field` · `.auth-wrap` · `.auth-card`

**Additive classes that must keep working** (already in `styles.css`; keep behavior)
- Buttons: `.btn--primary/.btn--secondary/.btn--ghost/.btn--blue/.btn-blue/.btn-danger/.btn--danger/.btn-sm/.btn--sm/.btn--lg/.btn--icon`
- Sidebar: `.sidebar--collapsed/--open`, `.sidebar-brand`, `.brand-mark`,
  `.brand-wordmark`, `.sidebar-nav`, `.sidebar__group`, `.sidebar__label`,
  `.sidebar__item--active`, `.sidebar__footer`, `.sidebar__toggle`, `.sidebar-scrim`,
  `.nav-icon`, `.nav-label`
- Topbar/shell: `.app-shell`, `.main`, `.topbar`, `.topbar-spacer`,
  `.topbar__search`, `.topbar__icon-btn`, `.content`, `.conn`/`.conn-dot`/`.conn-*`,
  `.bell`/`.bell-*`, `.user-chip`, `.role-pill`
- Cards/grids: `.card--interactive`, `.card-title`, `.grid-kpi`, `.section`,
  `.divider`
- Stat: `.stat-label`/`.stat__label`, `.stat-value`/`.stat__value`,
  `.stat__delta` (+ `--up/--down/--flat/--invert`), `.stat__delta-period`,
  `.stat__spark`, `.icon`
- Table: `.data--dense`, `.data--zebra`, `.data__num`, `.data__actions`,
  `tr.is-selected`
- Badges: `.badge__dot`, `.badge--success/--danger/--info/--warning/--neutral`
- States: `.state`, `.error-box`/`.error-state`, `.notice`, `.success-box`,
  `.empty-state` (+ `.empty-state__title`)
- Loading: `.skeleton` (+ `--text/--row`), `.skeleton-stack`, `.spinner`
- Auth: `.auth-sub`, `.auth-switch`
- Misc: `.chip`, `.row-actions`, `.pagination`, `.muted`, `.inline-list`,
  `.mono`, `.kpi-num`, `pre.code`, `.tabs`/`.tab`/`.tab--active`,
  `.modal--lg`/`.modal-header`/`.modal-close`/`.modal-actions`,
  `.steps-list`/`.step-row`/`.step-index`,
  `.bar-chart`/`.bar-row`/`.bar-label`/`.bar-track`/`.bar-fill`/`.bar-value`,
  `.funnel`/`.funnel-stage`/`.funnel-meta`/`.funnel-stage-label`/`.funnel-stage-count`/`.funnel-bar-track`/`.funnel-bar-fill`,
  `.donut`/`.donut-value`/`.donut-caption`

**Token aliases kept** so inline/page styles don't break: `--gray-50…900`
(→ stone), `--color-cta`/`--color-cta-hover` (→ crimson), `--primary`,
`--primary-hover`, `--bg`, `--text`, `--sidebar-text`, `--sidebar-active`,
`--radius`, `--shadow`, `--color-primary-hover`.

> New work uses the BEM-ish `block__el` / `block--mod` convention and the additive
> helpers introduced here (`.eyebrow`, `.dropcap`, `.bento*`, `.stat--featured`,
> `.reveal`, `.auth-crest*`). Never invent a synonym for an existing class.

---

## 8. Font Loading (`index.html`)

Replace the current Fira Code/Fira Sans links with Crimson Pro + Inter + IBM Plex
Mono. Keep `display=swap` and the preconnect pair. Update `theme-color` to navy.

```html
<meta name="theme-color" content="#0F1E3D" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
```

**Vietnamese diacritic coverage — confirmed:** Inter and Crimson Pro both ship a
`vietnamese` Unicode-range subset on Google Fonts (the `css2` response emits a
`/* vietnamese */` `@font-face` with `unicode-range` covering U+0102–U+1EF9, etc.), so
"Đơn hàng", "Ứng viên", "Xu hướng", "Cơ sở tri thức", "Thu gọn" render with correct
stacked diacritics. IBM Plex Mono covers Vietnamese Latin as well (used only for
IDs/numerals, so diacritics are rarely exercised there). The serif fallback stack
(`Georgia, 'Times New Roman'`) and sans fallback (`system-ui, 'Segoe UI'`) also cover
Vietnamese, so a swap flash degrades gracefully. `lang="vi"` on `<html>` stays.

> Performance: 3 families × limited weights, all `display=swap`, preconnected.
> Acceptable for an internal ops console. If FOUT is a concern later, self-host the
> `vietnamese` + `latin` subsets — not required for v2.

---

## 9. Do / Don't (prioritized)

**Do**
1. **One crimson CTA per view.** Exactly one `.btn-primary` (Oxford Crimson) as the
   page's primary action; everything else is `.btn` (neutral) or `.btn-secondary`
   (navy outline). Audit each page during migration.
2. **Treat gold as a rare flourish.** Gold = the institutional title underline, the
   active-nav crest accent, one featured-KPI rule, one highlight chart series. Never a
   large fill, never body text, never more than one gold moment competing in a view.
3. **Hold AAA where text lives.** Ink/stone on ivory ≥7:1; white on crimson (CTA) and
   white on navy clear AA+ comfortably. Verify every status `*-fg` on its `*-bg`.
4. **Editorial whitespace.** 32px page gutters, 26px card padding, 32px section gaps.
   Let the page breathe — density comes from tables, not from cramming blocks.
5. **Serif for display, sans for reading.** Crimson Pro on H1–H3 + KPI numerals;
   Inter for body, controls, and **all table cells**; IBM Plex Mono for IDs/metrics.
6. **Quiet, layered motion.** Editorial reveals 400–600ms (`--ease-editorial`); UI
   micro-interactions 150–300ms. Always honor `prefers-reduced-motion`.
7. **Signature devices, used sparingly.** Gold title underline on every page header;
   small-caps `.eyebrow` kicker and `.dropcap` only on hero/editorial intros.
8. **Lucide SVG icons only** (the existing `Icon` set), 1.75 stroke, `currentColor`.
9. **Keep class names; restyle declarations.** Preserve the §7 list exactly.

**Don't**
1. **No second CTA color.** Don't reintroduce amber, and don't let `.btn--blue` or
   `.btn-danger` read as a primary action.
2. **No glassmorphism / neon / gaudy gradients-as-skin.** The only blur is the modal
   scrim; the only gradients are the auth crest panel and KPI sparkline fills.
3. **No layout-shifting hovers.** Color + shadow only — never `scale`/`translate`
   that nudges neighbors. Active nav/selected-row rules use a reserved track or inset
   shadow so nothing reflows.
4. **No emojis as icons** — ever. SVG/Lucide only.
5. **No serif in dense data.** Table cells, inputs, badges, and chips stay Inter;
   serif is for display/headlines/KPI figures.
6. **No crimson or gold for long text or large fills.** They're accents, not inks.
7. **No instant state changes** and **no invisible focus.** Every interactive element
   shows a visible focus ring (navy, or crimson on crimson controls).
8. **No rainbow charts.** Single navy→slate→light-blue ramp + one gold highlight.
9. **Don't translate Vietnamese UI labels** or alter the sidebar groups / icon map.

---

### Pre-delivery checklist (carry over from MASTER)
- [ ] `:root` swapped; no stray hexes outside `:root` / `charts.tsx` constants.
- [ ] Single crimson CTA per view verified on all ~22 pages.
- [ ] All §7 class names present and restyled (none renamed/removed).
- [ ] Crimson Pro + Inter + IBM Plex Mono loaded; Vietnamese diacritics render.
- [ ] Sidebar recolored to navy with crimson active rule + gold brand mark.
- [ ] Gold appears only as flourish (title underline, active marker, 1 chart series).
- [ ] Text contrast ≥4.5:1 (AAA where feasible); visible focus everywhere.
- [ ] `prefers-reduced-motion` respected; no layout-shift hovers.
- [ ] Responsive at 375 / 768 / 1024 / 1440; tables scroll inside `.table-wrap`.
- [ ] `theme-color` and any hardcoded `#0F172A` updated to `#0F1E3D`.
