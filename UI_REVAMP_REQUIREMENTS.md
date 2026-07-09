# eda-frontend UI/UX Revamp — Requirements Handoff

Loose guidance, not a spec. Deviate where it makes sense.

## Goal

Full UI/UX refresh of `eda-frontend`. Enterprise feel. Helpful home page with clear entry buttons instead of the current bare logo-and-one-button page.

## Decisions (locked by user)

- **Scope**: Home + app shell + Dashboard / Projects / Gallery / Login. Schematic editor canvas untouched.
- **Look**: light enterprise SaaS. Linear / Vercel / Stripe register.
- **Stack**: stay on MUI v4. No dependency changes, no v5 upgrade.

## Palette

| Token | Value |
|---|---|
| Background | `#ffffff`, `#f8fafc` |
| Surface | `#ffffff` |
| Border | `#e2e8f0` |
| Accent | `#2563eb` |
| Text primary | `#0f172a` |
| Text secondary | `#64748b` |

Radius 6px. Subtle shadows. Inter for UI, JetBrains Mono where monospace is wanted.

## Current state (verified on `develop`)

- `src/theme.js` — 22 lines, stock light MUI, primary `#556cd6`.
- `src/pages/Home.js` — 59 lines: logo, `<h2>`, one "Schematic Editor" button.
- `src/components/Shared/Navbar.js` — 316 lines. Exports `Header` (named) **and** `Navbar` (default). `Dashboard.js` passes `<Header />` into `Layout resToolbar`. **Keep both exports.**
- `src/index.js` is the only importer of `./theme`.
- MUI v4 (`@material-ui/core` 4.11), React 16.14, CRA 3.4 (`react-scripts` 3.4.1), `react-router-dom` v5.
- Build: `NODE_OPTIONS=--openssl-legacy-provider npm run build`

## Suggested phases

1. `src/theme/tokens.js` + `src/theme/index.js` (delete `src/theme.js`). Update `src/index.css` for Inter.
2. Navbar rewrite — sticky, active-route highlight, user menu. Add a Footer.
3. Home — hero, quick-action grid, feature cards, recent projects, CTA.
4. Dashboard / Projects / Gallery — page headers, card grids, empty states.
5. Login / signUp / NotFound.

## Notes

- `src/theme/tokens.js` was drafted in an earlier session. Reuse or discard.
- TypeUI MCP is installed but on the free plan — no access. Build the design system by hand.
