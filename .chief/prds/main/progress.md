## Codebase Patterns
- Plugin uses `satisfies BetterAuthPlugin` pattern from better-auth
- Schema fields use `type: "string" as const` for type narrowing
- Client plugin uses `$InferServerPlugin` for automatic type inference from server plugin
- All types exported from `src/types.ts`, re-exported from `src/index.ts`
- Schema defined in `src/schema.ts` with `lsCustomer` and `lsSubscription` tables
- Use `index: true` on schema fields for database indexes (not automatic from `references`)
- Server entry: `src/index.ts`, Client entry: `src/client.ts`
- `init(ctx)` receives AuthContext — use `ctx.adapter` for DB operations and `ctx.logger` for logging
- `databaseHooks` go inside `init()` return: `{ options: { databaseHooks: { user: { create: { after(user) {} } } } } }`
- Use `sessionMiddleware` from `better-auth/api` in `use: [sessionMiddleware]` for authenticated endpoints — ensures `ctx.context.session` is non-null
- Lemon Squeezy API uses JSON:API spec — requests need `application/vnd.api+json` content type
- Lemon Squeezy customer creation: POST /v1/customers with data.relationships.store for store linking
- Endpoints use `createAuthEndpoint(path, { method, requireRequest?, metadata? }, handler)` from `better-auth/api`
- Use `metadata: { SERVER_ONLY: true }` to exclude endpoints from CSRF protection (webhooks)
- Adapter: `findOne({ model, where: [{ field, value }] })`, `update({ model, update, where: [{ field, value }] })`, `findMany({ model, where: [{ field, value }] })`
- In endpoint handlers, access adapter via `ctx.context.adapter` and `ctx.context.internalAdapter`
- `ctx.context.internalAdapter.findUserByEmail(email)` returns `{ user }` or null
- Use `requireRequest: true` in endpoint options to access `ctx.request` (native Request object)
- Webhook signature: `request.headers.get("x-signature")` for Lemon Squeezy HMAC SHA-256
- LS webhook payload structure: `{ meta: { event_name, custom_data: { userId } }, data: { id, attributes: { ... } } }`

---

## 2026-04-10 - US-001
- Implemented plugin skeleton with `lemonSqueezy()` server function and `lemonSqueezyClient()` client function
- Created full TypeScript types for all config options (LemonSqueezyOptions, LemonSqueezyPlan, SubscriptionConfig, etc.)
- Defined database schema for lsCustomer and lsSubscription tables
- Plugin registers with id: "lemonsqueezy"
- Files changed: `src/index.ts`, `src/client.ts`, `src/types.ts`, `src/schema.ts`, `package.json`, `tsconfig.json`
- **Learnings for future iterations:**
  - Better Auth plugins use `createAuthEndpoint` from `better-auth/api` for endpoints
  - Client plugins use `BetterAuthClientPlugin` from `better-auth/client`
  - Schema uses `references: { model: "user", field: "id" }` pattern for foreign keys
  - Hooks use `databaseHooks` with `create.after` pattern for post-signup logic
  - Endpoint paths follow `/plugin-id/action` convention
---

## 2026-04-10 - US-002
- Added `index: true` to both `userId` fields in lsCustomer and lsSubscription schemas for efficient lookup
- Schema already had all required fields from US-001; this story specifically required indexes and migration integration
- Files changed: `src/schema.ts`
- **Learnings for future iterations:**
  - Better Auth does NOT auto-create indexes for `references` fields — must explicitly add `index: true`
  - The `unique: true` property creates a unique index, but `index: true` is still needed for regular indexed lookups
  - Schema is passed to the plugin via `schema` property and Better Auth migration system picks it up automatically
---

## 2026-04-10 - US-003
- Implemented auto-create Lemon Squeezy customer on sign-up via `init(ctx)` with `databaseHooks.user.create.after`
- When `createCustomerOnSignUp: true`, calls LS API POST /v1/customers with user's email/name
- Stores returned customer ID in lsCustomer table via `ctx.adapter.create()`
- Invokes `onCustomerCreated` callback if configured
- Errors are caught and logged via `ctx.logger.error()` — sign-up is never blocked
- Files changed: `src/index.ts`
- **Learnings for future iterations:**
  - `init(ctx)` AuthContext provides `ctx.adapter` (low-level DB) and `ctx.internalAdapter` (high-level user/session ops)
  - `ctx.logger` available for structured logging
  - `create.after` hook receives the created record (or null); `create.before` receives `(data, endpointCtx)`
  - Lemon Squeezy API: POST /v1/customers uses JSON:API format with `data.type`, `data.attributes`, `data.relationships`
---

## 2026-04-10 - US-004
- Implemented POST /lemonsqueezy/webhook endpoint with HMAC SHA-256 signature verification
- Created `src/webhook.ts` with all webhook processing logic
- Handles all 10 subscription events: subscription_created, subscription_updated, subscription_paused, subscription_unpaused, subscription_cancelled, subscription_expired, subscription_payment_success, subscription_payment_failed, subscription_payment_recovered, subscription_payment_refunded
- User correlation with 3-tier priority: (1) meta.custom_data.userId, (2) lsCustomerId lookup in lsCustomer, (3) email fallback (respects allowEmailFallback config)
- Stale event detection: compares incoming updated_at vs stored lsUpdatedAt, skips older events
- Payment events only trigger conditional status updates (not full upserts)
- Upsert by lsSubscriptionId for idempotency on all non-payment events
- Unresolvable users logged with warning, onWebhookEvent still invoked with resolved: false
- Duplicate plan detection on subscription_created with duplicatePlan flag in callback
- Returns 400 for invalid signature, 200 OK for all valid webhooks (including unhandled event types)
- Endpoint excluded from CSRF via `metadata: { SERVER_ONLY: true }`
- Files changed: `src/index.ts`, `src/webhook.ts`
- **Learnings for future iterations:**
  - Web Crypto API (`crypto.subtle`) works for HMAC SHA-256 in modern Node.js/Bun runtimes
  - Better Auth adapter has no native upsert — use findOne + create/update pattern
  - `ctx.request.text()` gives raw body for signature verification (use `requireRequest: true`)
  - Payment events (subscription_payment_*) should NOT create/update subscription records — only conditional status changes
  - LS event `subscription_unpaused` (not `subscription_resumed`) — preserve original event name
---

## 2026-04-10 - US-005
- Implemented POST /lemonsqueezy/subscription/create endpoint with authenticated session via `sessionMiddleware`
- Accepts plan, optional interval (defaults to first key), optional successUrl/cancelUrl (falls back to config defaults)
- On-demand customer creation if no lsCustomer record exists, with insert-or-ignore for concurrency
- Idempotency: in-memory lock per userId+plan+interval key, 60s checkout URL cache
- Validates plan exists, interval is valid, no active subscription for same plan
- Generates Lemon Squeezy checkout URL via API with customer linking and userId in custom_data
- Extracted `createLsCustomer()` helper to reuse between sign-up hook and checkout flow
- Files changed: `src/index.ts`
- **Learnings for future iterations:**
  - `sessionMiddleware` from `better-auth/api` ensures `ctx.context.session` is non-null — add to `use: [sessionMiddleware]` in endpoint options
  - Lemon Squeezy checkout API: POST /v1/checkouts with relationships for store + variant, attributes for checkout_data, custom_data, product_options, checkout_options
  - The checkout URL is at `data.attributes.url` in the response
  - Use `checkout_data.custom.customer_id` to link checkout to existing LS customer
  - Use `custom_data.userId` to pass userId for webhook correlation
---
