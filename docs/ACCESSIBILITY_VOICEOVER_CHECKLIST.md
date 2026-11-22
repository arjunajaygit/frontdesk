# Manual VoiceOver verification checklist (NOT YET PERFORMED)

Status: **not executed.** Automated evidence only: axe (WCAG 2.0/2.1/2.2 A/AA tags, serious/critical = 0) at
1440/1024/390 px for login, staff list/detail/history, customer portal and dialogs; keyboard-only sign-in;
dialog focus trap/Escape/focus return; reduced motion (`tests/e2e/a11y-responsive.spec.ts`). No conformance claim.

Setup: macOS VoiceOver (Cmd+F5), Safari, synthetic accounts from `.local/credentials.<label>.json`. Record date,
macOS/Safari versions, tester, and PASS/FAIL + notes per row. Repeat the customer rows on iOS VoiceOver if possible.

| # | Area | Steps | Expected |
|---|---|---|---|
| 1 | Login | VO+U → Form controls; fill Email/Password; submit; submit with a wrong password | Both fields announced with labels; error announced (live region) without moving focus unexpectedly |
| 2 | Landmarks | VO+U → Landmarks on staff workspace | banner, navigation "Ticket views", main, ticket list region; detail section labelled by the ticket title |
| 3 | Ticket list | Navigate list items | Each item announces subject, status, priority, SLA state as text (not colour only), assignee |
| 4 | Open ticket | Activate an item | Focus/heading moves to ticket title (h1); Response SLA and Resolution SLA regions announced with status text |
| 5 | Late vs waiting | FD-001 (breached) and FD-006 (waiting) | "Late"/"Breached" and "Paused while waiting on the customer" read as text |
| 6 | Reply vs note | Toggle composer radio group | Radio group name and "Internal note · team only" announced; note mode distinguishable without colour |
| 7 | Submit feedback | Send a reply; trigger a 409 claim conflict | "Reply sent." and the conflict message announced via live region |
| 8 | Timeline | Read messages; "Load older messages" | Author, time and visibility announced; new messages appended without stealing focus |
| 9 | Dialogs | New ticket; Run SLA sweep | Dialog role + name announced; focus trapped; Escape closes and returns focus |
| 10 | Mobile layout (390 px) | Open menu, navigate views, Back to list | Disclosure state (expanded/collapsed) announced |
| 11 | Customer portal | List, open FD-010, export | No internal-note text spoken anywhere; export link announced with its purpose |
| 12 | Audit/history tab | Open "SLA history & audit" | Tab/tabpanel semantics; events readable in order |
