/**
 * Playwright selectors for the Lemon Squeezy checkout page.
 * Isolated here for easy maintenance when LS changes their checkout UI.
 *
 * The LS checkout embeds Stripe Elements in iframes for card fields.
 * Non-card fields (email, name) are on the main page.
 */
export const checkoutSelectors = {
	// Main page selectors
	emailInput: 'input[type="email"]',
	nameInput: 'input[name*="name"], input[placeholder*="name" i]',
	submitButton: 'button[type="submit"], [data-testid="submit"], button:has-text("Pay")',

	// Stripe iframe selectors — card fields live inside iframes
	stripeCardFrame: 'iframe[name*="__privateStripeFrame"], iframe[title*="card" i], iframe[src*="stripe"]',
	stripeCardInput: 'input[name="cardnumber"], input[placeholder*="card number" i]',
	stripeExpiryFrame: 'iframe[name*="__privateStripeFrame"], iframe[title*="expir" i], iframe[src*="stripe"]',
	stripeExpiryInput: 'input[name="exp-date"], input[placeholder*="MM" i]',
	stripeCvcFrame: 'iframe[name*="__privateStripeFrame"], iframe[title*="cvc" i], iframe[title*="cvv" i], iframe[src*="stripe"]',
	stripeCvcInput: 'input[name="cvc"], input[placeholder*="CVC" i]',

	// Fallback: if LS uses direct inputs instead of Stripe iframes
	cardNumberInput: 'input[name*="card"], input[data-elements-stable-field-name="cardNumber"]',
	expiryInput: 'input[name*="expir"], input[data-elements-stable-field-name="cardExpiry"]',
	cvcInput: 'input[name*="cvc"], input[name*="cvv"], input[data-elements-stable-field-name="cardCvc"]',
} as const;
