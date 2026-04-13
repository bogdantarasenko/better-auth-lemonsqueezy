/**
 * Playwright selectors for the Lemon Squeezy checkout page.
 * Isolated here for easy maintenance when LS changes their checkout UI.
 */
export const checkoutSelectors = {
	emailInput: 'input[type="email"]',
	cardNumberInput: 'input[name*="card"]',
	expiryInput: 'input[name*="expir"]',
	cvcInput: 'input[name*="cvc"], input[name*="cvv"]',
	nameInput: 'input[name*="name"]',
	submitButton: 'button[type="submit"]',
} as const;
