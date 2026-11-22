# Frontend architecture and UX
React + Vite + strict TypeScript, Tailwind CSS/shadcn/ui, Lucide icons, TanStack Query for server state; optional Zustand for genuinely shared client-only state, Framer Motion for subtle transitions with prefers-reduced-motion. Avoid unnecessary animation and Next.js SSR/SEO. Feature modules auth, inbox, ticket detail, conversation, customer, shared UI; typed API adapter and shared contracts. Query keys separated by role/session; clear cache on logout, invalidate after mutation, no optimistic claim success or fabricated SLA status. Server supplies authoritative deadlines and business state; countdown display only. Screen: queue/my tickets, filters priority/status/late, accessible list and detail split panel, narrow screens stack; waiting indicator independent from historical late badge; explicit public reply vs private note modes with labels and confirmation when ambiguous, note visually distinct but never rely on color alone. Agent audit timeline uses safe actor/time/action, customer view only public DTO. Keyboard focus, semantic buttons, labels, WCAG-oriented contrast, reduced motion, loading/empty/error/conflict states (409 refresh and notify), pagination. Assets optimized (SVG icons, small bundles, lazy load optional charts, no decorative heavy imagery). No marketing landing or unrelated product feature. Validate at desktop and mobile with keyboard and screen-reader semantics; no compliance claim without audit.


## V3 reviewer workspace
Filters All, Late, Waiting, Unassigned, My Tickets, Closed; distinct priority/current SLA/history badges; remaining working time from server. Public reply and amber team-only note composer; customer portal separately authenticated; export preview from actual customer endpoint, no staff payload. Lead-only sweep; show outcome and automatic history. See DEMO_SCENARIOS.

V3.1: use separate typed staff/public API contracts; public list shows public summary subject only. Staff detail reconstructs historical reasons and publication timestamp; server clock as-of and unrecorded breach indicator. Support customer response outcomes SAME_TICKET or NEW_LINKED_TICKET; never reuse staff data in customer preview. Staff resolve requires public message if response pending. Auth flow per AUTH_CONTRACT; clear cache on identity switch.

V3.2: Audit history renders the discriminated action union, not arbitrary JSON; reconstruct policy changes, pauses, breaches and public publication. Sweep shows committed counters and moreDue; terminal failures use safe error messages. Staff claim conflict name is restricted to authorized staff claim response.

## M5 requirement from M4 (H03 timeline pagination)
Ticket detail returns only the most recent message page (≤ 50, chronological) plus `olderMessagesCursor`. The agent and customer timelines MUST offer "load older messages" via `GET /api/tickets/{id}/messages` / `GET /api/customer/tickets/{id}/messages?cursor=…` (newest page first; prepend `items`). Exports are complete server-side. Never infer private message counts from page sizes.

