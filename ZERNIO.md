# Zernio integration

Prepared on 2026-11-15. This branch is not deployed. No real number was connected and no message was sent by this work.

## Member flow

Connect WhatsApp → hosted Zernio/Meta signup → return to Closer → save creator details and prices → activate bot.

The connection selector distinguishes the WhatsApp Business phone app (coexistence) from an existing API number such as 360dialog. Meta still controls number eligibility, verification and message approval. Each Closer user has a separate Zernio profile. API credentials stay on the engine.

The callback is bound to the signed-in actor and target user by an expiring, single-use server record. The engine verifies the returned account belongs to that profile. Account IDs and phone numbers cannot be assigned to two Closer users.

The hosted flow creates the scoped webhook automatically. After connection, missing opening/follow-up templates are submitted as MARKETING; existing templates are reused. Approval is checked from Meta via Zernio. Connecting never activates the bot. Do not run Zernio Workflows/AI on these same conversations: the existing Closer engine supplies negotiation and replies.

## Controls and reliability

- New global send switch starts OFF; every new connection starts paused.
- Engine requests require a verified Supabase user token. Only the configured administrator can manage another member.
- Live account health, valid membership and both pause switches are checked before sends. Individual contact pauses are rechecked after AI generation.
- Webhooks require HMAC verification of raw bytes. A durable event journal acknowledges only after storage, deduplicates events and recovers leased jobs after restart.
- Incoming phone matching uses the entire number within one account. A phone-hidden BSUID uses an already-known conversation; it is never guessed from digits.
- Phone-app/human messages, standby events, opt-outs and unsupported media pause the conversation for a person.
- Outbound attempts have a persistent identity and Zernio Idempotency-Key. An ambiguous timeout/5xx is held for review instead of blindly resent. Inspect the Zernio conversation and outbound record before resuming; do not clear an ambiguous record without reconciliation.
- Free-text sends require a recent inbound message. Negotiation rules are unchanged by the provider swap: price tiers, the two-round hold at the mid price, the minimum-price guard, the 18-hour silence close on the brand's best real offer, follow-up timing, the 5-minute reply delay, the 15-minute lost-reply rescue and the admin test mode behave as in the pre-Zernio engine.
- Existing Tracker reporting remains in place. This work does not claim to have verified delivery to the live Tracker or made its reporting durable.

## Coordinated rollout (not executed)

1. Obtain the owner's Zernio account/API access. Add the engine-only variables from `.env.example` in Railway; preserve existing Supabase, AI, timing and Tracker variables. `ADMIN_EMAIL` must match the panel's administrator. Use distinct credentials, profiles and webhook secrets for staging. Do not test staging against production Supabase.
2. Verify Zernio's account fees, balance, number eligibility, approved template names/languages and the actual Anthropic models configured for this account. Do not buy a number or plan automatically.
3. Schedule the migration with the four users. Stop the old sending process during the coordinated switch; the old 360dialog engine does not understand the new pause switch. Preserve the prior deployment and credentials for rollback.
4. Apply `supabase/migrations/20261116033514_zernio_onboarding.sql` to the Closer database after review. It preserves leads, deals and legacy credentials, and removes browser access to legacy credentials. New state is server-owned with RLS and restricted grants.
5. Deploy this engine and the companion web branch together. `/health` must identify `provider: zernio`. The panel refuses to use an old engine. Keep the global switch off.
6. The owner connects a test number in the new panel. Confirm callback identity, number health, webhook signature/durable receipt and approved templates with that real account. Then test one expressly designated recipient's inbound, reply, delivery and human takeover. Do not activate existing contact queues for this test.
7. Connect the remaining users. Verify their profile, prices and contacts with permission to receive WhatsApp messages. Enable global sends, then let each user activate their bot. The API cannot guarantee no account restrictions or allow unrestricted promotional outreach; US marketing restrictions still apply.
8. Verify a real close reaches the existing Tracker once. Only then retire 360dialog. A rollback also needs provider routing restored; rolling code back alone does not reconnect a migrated number.

## Verification completed locally

`pnpm test`: policy, API authentication/tenant isolation, HMAC/deduplication, ambiguous sends, one-use callbacks, human takeover and real PostgreSQL-compatible migration tests using PGlite. External providers are mocked; no paid API calls are used.

Companion Next panel builds successfully with dummy environment values. Browser verification used a localhost-only fixture for login, connection redirect/return, activation, pause and the administrator's global stop. The fixture is not part of production code.

## Primary contracts checked

- https://docs.zernio.com/platforms/whatsapp/connect
- https://docs.zernio.com/platforms/whatsapp/inbox
- https://docs.zernio.com/platforms/whatsapp/templates
- https://docs.zernio.com/webhooks
- https://docs.zernio.com/accounts/get-account-health
- https://docs.zernio.com/messages/send-inbox-message

Read the last endpoint's ambiguous-failure caveat before changing retries: idempotency records persist for 24 hours, and non-2xx outcomes are not cached.
