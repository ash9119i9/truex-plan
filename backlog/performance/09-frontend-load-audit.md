# Frontend load audit: blocking fonts, chat bundle size, 404s

Status: open · Added 2026-10-26

Report from a production build of `frontend/` measured with Lighthouse 12.8.2
(Chrome 155): mobile profile = simulated 4G + 4× CPU, desktop profile for
comparison. The dev server on port 3000 was left untouched; the build ran in a
disposable copy of `frontend/` with the same source and only the Turbopack root
path adjusted. Related: `backlog/performance/01-first-load-latency.md` covers
the authenticated request waterfall; this report is bundles and page load only.

## Result in one line

Static pages score 97–99 on desktop, but the mobile `/login` page scores 90 with
LCP 3.64 s, and 194 KB of that load is third-party Google Fonts. Removing the
font stylesheet in a controlled build took LCP to 2.15 s and transfer from
377 KB to 182 KB.

## Quality gates

| Check | Result |
| --- | --- |
| `tsc --noEmit` | pass, 0.9 s |
| `npm test` | 599/599 pass, 3.5 s |
| `next build` (Turbopack) | pass, 2.8 s, 10 routes |

## Bundle sizes (gzip, production build)

| Route | Initial JS | CSS | Notes |
| --- | --- | --- | --- |
| `/` | 178.5 KB | 30.4 KB | entry page |
| `/login` | 177.7 KB | 30.4 KB | |
| `/connected-tools` | 178.2 KB | 25.0 KB | |
| `/t/[tenantId]/chat` | **≈270 KB** | ≈36 KB | from build manifests + imported CSS; not runtime-measured |

- Shared React/Next baseline is ≈165 KB gzip on every route.
- The largest single chunk is **400.3 KB raw / 124.6 KB gzip** and loads only on
  `/t/[tenantId]/chat`. It contains the markdown stack (remark, micromark,
  mdast, hast) and motion-related code.
- Chat initial JS = 126 KB shared main files + 144 KB route entry files.
- The 38.6 KB gzip polyfill chunk in the HTML is never requested by Chrome 155,
  so it is not a real-world cost.
- Hashed static assets are served with `Cache-Control: public, max-age=31536000,
  immutable`; compression is on. No action needed.

## Lighthouse

| Page / profile | Perf | LCP | FCP | TBT | CLS | Transfer |
| --- | --- | --- | --- | --- | --- | --- |
| `/login` mobile | 90 | **3.64 s** | 1.44 s | 0 ms | 0 | 377 KB |
| `/login` desktop | 99 | 0.88 s | 0.46 s | 0 ms | 0 | 377 KB |
| `/` mobile | 97 | 2.52 s | 1.45 s | 0 ms | 0.045 | 202 KB |

Mobile `/login` transfer: fonts 194 KB, scripts 144 KB, CSS 34 KB, document 4 KB.
Accessibility 100, Best Practices 96.

### Font experiment

Same build with the Google Fonts stylesheet removed:

| Metric | With fonts | Without fonts |
| --- | --- | --- |
| Mobile LCP | 3.64 s | **2.15 s** |
| Mobile FCP | 1.44 s | 0.90 s |
| Perf score | 90 | 99 |
| Transfer | 377 KB | 182 KB |

This measures the upper bound only: it drops the custom fonts. The intended fix
keeps the design but self-hosts and subsets the faces.

## Findings

1. **P1 — render-blocking third-party fonts.** `app/layout.tsx:27` loads one
   Google Fonts stylesheet for four families. On `/login` the browser fetched
   Newsreader italic (143.7 KB), JetBrains Mono (30.6 KB), Figtree (19.7 KB) and
   the font CSS (1.4 KB). The LCP element is a Newsreader-rendered H1, so this
   sits directly on the critical path. Font tokens live in
   `styles/v2/tokens.css:43-46`.
2. **P1/P2 — chat initial JS ≈270 KB gzip vs the 200 KB budget.** The
   chat-only 125 KB gzip chunk is the markdown stack plus motion. Loading it
   before first paint delays hydration of a route whose shell could render
   first. This is a hypothesis until measured on an authenticated session.
3. **P3 — `favicon.ico` 404** on every page.
4. **P3 — logged-out load logs a 403** from `/api/v1/auth/refresh` to the
   console. Not a performance issue, but it makes Best Practices 96 and hides
   real errors in the console.

## Fix plan

1. **Fonts.** Self-host through `next/font/google` and expose each family as a
   CSS variable (`variable: "--font-figtree"`), then point the existing tokens
   at those variables inside `tokens.css`. The current code comment says
   `next/font` would break the `--font-*` tokens; the variable form avoids that.
   Subset to latin, keep only the weights in use, keep Newsreader italic only,
   preload the face used above the fold, keep `display=swap`. Remove the
   `fonts.googleapis.com` stylesheet and preconnects.
   Verify: no requests to `fonts.googleapis.com`/`fonts.gstatic.com`, total font
   transfer ≤100 KB, mobile `/login` LCP ≤2.5 s.
2. **Chat bundle.** Confirm what occupies the 400 KB chunk with a bundle
   analyzer or source map, then load the markdown renderer after the chat shell
   (dynamic import behind `Suspense`, without disturbing streaming order) and
   use motion's lazy feature loading or plain CSS for simple transitions.
   Measure `/t/:tenantId/chat` authenticated before and after; keep only what
   beats run-to-run variance.
   Verify: initial JS ≤200 KB gzip on the chat route, streaming and markdown
   tests still pass.
3. **Small fixes.** Add `app/icon.svg` (or `favicon.ico`). Decide whether
   logged-out refresh should be 401 or be filtered from client logs.
4. **Guardrails.** Add Lighthouse CI budgets and field RUM (`web-vitals` is not
   currently installed). Suggested budgets: mobile LCP ≤2.5 s p75, initial JS
   ≤200 KB gzip, fonts ≤100 KB, CLS ≤0.1, TBT ≤200 ms.

## Intentional or not actionable

- SEO 60 is `noindex, nofollow`, intentional for a private app.
- The polyfill chunk is conditional; modern browsers do not download it.
- ≈52 KB of unused JS is the Next/React runtime; not worth chasing.
- Dev-only duplicate requests from React Strict Mode are not present in this
  production build.

## Caveats

- Measured on localhost with simulated throttling, not field data. Desktop
  `/login` is 99, so the mobile gap is network/font sensitivity.
- The chat route could not be opened authenticated, so its JS is derived from
  build manifests and its CSS from the component imports (tenant-chat, chat-files,
  connectors, tenant-agents: 28.7 KB raw / 6.2 KB gzip).
- The font experiment removed the custom faces; it quantifies the cost, not the
  final design-preserving result.

## Done when

- Fonts are self-hosted and subset; no blocking third-party font request; total
  font transfer ≤100 KB; mobile `/login` LCP ≤2.5 s, before/after recorded here.
- Chat initial JS ≤200 KB gzip, measured on an authenticated production build,
  with streaming and markdown tests green.
- Favicon resolves 200; console has no unexpected errors on a logged-out load.
- A CI budget and a field metric can detect a regression of the primary metric.
