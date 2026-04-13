# @better-auth/lemonsqueezy

A [Better Auth](https://www.better-auth.com/) plugin that integrates [Lemon Squeezy](https://www.lemonsqueezy.com/) subscription and payment management. Links authenticated users to Lemon Squeezy customers, syncs subscription state via webhooks, provides checkout and billing portal flows, and enables plan-based access control.

## Installation

```bash
npm install @better-auth/lemonsqueezy
```

### Peer Dependencies

- `better-auth` >= 1.2.0

## Quick Start

### Server Setup

```ts
import { betterAuth } from "better-auth";
import { lemonSqueezy } from "@better-auth/lemonsqueezy";

const auth = betterAuth({
  // ...your existing config
  plugins: [
    lemonSqueezy({
      apiKey: process.env.LEMONSQUEEZY_API_KEY!,
      storeId: process.env.LEMONSQUEEZY_STORE_ID!,
      webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET!,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [
          {
            name: "pro",
            productId: "prod_123",
            intervals: {
              monthly: "variant_456",
              annual: "variant_789",
            },
          },
        ],
      },
      defaultSuccessUrl: "https://myapp.com/billing?success=true",
      defaultCancelUrl: "https://myapp.com/billing?cancelled=true",
    }),
  ],
});
```

### Client Setup

```ts
import { createAuthClient } from "better-auth/client";
import { lemonSqueezyClient } from "@better-auth/lemonsqueezy/client";

const authClient = createAuthClient({
  plugins: [lemonSqueezyClient()],
});
```

## Configuration Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | **required** | Lemon Squeezy API key |
| `storeId` | `string` | **required** | Lemon Squeezy store ID |
| `webhookSecret` | `string` | **required** | Webhook signing secret for signature verification |
| `createCustomerOnSignUp` | `boolean` | `false` | Auto-create a Lemon Squeezy customer on user sign-up |
| `onCustomerCreated` | `(data) => void` | — | Callback after customer creation. Receives `{ userId, lsCustomerId }` |
| `onWebhookEvent` | `(event) => void` | — | Callback on any webhook event |
| `subscription` | `SubscriptionConfig` | — | Subscription plans configuration |
| `defaultSuccessUrl` | `string` | — | Fallback success URL for checkout |
| `defaultCancelUrl` | `string` | — | Fallback cancel URL for checkout |
| `allowEmailFallback` | `boolean` | `true` | When `false`, disables email-based webhook correlation. Recommended for security-sensitive deployments |
| `usageEndpoint` | `boolean` | `false` | Enable the usage reporting HTTP endpoint. **Do not expose in untrusted environments** |

### Plan Definition

```ts
interface LemonSqueezyPlan {
  name: string;       // Display name (e.g., "pro", "enterprise")
  productId: string;  // Lemon Squeezy product ID
  intervals: {
    monthly?: string; // Variant ID for monthly billing
    annual?: string;  // Variant ID for annual billing
  };
}
```

## Webhook Setup

The plugin exposes a `POST /api/auth/lemonsqueezy/webhook` endpoint that receives and verifies Lemon Squeezy events.

### Lemon Squeezy Dashboard Steps

1. Go to your [Lemon Squeezy Dashboard](https://app.lemonsqueezy.com/) > **Settings** > **Webhooks**
2. Click **Add Webhook** (or the `+` button)
3. Set the **Callback URL** to: `https://your-domain.com/api/auth/lemonsqueezy/webhook`
4. Set a **Signing Secret** and use the same value as `webhookSecret` in your plugin config
5. Subscribe to the following events:
   - `subscription_created`
   - `subscription_updated`
   - `subscription_paused`
   - `subscription_unpaused`
   - `subscription_cancelled`
   - `subscription_expired`
   - `subscription_payment_success`
   - `subscription_payment_failed`
   - `subscription_payment_recovered`
   - `subscription_payment_refunded`
6. Click **Save**

### Custom Webhook Logic

Use the `onWebhookEvent` callback to run custom logic on any event:

```ts
lemonSqueezy({
  // ...
  onWebhookEvent(event) {
    console.log(event.type);       // e.g., "subscription_created"
    console.log(event.userId);     // resolved user ID, or null
    console.log(event.resolved);   // whether user correlation succeeded
    console.log(event.data);       // raw Lemon Squeezy payload

    if (event.type === "subscription_payment_refunded") {
      // Handle refund logic
    }
  },
});
```

## Client-Side Usage

The client plugin provides typed methods for all subscription operations:

### Create a Subscription (Checkout)

```ts
const { url } = await authClient.subscription.create({
  plan: "pro",
  interval: "monthly", // optional, defaults to first configured interval
  successUrl: "https://myapp.com/success", // optional if server default is set
  cancelUrl: "https://myapp.com/cancel",   // optional if server default is set
});

// Redirect to the Lemon Squeezy checkout URL
window.location.href = url;
```

### Cancel a Subscription

```ts
await authClient.subscription.cancel({
  subscriptionId: "sub_123",
});
// Subscription stays active until the end of the billing period
```

### Resume a Cancelled Subscription

```ts
await authClient.subscription.resume({
  subscriptionId: "sub_123",
});
```

### Change Plan (Upgrade/Downgrade)

```ts
await authClient.subscription.update({
  subscriptionId: "sub_123",
  plan: "enterprise",
  interval: "annual", // optional
});
```

### List Subscriptions

```ts
const { subscriptions } = await authClient.subscription.list();
```

### Get a Single Subscription

```ts
const { subscription } = await authClient.subscription.get({
  subscriptionId: "sub_123",
});
```

### Billing Portal

```ts
const { url } = await authClient.subscription.portal({
  subscriptionId: "sub_123",
});

window.location.href = url;
```

## Access Control

Gate features based on subscription plans using server-side helpers:

```ts
import { createAccessControlHelpers } from "@better-auth/lemonsqueezy";

const { hasActiveSubscription, hasActivePlan, requirePlan } =
  createAccessControlHelpers(auth);

// Check if user has any active subscription
const isSubscribed = await hasActiveSubscription(userId);

// Check if user has a specific plan
const isPro = await hasActivePlan(userId, "pro");

// Gate an endpoint — returns { allowed, subscription? }
const result = await requirePlan(userId, "pro");
if (!result.allowed) {
  return new Response("Upgrade required", { status: 403 });
}
```

## Usage-Based Billing

For metered/usage-based subscriptions, use the server-side `reportUsage` helper (recommended):

```ts
import { createUsageReporter } from "@better-auth/lemonsqueezy";

const reportUsage = createUsageReporter(auth, process.env.LEMONSQUEEZY_API_KEY!);

// Report usage for a subscription
await reportUsage(userId, subscriptionId, 100);
```

An HTTP endpoint (`POST /api/auth/lemonsqueezy/usage`) is also available when `usageEndpoint: true` is set, but it is **not recommended** for production use as it allows authenticated users to report arbitrary usage.

## Serverless Environments

The plugin uses in-memory rate limiting, checkout URL caching, and request deduplication. These are **not shared across serverless instances** — each cold start gets a fresh state. In serverless deployments (e.g., AWS Lambda, Vercel Functions), rate limiting will be best-effort only and checkout deduplication may not prevent all duplicate API calls. This is acceptable for most use cases; the Lemon Squeezy API and webhook-based state sync remain correct regardless.

## Database Tables

The plugin creates two tables managed by Better Auth's migration system:

- **`lsCustomer`** — links users to Lemon Squeezy customer IDs
- **`lsSubscription`** — stores subscription state synced from webhooks

Run your Better Auth migrations to create these tables.

## License

MIT
