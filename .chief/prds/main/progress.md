## Codebase Patterns
- Project uses Better Auth plugin pattern — `betterAuth()` with `plugins: [lemonSqueezy({...})]`
- Main tsconfig only includes `src/` — e2e files are typechecked by vitest at runtime
- Existing tests use `vitest` with `vi.fn()` mocks; e2e tests use real API (no mocks)
- Database for tests: SQLite via `better-sqlite3` (file-based, `e2e/test.db`)
- Auth client: `createAuthClient()` from `better-auth/client` with `lemonSqueezyClient()` plugin
- E2E shared state: mutable `ctx` object in `e2e/fixtures/context.ts`, hydrated via vitest `inject()`
- Better Auth client Proxy converts camelCase to kebab-case URLs — don't use the client for e2e API calls; use direct `fetch` to `${ctx.serverUrl}/api/auth/lemonsqueezy/...` instead
- LS checkout page uses Stripe Elements in iframes — use `page.frameLocator('iframe[src*="stripe"]')` to access card inputs
- Vitest global setup returns a teardown function (no separate globalTeardown file needed)
- Server converts Node HTTP req → Web Request for Better Auth's `auth.handler()`
- Tunnel: cloudflared prints URL to stderr, matched via regex
- LS API: base `https://api.lemonsqueezy.com/v1`, Bearer auth, JSON:API format (`data.id`, `data.attributes`), accept `application/vnd.api+json`
- Default `vitest run` needs `vitest.config.ts` with `exclude: ["e2e/**"]` to prevent e2e tests from running without env vars
- Customer creation is async (database hook `after` user create) — poll the DB to wait for lsCustomer record
- Local DB can be queried directly via `new Database("e2e/test.db", { readonly: true })` in tests
- Subscription management endpoints (cancel/resume/update) trigger LS API calls but don't update local DB — webhook is source of truth, so poll DB for changes after API calls

---

## 2026-04-13 - US-001
- What was implemented: E2E test infrastructure — vitest config, global setup/teardown, test server fixture, tunnel fixture, shared context, env validation, helpers (poll, auth-client, mcp-client), checkout selectors stub, .env.e2e.example
- Files changed:
  - `vitest.config.e2e.ts` — sequential, single-fork vitest config for e2e
  - `e2e/global-setup.ts` — starts server + tunnel, provides URLs to tests
  - `e2e/fixtures/server.ts` — Better Auth + lemonSqueezy plugin on port 4738
  - `e2e/fixtures/tunnel.ts` — cloudflared tunnel management
  - `e2e/fixtures/env.ts` — env var validation with clear error messages
  - `e2e/fixtures/context.ts` — shared mutable E2EContext
  - `e2e/helpers/poll.ts` — generic poll-until-truthy helper
  - `e2e/helpers/auth-client.ts` — configured Better Auth client for test server
  - `e2e/helpers/mcp-client.ts` — re-export MCP server factory
  - `e2e/selectors/checkout.ts` — Playwright checkout page selectors
  - `e2e/.env.e2e.example` — template for all required env vars
  - `package.json` — added `test:e2e` script
  - `.gitignore` — added `e2e/test.db` and `.env.e2e`
- **Learnings for future iterations:**
  - The `provide()` / `inject()` API in vitest global setup requires `vitest/node` import for `GlobalSetupContext`
  - Module augmentation for `ProvidedContext` must be in the global-setup file for vitest to pick it up
  - cloudflared quick tunnels output their URL to stderr (not stdout)
  - Better Auth's `handler()` takes a Web Request and returns a Web Response — the server fixture bridges Node HTTP ↔ Web API
---

## 2026-04-13 - US-002
- What was implemented: API smoke tests validating LS test store configuration (tests 1.1–1.7)
- Files changed:
  - `e2e/01-api-smoke.test.ts` — 7 smoke tests: API key validity, store existence, product existence (pro + enterprise), variant existence (pro + enterprise monthly/annual), tunnel reachability
- **Learnings for future iterations:**
  - LS API uses JSON:API format — responses have `data.id`, `data.attributes`, etc.
  - LS API base URL: `https://api.lemonsqueezy.com/v1`, auth via `Bearer` token, accept `application/vnd.api+json`
  - Variant filtering: `GET /v1/variants?filter[product_id]=...` returns all variants for a product
  - `getEnv()` from `e2e/fixtures/env.ts` provides typed access to all required env vars
  - Tunnel reachability check: any status < 500 confirms the tunnel is routing traffic
---

## 2026-04-13 - US-003
- What was implemented: Customer lifecycle tests (tests 2.1–2.3) + base vitest config to exclude e2e from unit test runs
- Files changed:
  - `e2e/02-customer-lifecycle.test.ts` — 3 tests: sign-up creates LS customer (local DB + API verification), customer data matches, duplicate sign-up idempotency
  - `vitest.config.ts` — base config excluding `e2e/**` from default `vitest run`
- **Learnings for future iterations:**
  - `createCustomerOnSignUp: true` triggers an async database hook — customer creation happens after user creation returns, so poll the DB
  - Better Auth client `signUp.email()` returns `{ data: { user, session } }` — session.token is needed for authenticated requests
  - LS API customer attributes include `store_id` as a number (not string) — compare with `Number(env.E2E_LS_STORE_ID)`
  - Duplicate email sign-ups are rejected by Better Auth — no duplicate lsCustomer records can be created
  - Must populate `ctx.serverUrl` from `inject("serverUrl")` in `beforeAll` before using `getAuthClient()`
