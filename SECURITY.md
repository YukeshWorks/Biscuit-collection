# Security notes

- Never commit payment-provider secrets, private API keys, cardholder data, CVV, bank credentials, UPI PINs, private art originals, or production customer data.
- Do not accept a client-side flag, URL parameter, animation callback, or browser event as proof of payment.
- Verify provider signatures and webhooks server-side, validate the amount and currency, and make payment processing idempotent.
- Only provide paid downloads via authorization checks and short-lived signed URLs.
- Require authenticated owner privileges for every admin mutation.
