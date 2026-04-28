# Migration: GCE → Fly.io (with billing handoff)

**Date:** 2026-04-28
**Status:** Approved design, ready for implementation plan

## Context and motivation

The app currently runs on a Google Compute Engine `e2-micro` VM in `us-east1-b`, costing roughly £4–5/month. The primary driver for this migration is **billing handoff**: the store owner needs to pay the hosting bill directly, not the developer. The store owner is non-technical and previously struggled to set up a GCP project and IAM. The secondary driver is **cost** — Fly.io, sized correctly, will be cheaper than GCE.

The app was previously hosted on Fly.io and was migrated to GCE in December 2025 because Fly was perceived as more expensive than expected (likely due to oversized machines or unused add-ons rather than Fly's pricing model itself). This spec explicitly pins resource sizing to prevent a repeat.

## Workload characteristics (measured)

- Small Shopify embedded app, single merchant
- React Router v7 + Node 20 in a Docker container, listening on port 3000
- CPU utilisation: 2–3% average, ~5% peak (over 7 days on `e2-micro`)
- Memory: not measured (Ops Agent not installed); 1GB total available, app comfortably fits
- Disk: 30GB boot disk on GCE; actual SQLite session DB is well under 1MB
- Network egress: ~25–30GB/month (covered by GCP free tier today)
- Must be always-on to receive Shopify checkout webhooks
- Gift-card data lives in Shopify metafields, not in the app's database
- The only data in the app's database is Shopify OAuth sessions (one model: `Session`)

## Current GCE state (for reference)

The current setup persists nothing meaningfully:

- Container has been running uninterrupted for 4 months at the time of writing
- A bind mount exists (`/home/kyleshepherd/data` → `/data`) but is unused — the app does not write to `/data`
- The SQLite file lives inside the container's writable layer at `/app/prisma/prisma/dev.sqlite`
- Sessions have persisted only because the container has not been recreated

This means today's setup would lose sessions on any container recreation. The new Fly setup will improve on this with a real persistent volume.

## Target architecture

| Concern | Decision |
|---|---|
| Platform | Fly.io |
| Org owner | Store owner (Model A) — owner creates the org, adds payment, invites the developer as `admin` |
| Region | `lhr` (London), single region |
| Machine | 1 × `shared-cpu-1x` with 512MB RAM |
| Auto-stop / auto-start | **Disabled** (must be always-on for checkout webhooks) |
| Auto-scaling | Disabled (exactly 1 machine) |
| Volume | 1GB Fly volume, mounted at `/data`, holds `dev.sqlite` |
| Production `DATABASE_URL` | `file:/data/dev.sqlite`, set via `fly.toml` `[env]` |
| IPv4 | Shared (free) — no dedicated IPv4 |
| IPv6 | Dedicated (free) |
| Domain | `giftcards.kyleshepherd.co.uk` retained as the public hostname; custom hostname + Let's Encrypt cert configured in Fly |
| Secrets | Set via `fly secrets set` (Shopify API key, secret, scopes, session encryption key, anything else currently in the GCE env) |
| Managed Postgres | None — SQLite on the Fly volume is sufficient |
| Multi-region | None |
| Fly subscription tier | None — pay-as-you-go |

### Why `/data`, not `/app/prisma`

Mounting a Fly volume at `/app/prisma` would overlay the directory and hide `schema.prisma` and `migrations/` (both baked into the Docker image and required by `prisma migrate deploy` at startup). Mounting at `/data` keeps the schema and migrations visible inside the image and isolates the volume to just the live SQLite file. This is also the Fly.io convention.

### In-scope code changes

1. **Production `DATABASE_URL`:** set to `file:/data/dev.sqlite` via `fly.toml` `[env]`. Local `.env` keeps its current value — only the production environment is affected.
2. **Cleanup of the doubled-`prisma/` quirk in local dev:** the local `.env` currently sets `DATABASE_URL="file:./prisma/dev.sqlite"`, which Prisma resolves relative to the schema file's location (`prisma/schema.prisma`), producing `prisma/prisma/dev.sqlite`. This will be fixed to `file:./dev.sqlite` and the stray `prisma/prisma/` directory deleted. **This cleanup is independent of the Fly migration** but is small and worth doing while we're in the area.

## Migration sequence

Steps are labelled **(Owner)**, **(Dev)**, or **(Joint)**.

1. **(Owner)** Sign up at fly.io, verify email, add a payment method.
2. **(Owner)** Create an organisation named after the shop.
3. **(Owner)** Invite the developer as `admin` of the org via email.
4. **(Dev)** Accept the invite. Verify org access locally with `fly orgs list`.
5. **(Dev)** On a feature branch: create `fly.toml` (region `lhr`, single machine, auto-stop disabled, internal port 3000, volume mount at `/data`, `DATABASE_URL=file:/data/dev.sqlite` in `[env]`); separately, fix the doubled-`prisma/` path in the local `.env` and repo. Push for review.
6. **(Dev)** `fly launch --no-deploy --org <owner-org>` to register the app and create the volume.
7. **(Dev)** Set secrets via `fly secrets set` for every value currently in the GCE container's environment.
8. **(Dev)** `fly deploy`. Verify the app boots (`fly logs` shows the server bound to port 3000) and the root URL returns a Shopify auth redirect when hit.
9. **(Dev)** Update `shopify.app.toml` `application_url` and webhook URLs to the temporary Fly-assigned URL (`<app>.fly.dev`). Run `shopify app deploy` to push to Shopify.
10. **(Dev)** End-to-end verification on the Fly URL: install/OAuth flow, real test checkout webhook delivery, gift-card metafield is created on the resulting order.
11. **(Dev)** Update DNS for `giftcards.kyleshepherd.co.uk` to point at the Fly app. Add the custom hostname + Let's Encrypt cert in Fly.
12. **(Dev)** Switch `application_url` back to `giftcards.kyleshepherd.co.uk` and re-run `shopify app deploy`.
13. **(Joint)** Monitor for 48 hours.
14. **(Dev)** Decommission GCE: delete the VM, the boot disk, any reserved static IPs, and any other related GCP resources in this project.

## Cost guardrails

To prevent the same drift that made the previous Fly setup expensive:

- Machine size pinned to `shared-cpu-1x` / 512MB. Resizing requires explicit re-approval.
- Exactly 1 machine. No autoscaling. No `min_machines_running > 1`.
- Auto-stop disabled (also a functional requirement — webhooks).
- No dedicated IPv4 ($2/mo).
- No managed Postgres ($1.94/mo per machine + storage).
- No multi-region.
- Volume size capped at 1GB, no auto-growth.
- No Fly paid-tier subscription.

**Expected steady-state monthly cost:** ~$2–3 (£1.60–2.40).

If a future bill exceeds £5/month without a deliberate, recorded change, that is a signal to investigate.

## Verification plan

Before considering the migration complete:

1. **Boot:** `fly logs` shows the React Router server starts cleanly and binds port 3000.
2. **OAuth:** install the app on a dev store; confirm a row appears in the `Session` table via `fly ssh console` + `sqlite3 /data/dev.sqlite`.
3. **Persistence:** trigger a no-op `fly deploy`; confirm the existing `Session` row survives the redeploy.
4. **Webhook:** trigger a real checkout on the live shop; confirm the gift-card metafield is created on the order and the webhook handler logs in `fly logs`.
5. **Latency:** measure Shopify admin app load before vs after — should be faster from `lhr` than `us-east1`.
6. **Cost (1 week in):** Fly billing dashboard projected monthly is within £2–3.

## Rollback and safety

- The GCE instance is **not deleted** until at least 48 hours of stable Fly operation have passed.
- During that window, rollback = revert DNS to point at GCE + revert `application_url` in Shopify config + re-run `shopify app deploy`. GCE is still running underneath, so the cutover back is fast.
- After GCE is deleted, rollback means re-provisioning from scratch, which is no easier than a forward fix. The 48-hour window is the real safety net.

## Open questions / out of scope

- **Domain ownership.** `giftcards.kyleshepherd.co.uk` is the developer's personal domain. If the store owner wants to move to their own domain in future, that's a separate task involving the Shopify app `application_url`, redirect URLs, and a fresh DNS setup. Not part of this migration.
- **Future Shopify CLI deploys.** Once the developer's local tooling is configured against the new Fly app, future `shopify app deploy` runs work the same as before. No CI/CD changes are in scope.