---

## 2026-04-13 - US-004
- What was implemented: Playwright checkout flow tests (tests 3.1–3.8) — creates checkout URLs, automates LS checkout page with Playwright, verifies webhook-driven subscription records, tests duplicate checkout blocking, multi-plan support
- Files changed:
  - `e2e/03-checkout.test.ts` — 8 tests: checkout URL creation, Playwright checkout completion (pro monthly + enterprise annual), webhook subscription verification, subscription list/get, duplicate checkout blocking
  - `e2e/selectors/checkout.ts` — expanded with Stripe iframe selectors, fallback direct input selectors, documented selector strategy
  - `package.json` / `package-lock.json` — added `playwright` dev dependency
  - `.gitignore` — added `e2e/screenshots`
- **Learnings for future iterations:**
  - Better Auth client Proxy maps `client.lemonSqueezy.subscription.create()` to `/api/auth/lemon-squeezy/subscription/create` (kebab-cased), but server expects `/api/auth/lemonsqueezy/subscription/create` — use direct `fetch` calls for e2e API testing
  - LS checkout page embeds Stripe Elements in iframes — card fields need `page.frameLocator('iframe[src*="stripe"]')` to access
  - Playwright `chromium.launch()` requires `npx playwright install chromium` to be run first (in CI, add this step)
  - Subscription records are created via webhooks (not API response) — poll the DB with 30s timeout after checkout completion
  - `subscription/create` returns `{ url: string }` on success, `{ error, code: "already_subscribed" }` with status 400 on duplicate
  - `subscription/list` returns `{ subscriptions: [...] }`, `subscription/get` returns `{ subscription: {...} }`
---

## 2026-04-13 - US-005
- What was implemented: Subscription management tests (tests 4.1–4.8) — portal URL, sync, update plan, cancel, resume, with webhook-driven DB verification
- Files changed:
  - `e2e/04-subscription-management.test.ts` — 8 tests: portal URL retrieval, sync from API, update plan (pro→enterprise), webhook plan change verification, cancel subscription, webhook cancelled status, resume subscription, webhook active status restoration
- **Learnings for future iterations:**
  - `subscription/portal` (POST) returns `{ url: string }` — the portal URL from LS API's `data.attributes.urls.customer_portal`
  - `subscription/sync` (POST) returns `{ success: true, subscription: {...} }` — fetches fresh state from LS API and updates local DB
  - `subscription/update` (POST) takes `{ subscriptionId, plan, interval? }` — changes variant via LS API PATCH
  - `subscription/cancel` (POST) takes `{ subscriptionId }` — sets `cancelled: true` via LS API PATCH (cancels at period end)
  - `subscription/resume` (POST) takes `{ subscriptionId }` — sets `cancelled: false` via LS API PATCH
  - All management endpoints are idempotent — cancel on already-cancelled returns success, resume on already-active returns success
  - Webhook is source of truth for status changes — after API calls, poll DB for webhook-driven updates rather than trusting API response
---

## 2026-04-13 - US-006
- What was implemented: Webhook security tests (tests 5.1–5.4) — invalid signature rejection, missing signature rejection, malformed body rejection, unknown event type graceful handling
- Files changed:
  - `e2e/05-webhook.test.ts` — 4 tests: invalid signature (wrong secret) returns 400 `invalid_signature`, missing X-Signature header returns 400 `invalid_signature`, valid signature + malformed JSON returns 400 `invalid_body`, valid signature + unknown event `order_created` returns 200 success
- **Learnings for future iterations:**
  - Webhook endpoint returns 400 (not 401) for invalid/missing signatures with code `invalid_signature`
  - Malformed JSON with valid signature returns 400 with code `invalid_body`
  - Unknown event types are processed gracefully — `processWebhookEvent` simply ignores unrecognized events and returns 200
  - HMAC-SHA256 signatures can be computed with Node.js `createHmac("sha256", secret).update(body).digest("hex")` for test payloads
  - Webhook endpoint path is `/api/auth/lemonsqueezy/webhook` (POST only)
---

## 2026-04-13 - US-007
- What was implemented: Access control tests (tests 6.1–6.6) — `hasActiveSubscription`, `hasActivePlan`, and `requirePlan` tested against real subscription data in SQLite DB
- Files changed:
  - `e2e/06-access-control.test.ts` — 6 tests: hasActiveSubscription true/false, hasActivePlan correct/wrong plan, requirePlan allowed/denied
- **Learnings for future iterations:**
  - `createAccessControlHelpers` accepts a minimal adapter with just `findMany` — can be created directly from `better-sqlite3` without needing a full Better Auth adapter
  - `secondUser` in `E2EContext` is defined but never populated by any test suite — use a non-existent user ID for "no subscription" test cases instead
  - Suite 4 cancels then resumes the pro subscription, so by Suite 6 the pro subscription is back to active status — no need to worry about stale cancelled state
  - Access control helpers query local `lsSubscription` table only (no LS API calls), making them fast and reliable for e2e tests
---
