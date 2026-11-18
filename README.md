# BISCUIT

A responsive creator-support and digital-art storefront starter for the BISCUIT brand. The site uses an original dark violet/pink visual direction, an anime-inspired CSS character illustration, a filterable art gallery, digital product preview cards, a support amount selector, and a signature screw-drop celebration animation hook.

## Current status

This is a frontend starter, not a production payment system. The UI deliberately does not accept payments or deliver paid files yet. The Razorpay/server integration, authenticated owner dashboard, database persistence, and private digital asset delivery must be implemented and tested before launch.

## Instagram post scheduler

`scheduler/` contains an open-source (MIT), self-hosted website that schedules and automatically publishes Instagram posts through Meta's official Content Publishing API. See [scheduler/README.md](scheduler/README.md).

**Schedule a post:** [open the Instagram post form](https://github.com/YukeshWorks/Biscuit-collection/issues/new?template=instagram-post.yml). GitHub Actions publishes it at your time, for free, once the `IG_USER_ID` and `IG_ACCESS_TOKEN` secrets are set.

## Run locally

Open `index.html` in a modern browser, or run a local static server:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Design and interactions

- Responsive desktop/mobile navigation and bottom mobile dock
- Scroll progress, reveal-on-scroll, ambient glow, floating artwork and micro-interactions
- Filterable artwork gallery and artwork preview dialogs
- Digital product preview dialogs
- Tip amount selector with safe payment-not-configured state
- Screw/bolt success animation listens for a verified event only
- Reduced-motion support through `prefers-reduced-motion`

## Payment integration requirements

Before enabling checkout, implement a server-side payment flow using a provider such as Razorpay:

1. Server creates an order for a fixed, validated INR amount.
2. Browser redirects to the provider's secure checkout. Never collect card number, CVV, bank credentials or UPI PIN directly.
3. Server verifies the provider signature and webhook signature, idempotently records the payment, and validates order ID, amount and currency.
4. Only after server-verified success may the server mark a tip paid or grant a short-lived signed download URL for the purchased digital product.
5. Keep gateway secrets in the deployment platform's encrypted environment settings, not in frontend code or Git.

The current UI has `window.BISCUIT_CONFIG.paymentsConfigured = false`. Keep it false until a real server endpoint and verified payment handoff are deployed. The bolt animation listens for `biscuit:payment-verified`; dispatch that event only after a trusted server response proves payment success. A frontend event alone is not a security boundary.

## Art and licensing

The hero portrait and gallery/product art in this starter are CSS-built visual placeholders. Replace them with artwork you own or have a commercial licence to distribute. Keep paid originals in private object storage and serve only expiring authorized links after payment verification.

## Production checklist

- [ ] Create a backend and persistent database
- [ ] Add secure owner authentication and role-based authorization
- [ ] Add admin CRUD for profile, art, collections, products, tips and orders
- [ ] Store private original files separately from public low-resolution previews
- [ ] Integrate and verify payment orders and webhooks server-side
- [ ] Add refund, privacy, terms and digital-delivery policies
- [ ] Test responsive behavior, keyboard access and reduced motion
- [ ] Run security and real payment test-mode checks before enabling live mode

## Repository

GitHub repository: `YukeshWorks/Biscuit-collection`. No credentials or payment secrets belong in this repository.
