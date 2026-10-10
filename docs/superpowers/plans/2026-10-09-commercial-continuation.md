# Commercial continuation implementation plan

> **For agentic workers:** Execute within the user's existing authorization. Development must not purchase services or invoke paid providers. Keep commercial subscription support; free development does not mean a free product.

**Goal:** Deliver a more usable commercial product foundation with multiple configurable subscription tiers, monthly/annual checkout, and native Claude integration tested without spending.

**Architecture:** Preserve the Node/SQLite app and existing accounts/projects. A shared public plan catalog defines limits and configured checkout choices. Stripe authoritative subscription data grants entitlements, never return URLs. The model adapter selects native Anthropic or existing compatible protocol.

**Tech Stack:** Node, SQLite, browser JavaScript, native HTTP tests; no new paid services or dependencies.

- [x] Billing worker: plan catalog and four tiers/intervals; validated Stripe prices, signed current-state webhooks, migration, caps and downgrade-preserved edits. Added failing tests first and verified them. Seven owned files integrated.
- [x] Frontend worker: public pricing and plan/usage modal, monthly/annual selection, unavailable purchase notice, server quotas, accessible controls and tests. No fictitious prices or proof points.
- [x] Main: native Anthropic Messages plus structured tool output, compatible protocol retained; new tests failed before implementation then passed. Also extended source semantic content with bounded persistence and model-flow tests.
- [x] Main: integrated code inspection; all 62 tests pass on Node24/26; all runtime syntax checks and dependency audit pass; browser pricing/interval/no purchase and old project checked; narrow-screen test measures 598px only, with no 390px claim. Updated reports and versioned package.
- [ ] Deployment: reuse current local preview. Do not buy infrastructure or modify DNS without access. Do not label a local or private demo as a public amadeu.tech deployment.
