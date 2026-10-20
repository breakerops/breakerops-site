# Invite-only admission draft

Status: proposal and interactive sample preview. NOT deployed. No live invitations issued.

Approved direction (Jake, October 20, 2026): public requests stay; customers ask Matt for a one-use invitation for a buddy's email; Jake sets each customer's allowance. Five invitations per customer is approved; Jake may adjust allowances. Existing users remain active.

## Separate the concepts

- A public request is a lead, never admission.
- A customer referral is a product admission for a NEW business, never membership in the inviter's workspace.
- Existing `user_invites` are coworker invitation requests, not this admission mechanism.
- An Auth identity is not sufficient product admission. Product data/work must require active admission and membership.
- A quota belongs to the inviting customer business. Changing users must not reset it.

## Server boundary

1. `set_allowance`: only Jake's authenticated owner ID; nonnegative quota, no inferred refill.
2. `issue`: authenticated active customer or a trusted Matt adapter representing a verified customer. Lock that customer's allowance row. Count active, unexpired reservations plus accepted invitations. Reject when at quota. Generate a random 256-bit token, persist only its hash, fixed intended email, issuer, expiry and audit data. Return the raw link once. An idempotency key makes a retry return the same issuance outcome without spending another allowance. Raw tokens must not appear in logs.
3. `verify`: the raw link identifies an invitation, not an account. A challenge must go to its stored email through existing Auth/custom SMTP, never a browser-supplied replacement address. Generic responses avoid exposing invitation existence. Rate-limit by token and account, and avoid consuming an invite merely by GET or mail-scanner prefetch.
4. `redeem`: verify the authenticated user's current confirmed email against the stored intended email. Lock invitation and quota consistently. Check active issuer admission, unexpired/unrevoked/unconsumed invitation and quota reservation. Provision a separate business plus membership and active admission atomically with consumption. Return the existing completed outcome on retry by the same user; reject all other replays.
5. `revoke`: issuer or Jake may revoke an unused link. Revocation/expiry releases the reservation. Accepted invitations stay counted and cannot be silently converted into access revocation.
6. `inbound work`: the future Matt conversation handler must resolve the sender to an admitted account before model calls, task creation or outbound work. Unknown texters must not receive automatic onboarding until public-response words are approved. Current deployed Telnyx webhook only processes delivery receipts.

## Identity and storage

Auth public self-signup is currently disabled. Existing custom SMTP is configured. A safe email-challenge implementation must be tested without sending prospects mail; configuration is not delivery proof. Raw admission tokens should be in a URL fragment, removed from the address bar after capture, kept out of analytics/referrers, and exchanged via POST. Private schemas and RLS deny direct public reads/writes. Service role keys never reach the browser. Do not trust editable user_metadata for admission.

## Required tests before enabling

- No quota assigned: cannot issue. Quota zero: cannot issue.
- Concurrent issuance: never exceeds quota; idempotent retry doesn't reserve twice.
- Revoke/expire: reservation returned. Accepted: remains used.
- Wrong email, unconfirmed email, anonymous user, different account: cannot redeem.
- Concurrent redemption: exactly one separate business admitted.
- Retry after provisioning interruption: no orphan or duplicate business.
- Old member/coworker invitation cannot become product referral.
- Non-owner cannot change quotas or inspect another customer's invite list.
- Link or verification failures never activate service or spend SMS credits.
- Existing users, calendar and current reminder delivery remain unchanged.

## Unset decisions / dependencies

- Five is the approved default. It must be enforced by the server, not just displayed. No allowance is activated or assigned by this sample preview.
- Expiry period and quota recovery behavior are proposed, not yet activated; expiry should be configurable with the owner choosing the policy.
- New business provisioning must not imply a paid plan or billing obligation. Existing businesses contain plan/price fields; no pricing or payment consent is inferred from accepting a referral.
- The product's trusted sender-to-account mapping is not built. Email verification alone does not verify a phone number. This must be resolved before a phone sender is treated as an admitted customer.
- Auth email challenge/new-account activation needs an implementation and an end-to-end controlled test. No external invitation email is authorized by the preview.

## Implemented private core (not activated)

`invite-core.sql` implements the transaction core in a non-public staged schema. It compiles and its `invite-core-tests.sql` suite passes against the project's actual PostgreSQL engine inside a BEGIN/ROLLBACK transaction. Schema, fixture Auth users, quotas and invitations are all rolled back. No staged schema is deployed persistently.

Tests cover five-slot exhaustion, retry without another token, changed-recipient retry rejection, other-customer issuance denial, owner-only quota adjustment, disabled activation, wrong verified email, separate staged business creation, same-user redemption retry, no duplicate business, refusal to revoke accepted invites, and reclaim after unused revocation/expiry. Concurrent multi-session races remain to test. SQL row locking is present but is not reported as concurrency-test proof.

The test-only business table avoids production pricing defaults. Production wrappers, verified-email challenge orchestration, safe phone identity binding, the owner controls, and actual separate-business provisioning remain unfinished. All function execution is revoked from public/anon/authenticated. Production activation defaults OFF and no public RPC wrappers exist.