## M5 as built
Tokens in `apps/web/src/index.css` (navy `--color-nav`, teal brand #0f766e, red breach, amber waiting/internal notes). SLA state is always text + icon + colour. Dialog focus is returned to the opener manually (controlled Radix dialogs). Responsive: sidebar becomes a disclosure under 1024 px; list/detail stack; SLA cards single-column until 1280 px.

## Premium UI redesign (branch `design/frontdesk-premium-ui`)

**Direction.** A support-operations tool, not a dashboard template. It uses a warm neutral canvas (`#f5f5f2`), deep ink text (`#14181f`) and one teal accent (`#0f766e`). Teal is reserved for selected states, primary actions and focus. Amber is reserved for team-only notes, so a private note can never look like a public reply. Hairline borders do most of the separation, shadows stay soft, and there are no gradients on content, no decorative charts and no counts the API does not provide.

**Tokens (single source: `apps/web/src/index.css` `@theme`).**
- *Type scale:* `text-caption` 11, `meta` 12, `body` 13, `ui` 14, `title` 15, `heading` 19, `display` 26 px, each with a line-height. `tailwind-merge` is extended (`lib/utils.ts`) so these never get mistaken for colours. Inter Variable is self-hosted via `@fontsource-variable/inter` (OFL); the CSP is `font-src 'self'` and no CDN is used. Tabular numerals are used for every time, duration and count.
- *Colour:* neutrals `canvas/surface/surface-2/sunken/line/line-strong/control/ink/ink-2/ink-3`; `brand*`; semantic `danger/warn/ok/info` (+`-soft`, `-ink`); and the `note*` family.
- *Geometry and motion:* radii 5/7/10/14 px; elevation `xs/sm/pop`; motion 120–220 ms (`fade`, `pop`, `rise`). All motion collapses under `prefers-reduced-motion`.

**Measured contrast (WCAG 2.x formula, script output 2026-11-22).**
- *Text:* `ink-3` (the lightest text colour) is 5.80:1 on surface, 5.31 on canvas, 5.03 on sunken, and 5.65 on the worst-case glass. White on brand is 5.47, on note 5.19 and on danger 6.57. Every `-ink` on `-soft` pair is 7.8–9.1.
- *Form controls:* boundaries use `control #878d95`: 3.35:1 on white and 3.20 on surface-2 (WCAG 1.4.11). The previous `#bcc6d4` was about 1.8:1. The focus border is brand teal at 5.47:1.
- These ratios are computed from the tokens. They are not a WCAG conformance claim.

**Glass policy.** The `glass`, `glass-strong` and `glass-canvas` utilities are used only where content scrolls beneath chrome or where a layer floats:
- the sticky ticket-list header and the sticky ticket header (≥ 1024 px)
- the mobile top bar and navigation drawer
- the customer portal top bar
- dialogs, toasts and the sign-in card

They are never applied to rows or cards. Without `backdrop-filter` support they fall back to near-opaque surfaces, and under `prefers-reduced-transparency: reduce` they become fully opaque.

**Components (`components/ui`).**
- `Button` (primary/secondary/ghost/danger/note; 32/36/44 px)
- `Field`, `Input`, `Textarea` and a native `Select` with a consistent chevron (`hideLabel` keeps the accessible name in compact toolbars)
- `Badge` (+`note` tone)
- `Notice` callout, used for session messages, lifecycle explanations, errors and results
- `Dialog` + `DialogActions`
- `LoadingRows` skeletons shaped like real rows, `EmptyState`, `ErrorState`, `Spinner`
- `Toast`
- `identity.tsx`: `LogoMark` (ticket-stub mark, also the favicon), `Wordmark`, `Avatar` (initials, decorative; the name is always text), `Kbd`, and `Tip`, a CSS tooltip on hover/focus-visible that echoes the control's `aria-label`

**Layout.**
- *≥ 1024 px:* navigation on the canvas | ticket list | ticket detail. List and detail share one raised, rounded sheet.
- *≥ 1440 px:* the detail gets a "Service levels" rail. `useMediaQuery` decides where the SLA panel renders, so it renders in exactly one place and accessible names are never duplicated.
- *< 1024 px:* a glass top bar opens a slide-in drawer (Escape or scrim closes it, focus moves into the nav), with list → detail drill-down.
- The document never scrolls in the staff workspace; panes do (asserted by e2e `noPageScroll`).

**SLA presentation.** Cards show the server's remaining working time as the headline. A budget bar shows `(budgetMs − remainingMs) / budgetMs`; it is drawn only while a clock is running or paused, is full and red when the server says `currentLate`, and is amber at ≥ 80 % of budget or while paused. The client computes no deadlines, lateness or countdowns. The working-hours rule (Mon–Fri 09:30–18:30 IST, excluding configured holidays) is stated under the clocks.

**Conversation.** Each message is an avatar plus a header row (author, kind badge, IST time) and a bubble:
- customer: neutral bubble
- public reply: light teal
- information request: blue, labelled
- original request: labelled
- internal note: amber with a dashed border, lock icon and "Internal note · team only"

The composer is a segmented control (radiogroup) with a separate draft per mode. Note mode turns the whole composer amber with a "TEAM ONLY" banner.

**Customer portal.** It is warmer and simpler: customer-side status wording ("Waiting for your reply"), "You" and "Support team" labels, an explanation under the reply box of what reopening or a follow-up does, the support hours, and grouped JSON/CSV downloads. It still uses public DTOs only.

**Preserved contracts.** The e2e suites depend on accessible names, roles, test IDs and some DOM relationships, and all of them were kept:
- the priority badge sits in the element just before `#ticket-title`
- "Assigned to …" appears exactly once
- list names are `"{view} tickets"`
- the `Response SLA` / `Resolution SLA` regions
- `data-kind` on messages
- composer radio, label and button names

No API, auth, session, CSRF or permission behaviour changed.

**Deferred (deliberately).**
- Dark theme (the tokens are ready, but it needs a full contrast pass).
- A Radix tooltip and popover primitive (the CSS `Tip` covers icon buttons today).
- Per-view counts in the sidebar (needs a server count endpoint; client counts of partial pages would mislead).
- A command palette and keyboard navigation between tickets.
