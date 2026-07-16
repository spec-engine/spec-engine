# Brand assets

Source lockups from the **Spec Engine brand kit** (`spec-engine/Spec Engine brand kit/exports`).
The Spec Engine workspace is the charcoal (dark) theme with the **amber** accent, so the
white and orange variants are the two we carry:

| File | Use |
|---|---|
| `mark-white.svg` | the clamp mark, single-ink (node inherits the ink color) |
| `mark-orange.svg` | the clamp mark with the amber signal node |
| `logo-white.svg` | full lockup (mark + "Spec Engine" wordmark), white |
| `logo-orange.svg` | full lockup, amber |

The workspace nav (`src/pages/nav.ts`) **inlines** the clamp-mark geometry rather than
`<img>`-ing these files, so the signal node can fill with the live `--brand` token
(amber, or lime under `.theme-lime`) and the strokes track `--fg`. These files are the
checked-in source of truth for that geometry and for any future favicon / OG image work.
