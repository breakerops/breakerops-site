# Invite-only admission: phone-first

Status: backend built and tested, nothing deployed or activated. No live invitations, no SMS sent, no prospects contacted.

Approved direction (Jake, October 20, 2026, verified phone messages):
- Five invitations per customer, Jake controls the allowance, no automatic refill, displayed count is real (phonemsg-01M5D4K9J0724FFASWVE9YJ3Y9, phonemsg-01M5D4HWNJZX20EMKTSKFFZP8Q).
- Invitations bind to the buddy's PHONE NUMBER, not email. The buddy starts by texting Matt; no email signup, account, or app setup upfront (phonemsg-01M5D7NG1QA4X04QRA8HY0GTP8).
- The Home Screen app comes days later, after they've been talking to Matt; Jake questions whether any login is needed even then (phonemsg-01M5D7RK9ZXXXCN3MNJF4NNA6D).
- The earlier email-bound model (v1, preserved in git history as invite-core-email-v1.sql) is superseded.

## The v2 model

1. Customer texts Matt: "invite my buddy, +1..." The desk matches the sender's phone to their bound customer row (admin-only binding) and issues a phone-bound invitation. Jake's original request was a LINK the customer can pass along; admission still keys on the invited phone either way. Whether Matt texts the buddy first, the customer forwards a link that opens a text to Matt, or both, is a proposed delivery choice, not settled - the admission rule (one invited phone, one business) does not change.
2. The buddy texts Matt whenever ready. The inbound handler (telnyx-inbound.ts, undeployed) calls `redeem_on_inbound`, which atomically creates their SEPARATE business (phone-owned, no name until learned in conversation, no account) and consumes the invitation. Existing admitted phones route to the conversation; unknown phones route to the public lead path.
3. At most one pending invitation per phone across all customers (advisory-lock serialized; race-tested). Inviting an admitted phone or an existing customer's phone is rejected.
4. Days later, the Home Screen app: the phone-owned business binds to an account via `bind_business_account`, only after phone possession is proven (see "App access" below). Production provisioning into public.businesses with explicit zero pricing happens only after that binding.

## App access: verified routes (no email/password either way)

Texting phase needs no LOGIN, but sender identity is only as strong as the channel: the inbound handler must verify the Telnyx ed25519 webhook signature plus a replay window before trusting any from-phone (SMS sender numbers can be spoofed), and it fails closed when verification is unavailable. Admission binding is per invited phone inside signature-verified events.

For the days-later app (their calendar view must show only THEIR business):
- Route A, scoped display link: Matt texts a one-tap link that opens the calendar view for their business only. The link is a revocable bearer secret; "add to Home Screen" keeps it. Recovery = Matt texts a fresh link; revocation = server-side. No login screen anywhere; the link itself is the (invisible) authentication. Weakest point: anyone holding the link can read the private calendar, so this route is NOT enabled by default and needs Jake's explicit choice with that risk stated.
- Route B, Supabase phone OTP: real auth session with no email/password. Verified current capability: phone sign-in via SMS OTP (https://supabase.com/docs/guides/auth/phone-login) and the Send SMS Hook, which replaces Supabase's built-in SMS sending with your own provider, so Telnyx can carry the codes (https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook). OTPs are rate-limited (one per 60s default, 1h expiry). Cost: SMS per sign-in; one code entry at install; revocation via admin.

Not decided: which route. A raw phone number alone cannot safely grant private-calendar access (anyone could type it), so one possession proof - link or code - is required at the app step. Both keep Jake's "no login" feel; B is the durable one if the app gains account features.

## Implemented and tested (v2)

`invite-core.sql` (staged schema, never persisted), `service-wrappers.sql` (service_role only), `functions/invites-issue.ts` and `functions/telnyx-inbound.ts` (undeployed). Tests, all PASS against the project's real Postgres:
- `invite-core-tests.sql` (rollback): five cap, idempotency, duplicate-phone-across-customers, activation gate, redeem admitted/member/none, admitted/customer phone rejected, revoke frees phone+slot, expired pending reclaimed, account binding rules.
- `wrapper-tests.sql` (rollback): desk issue by customer phone, unknown phone, admin-only allowance/binding, redeem wrapper, revoke wrapper.
- Race test (`invite-race-*.sql`, two concurrent committed sessions): same buddy phone invited by two customers at once; exactly one succeeds, the other fails with 'phone already invited'. Fixture cleaned to zero.
- Grants: anon permission denied on all wrappers; service_role executes.
Live teardown (`invite-live-teardown.sql`) verified: zero staged objects remain.

## Missing before anything is operational (the real blockers)

1. Telnyx has no payment method (Jake previously: "I don't want to yet"). Every Matt reply, welcome text, or OTP code is SMS spend. This is THE blocker; everything else is built around it. 10DLC campaign status is also unverified - unregistered senders get carrier-rejected.
2. The inbound webhook URL must be added to the Telnyx messaging profile (owner action once live).
3. Activation decisions still open: expiry per link (7-day default proposed, Jake's question unanswered), app-access route A vs B, zero-pricing default for referred businesses, activation switch (OFF).

## Existing-user and public-flow guarantees

Public requests stay public and unchanged. Existing users keep access. `user_invites` (coworker queue) is untouched. Acceptance never touches the inviter's workspace or implies a paid plan.
