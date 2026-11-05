# CLAUDE.md for breakerops-site

BreakerOps is a text-first assistant for electrical contractors with 1 to 3 trucks. The assistant is Matt. Owners text Matt; Matt files what they said. The owner never types into the site. The site is a calm, read-only place to glance and check.

## Hard rules (no exceptions)

1. Nothing goes live without Jake's explicit go in this conversation. "Live" means: a push or merge to `main` (GitHub Pages deploys `main` to www.breakerops.com), any Supabase SQL applied, any edge function deployed, any secret or connection changed, any DNS or Pages setting changed. Ask, show what will change, wait for "go."
2. No email, text, call, DM, or form submission to anyone outside, ever, unless Jake approves that exact message, recipient, and channel. This includes test sends, formsubmit pings, Telnyx, Resend, and outreach to leads. Do not submit the live signup form.
3. No em dashes in any copy, comment shown to users, or commit message. Use a period, comma, or "to."
4. Short, icon-led design. Fewer words, more visuals. One "Text Matt" button. No dashboards, counters, overdue badges, red alerts, or guilt language.
5. Matt only knows what was texted. Any total, list, or status says "as far as Matt knows." Never invent numbers, testimonials, logos, or guarantees.
6. No tax, legal, HR, insurance, or payroll advice. Matt never speaks as the owner without per-message approval. No payments or passwords held.
7. Never put secrets, customer data, signups, or leads in this repo. It is public. Publishable keys only.
8. When unsure, stop and ask Jake instead of guessing.

## How work happens

- Default branch is `main`, and `main` is production. Work on a branch. Do not push without a go.
- New UI goes in a `*-preview/` folder first (noindex, no-cache meta). Promote to the live path only on Jake's go, in its own commit.
- Static HTML, inline CSS and JS per page, shared bits in `assets/`. No build step. Keep it that way unless Jake asks.
- Backend SQL and functions live in `backend/`. The live database has drifted from the repo, so never assume a file here is what is applied. Check first, apply nothing without a go.

## Verify every UI change before reporting it done

1. Serve locally: `python3 -m http.server 8765` from the repo root.
2. Screenshot at 390x844 (iPhone), 2x scale, light and dark, before and after.
3. Check the console for errors and that every screen and deep link (`#jobs`, `#money`, ...) still opens.
4. Show Jake the before and after side by side. Say what changed in one line.

## Copy checklist

- Under 8 words per label where possible. Icon first.
- No em dashes. No exclamation points. No "Worth a try?"-style closers.
- Totals say "as far as Matt knows."
- Plain words a busy electrician reads in two seconds.

## Internal controls (who makes, who checks, who approves)

Accounting-style separation of duties: the one who makes a thing never approves it, and no one approves their own work.

### Roles

- Maker: whoever builds the thing. Claude for code and site changes. Instinct for outreach emails, research, and ops.
- Checker: the other side. Instinct checks every Claude PR before merge. Instinct's own outward-facing work runs the pre-show checklist below before Jake sees it.
- Approver: Jake, for anything live or anything headed to an outside person. Neither Claude nor Instinct can approve its own work.

### Authorization matrix

Needs Jake's explicit go, every time:

- Any merge to `main` (GitHub Pages deploys `main` to the live site).
- Any email, text, call, DM, or form submission to anyone outside, including test sends.
- Any Supabase SQL applied to the live database, any edge function deployed, any secret, connection, DNS, or Pages setting changed.
- Any spend.

Does not need a fresh go, but stays logged and checked:

- Drafting and staging: branches, `*-preview/` folders, unsent email drafts, research.
- Merging a PR for a change Jake already approved in the conversation.
- Reading live state (inbox counts, site, database reads) to report it.

### Pre-show checklist (runs before anything outward-facing is shown to Jake or goes out)

Applies to outreach emails, site copy, the signup flow, and any text or page a customer can see.

1. Facts and claims: every fact (permits, warranties, years in business, names, prices, project references) traces to a named source kept in the working notes, or is marked UNVERIFIED. Nothing from memory alone.
2. Address and contact details: business address, sender name, and reply address are confirmed with Jake once and stored as the single source. Reuse the stored value; never retype it. If Jake flags one as wrong, stop all use everywhere until he confirms the replacement.
3. Links: every link in the piece is opened in a real browser and lands on the intended page. A soft-404 or the wrong content fails this check even when the URL loads.
4. Real rendering: emails are test-sent to Jake's Gmail with a fresh subject and checked there; site changes are screenshotted at 390px mobile width and desktop, light and dark. Check what the reader actually sees, not the source.
5. Promises match reality: every confirmation or promise in copy (a text confirmation, a reply, a follow-up) matches what the system actually does today. If the system cannot do it yet, the copy changes before show.
6. Shipped bytes match reviewed bytes: after deploy, hash the live artifact and compare to the reviewed build. Report both hashes.

Show Jake only after every check passes, and say so in one line: "Passed the pre-show checklist," naming what was checked.

### What a PR must show before review and merge

- Sources (or UNVERIFIED marks) for every fact and claim in the copy, in the PR description.
- Address and contact values match the Jake-confirmed stored values.
- Every link in changed pages was opened and lands on the intended content.
- Before and after screenshots at 390x844, light and dark, plus a clean console (per the UI verification rules above).
- Any confirmation or promise in copy matches current system behavior; mismatches called out in the PR.
- For promotions to live paths: the sha256 of the reviewed build, so the post-merge deploy can be hash-compared.

### Hard stops (any one of these blocks a release or send)

- A fact without a source or an UNVERIFIED mark.
- An address or contact value that does not match the Jake-confirmed stored value.
- A link not opened, or landing on the wrong content.
- Rendering not checked in the real client (Gmail for email, 390px mobile and desktop for site).
- A promise the system cannot keep today.
- Live bytes not matching reviewed bytes.
- No Jake go for live or outward-bound work.

### Log (what records exist, kept automatically)

- Git history and PR reviews record every code change: who made it, who checked it, when it merged.
- Jake's gos live in the conversation with message IDs; quote them in the PR or send report they cover.
- Outreach sends keep a per-send record (recipient, subject, time, checks passed) and a batch count reported to Jake.

### Exceptions

- Anything unclear stops and asks Jake instead of guessing; silence is not a go.
- If a step in this doc cannot be run for a real reason (a tool down, a source offline), the work waits or goes to Jake with the gap named, never past the gap.

### Proposals (not enforced today, need Jake's ok)

- Two-way review: Claude reviews Instinct's site PRs, not just the reverse.
- Monthly self-audit: re-run the pre-show checklist on three shipped items picked at random and report the findings.
