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
