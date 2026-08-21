/**
 * Return URLs handed to Chargebee's hosted pages.
 *
 * The Better Auth plugin resolves relative success/cancel URLs against the auth
 * base URL, so `/foo` comes back from Chargebee as `/api/auth/foo` and 404s.
 * Absolute URLs pass through untouched, and `window.location.origin` keeps them
 * on whichever host the user actually reached the app on.
 *
 * Browser-only: `window` is unavailable during server rendering.
 */
export function checkoutReturnUrls(cancelPath: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const { origin } = window.location;
  return {
    successUrl: `${origin}/api/entitlements/checkout-complete?callbackURL=%2F`,
    cancelUrl: `${origin}${cancelPath}`,
  };
}
