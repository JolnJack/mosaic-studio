# amadeu.tech deployment

These files prepare a self-hosted single-instance deployment. No DNS or server has been changed by this deliverable.

## Local

Node >=22.13 is required (native SQLite); tested runtime is documented in TEST-REPORT.md.

```sh
npm ci
cp .env.example .env
npm start
```

Open `http://127.0.0.1:4173` for the product page and `/app` for the studio. The explicit local workspace button is available only with LOCAL_WORKSPACE=1 in development on loopback. Public deployments disable it.

The provided local example uses IMPORT_DNS_MODE=doh (Cloudflare public DNS over HTTPS). This supports networks whose local DNS returns proxy benchmarking addresses; system mode remains available. The chosen destination address is always checked and pinned for the connection, including redirects. Imported domains are sent to that DNS resolver in doh mode.

## Model

Set AI_PROVIDER=anthropic, ANTHROPIC_API_KEY and AI_MODEL for native Claude Messages API (forced structured return tool). Leave AI_BASE_URL blank for the default Anthropic endpoint. For Chat Completions, set AI_PROVIDER=compatible, AI_API_KEY and AI_MODEL. Keys never belong in browser code or exported projects. Missing settings produce a configuration error; no template substitute is returned. Development tests use loopback fixture services only. Live production model calls can incur operating costs; startup credits are not assumed or promised.

## Server

1. Use an existing authorized Linux server with Docker/Compose and a backed-up persistent disk. Do not buy or provision new paid resources under the user's no-extra-development-spend constraint. If no existing host is available, keep local delivery and obtain a verified no-charge hosting route before deployment.
2. Copy source files and create a server-local .env (do not commit it).
3. Set model settings, APP_URL=https://app.amadeu.tech, NODE_ENV=production, LOCAL_WORKSPACE=0, and registration policy.
4. Create DNS A/AAAA records for amadeu.tech, app.amadeu.tech, and www.amadeu.tech pointing to that server. Only create AAAA when the server has working IPv6. HTTPS needs reachable ports 80/443.
5. Run `docker compose up -d --build`; Caddy obtains certificates after valid DNS reaches the server.
6. Check landing, account signup/login/logout, distinct accounts' project isolation, generation, edit/save/restore, export and phone layout over HTTPS.

The root domain serves the product page; app.amadeu.tech serves `/app` and same-origin `/api`. api.amadeu.tech is reserved for later separation and is deliberately absent from the initial configuration.

## Stripe

Use Stripe test mode for development; this delivery does not create or pay a real subscription. Configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, then per-tier recurring prices: STRIPE_PRICE_PRO_MONTHLY/YEARLY, STRIPE_PRICE_STUDIO_MONTHLY/YEARLY and STRIPE_PRICE_BUSINESS_MONTHLY/YEARLY. Legacy STRIPE_PRICE_PRO still maps to Pro monthly. Set actual prices in your Stripe account only after choosing commercial pricing; no dollar amounts or annual savings are invented in this app. Checkout validates USD, active recurring prices and the selected month/year interval.

Register `https://app.amadeu.tech/api/billing/webhook` with Stripe and complete test-mode event verification before accepting money. Checkout/portal are disabled until configured; there is no fake paid upgrade. A return URL does not prove payment. The server re-fetches the actual Stripe subscription after verifying the event signature and updates the corresponding tier. Amount, tax and renewal terms are shown at Stripe checkout. Provider credentials, a live charge and the real Stripe lifecycle have not been exercised unless explicitly recorded in TEST-REPORT.md.

AI_*_LIMIT and PROJECT_*_LIMIT configure each tier's monthly requests and project cap. A generation or chat result is one request only after successful save. These allowances are not token accounting or provider spending ceilings. Preserve operator/provider rate and spending limits; evaluate actual model costs before pricing. Downgrades do not delete existing projects; only new-project creation is capped.

## Operations and scope

SQLite runs in WAL mode and supports this one-process deployment; use PostgreSQL and shared rate/quota storage before running multiple replicas. Back up with SQLite's online backup API or stop the process before copying the entire data directory; do not copy only the main file while a writer is active. Store volumes and .env outside public web directories. Current signup has no email verification or self-service password reset, and import reads public static HTML rather than executing JavaScript. Complete those flows and load/abuse testing before public commercial launch.
