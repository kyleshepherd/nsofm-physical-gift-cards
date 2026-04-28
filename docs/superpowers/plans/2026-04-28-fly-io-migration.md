# Fly.io Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Physical Gift Cards Shopify app from a Google Compute Engine `e2-micro` VM to a Fly.io org owned by the store owner, with billing handed off to the owner. Decommission GCE once stable.

**Architecture:** Single `shared-cpu-1x` 512MB machine in `lhr` (London), always-on, with a 1GB Fly volume mounted at `/data` for the Shopify OAuth session SQLite database. Custom domain `giftcards.kyleshepherd.co.uk` retained.

**Tech Stack:** Fly.io (target), GCE (source, to be decommissioned), Docker, Node 20, React Router v7, Prisma + SQLite, Shopify CLI for app config.

**Notes for the executor:**
- This project has no automated test suite. Verification is by running real commands and inspecting output, not by writing unit tests.
- Reference spec: `docs/superpowers/specs/2026-04-28-fly-io-migration-design.md`. Read it first.
- Fly CLI must be installed: `brew install flyctl` (macOS) or see https://fly.io/docs/flyctl/install/.
- Some tasks require the **store owner** to act before the developer can proceed. Those are clearly marked.

---

## Task 1: Repo cleanup — fix doubled-`prisma/` path and tighten `.dockerignore`

**Files:**
- Modify: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/.env`
- Modify: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/.dockerignore`
- Delete: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/prisma/prisma/` (directory and its `dev.sqlite`)

This is independent of the Fly migration but small and worth doing first so the new prod path (`/data/dev.sqlite`) doesn't have to deal with the same Prisma path quirk.

- [ ] **Step 1: Confirm the current state**

Run:
```bash
ls -la /Users/kyleshepherd/personal/nsofm-physical-gift-cards/prisma/dev.sqlite \
       /Users/kyleshepherd/personal/nsofm-physical-gift-cards/prisma/prisma/dev.sqlite
cat /Users/kyleshepherd/personal/nsofm-physical-gift-cards/.env
```

Expected: both files exist; `.env` contains `DATABASE_URL="file:./prisma/dev.sqlite"`.

- [ ] **Step 2: Edit `.env`**

Replace the contents of `.env` with:
```
DATABASE_URL="file:./dev.sqlite"
```

(Prisma resolves the path relative to `prisma/schema.prisma`, so `file:./dev.sqlite` lands at `prisma/dev.sqlite`.)

- [ ] **Step 3: Add `.env` to `.dockerignore`**

Replace `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/.dockerignore` contents with:
```
.cache
build
node_modules
.env
.env.*
```

This prevents the dev `.env` from being baked into the production image.

- [ ] **Step 4: Delete the stray doubled directory**

Run:
```bash
rm -rf /Users/kyleshepherd/personal/nsofm-physical-gift-cards/prisma/prisma
```

- [ ] **Step 5: Verify Prisma still works locally**

Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
npx prisma migrate deploy
```

Expected: completes without error, applies migrations to `prisma/dev.sqlite`. No new `prisma/prisma/` directory should appear.

If the existing `prisma/dev.sqlite` is missing the latest migrations, this command brings it up to date. If sessions are lost, that's fine — local dev sessions are disposable; you'll re-OAuth once.

- [ ] **Step 6: Commit**

```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
git add .env .dockerignore prisma
git status   # confirm prisma/prisma/ shows as deleted, no other surprises
git commit -m "Fix doubled prisma/ path and ignore .env in Docker builds"
```

---

## Task 2: Write `fly.toml`

**Files:**
- Create: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/fly.toml`

The `fly.toml` pins all the cost/availability settings called out in the spec's "Cost guardrails" section.

- [ ] **Step 1: Decide the app name**

Pick a globally-unique-ish app name. Recommended: `nsofm-physical-gift-cards` (matches the directory name). If `fly apps list` later shows it's taken, fall back to `nsofm-gift-cards-<owner-slug>`.

- [ ] **Step 2: Create `fly.toml`**

Write the following to `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/fly.toml` (replacing `nsofm-physical-gift-cards` with the chosen app name if different):

```toml
app = "nsofm-physical-gift-cards"
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[env]
  DATABASE_URL = "file:/data/dev.sqlite"
  PORT = "3000"

[[mounts]]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Key settings (do not change without re-reading the spec's cost guardrails section):
- `auto_stop_machines = "off"` and `auto_start_machines = false` — webhooks require always-on.
- `min_machines_running = 1` — exactly one machine.
- `[[vm]] size = "shared-cpu-1x"`, `memory = "512mb"` — pinned size.
- `[[mounts]] destination = "/data"` — matches the `DATABASE_URL`.

- [ ] **Step 3: Commit**

```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
git add fly.toml
git commit -m "Add fly.toml for Fly.io deployment"
```

---

## Task 3: Owner-side Fly account setup (HANDOFF — owner action required)

**No file changes.** This task is gated on the store owner. The dev cannot proceed until they finish.

- [ ] **Step 1: Send the owner this checklist**

Paste the following to the owner via whatever channel you use:

> Hi! To take over hosting for the gift card app, please do the following on Fly.io. Should take about 5 minutes.
>
> 1. Go to https://fly.io/app/sign-up and create an account using your business email.
> 2. Verify the email link they send you.
> 3. Once logged in, go to https://fly.io/dashboard/billing and add a credit card.
> 4. Go to https://fly.io/dashboard and create a new **Organization**. Name it something like `<shop-name>` (e.g. `nsofm`). Tell me what you named it.
> 5. In that org, go to **Members** → **Invite member** and invite my email (`<dev-email>`) with the role **admin**.
> 6. Reply to me with: (a) the org slug from the URL (e.g. `https://fly.io/dashboard/<this-bit>`) and (b) confirmation that you've sent the invite.

- [ ] **Step 2: Wait for the invite email and the owner's reply**

Expected: an email from Fly inviting you to the org, and a message from the owner with the org slug.

- [ ] **Step 3: Accept the invite**

Click the link in the email. Sign in with your existing Fly account (or create one if you don't have one).

- [ ] **Step 4: Verify access from the CLI**

Run:
```bash
fly auth login        # if not already logged in
fly orgs list
```

Expected: the owner's org appears in the list.

Record the exact org slug shown by `fly orgs list` — you'll use it as `<owner-org>` in later commands.

---

## Task 4: Provision the Fly app and volume

**No file changes.** All Fly CLI commands are run against the owner's org.

- [ ] **Step 1: Register the app in the owner's org**

Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
fly apps create nsofm-physical-gift-cards --org <owner-org>
```

Replace `<owner-org>` with the slug from Task 3. Replace the app name if you chose a different one in Task 2.

Expected: `New app created: nsofm-physical-gift-cards`.

If the name is taken, choose a different one, update `fly.toml`'s `app =` line, commit that change, and re-run.

- [ ] **Step 2: Create the volume**

Run:
```bash
fly volumes create data --region lhr --size 1 --app nsofm-physical-gift-cards
```

Expected: prints volume details with `Region: lhr`, `Size: 1 GB`. It will warn that single-volume apps have no automatic redundancy — that's fine, accept by pressing `y` if prompted.

- [ ] **Step 3: Verify the volume**

Run:
```bash
fly volumes list --app nsofm-physical-gift-cards
```

Expected: one volume named `data` in region `lhr`, size `1GB`, attached to no machine yet.

---

## Task 5: Set runtime secrets

The app needs four secrets at runtime: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, and `SHOPIFY_APP_URL`. (`DATABASE_URL` and `PORT` are in `fly.toml` `[env]`, not secrets.)

**No file changes.**

- [ ] **Step 1: Get the current secret values from the running GCE container**

SSH into the GCE VM (Console → Compute Engine → VM instances → SSH) and run:
```bash
docker inspect $(docker ps -q --filter name=gift-cards) --format '{{range .Config.Env}}{{println .}}{{end}}'
```

Expected output includes lines like:
```
SHOPIFY_API_KEY=f516f722dfff321bd3abbf8b988a1924
SHOPIFY_API_SECRET=<some-hex-string>
SCOPES=read_products,write_gift_cards,read_orders,write_orders,read_customers,write_customers
SHOPIFY_APP_URL=https://giftcards.kyleshepherd.co.uk
```

Copy these values somewhere safe temporarily (a password manager, not a chat history).

If `SHOPIFY_API_SECRET` is missing or unrecognised, retrieve it from the Shopify Partners dashboard: https://partners.shopify.com → Apps → Physical Gift Cards → Configuration → Client credentials.

- [ ] **Step 2: Set the secrets on Fly**

Run (replacing `<...>` placeholders with values from Step 1):
```bash
fly secrets set \
  SHOPIFY_API_KEY=f516f722dfff321bd3abbf8b988a1924 \
  SHOPIFY_API_SECRET=<from-step-1> \
  SCOPES="read_products,write_gift_cards,read_orders,write_orders,read_customers,write_customers" \
  SHOPIFY_APP_URL=https://giftcards.kyleshepherd.co.uk \
  --app nsofm-physical-gift-cards
```

Expected: `Secrets are staged for the first deployment.`

- [ ] **Step 3: Verify secrets are set**

Run:
```bash
fly secrets list --app nsofm-physical-gift-cards
```

Expected: four rows — `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` — each with a digest and a "created at" timestamp. Values are not shown (correct).

---

## Task 6: First deploy

**No file changes.**

- [ ] **Step 1: Deploy**

Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
fly deploy --app nsofm-physical-gift-cards
```

Expected: builds the Docker image (will take a few minutes the first time), pushes it, creates a machine in `lhr`, attaches the `data` volume, runs the container.

If the deploy fails to mount the volume, check that `fly volumes list` shows it in `lhr` and that `fly.toml`'s `[[mounts]] source = "data"` matches the volume name exactly.

- [ ] **Step 2: Tail logs and confirm boot**

Run:
```bash
fly logs --app nsofm-physical-gift-cards
```

Expected, within ~30 seconds of deploy completion:
- Lines from `prisma migrate deploy` showing migrations applied to `/data/dev.sqlite`
- A line from the React Router server like `[react-router-serve] http://localhost:3000`

Press `Ctrl+C` to stop tailing once you see the server is up.

- [ ] **Step 3: Confirm the volume is being used**

Run:
```bash
fly ssh console --app nsofm-physical-gift-cards --command 'ls -la /data'
```

Expected: `dev.sqlite` (and `dev.sqlite-journal` and/or `dev.sqlite-wal`) appearing in `/data`.

- [ ] **Step 4: Confirm the public URL responds**

Run:
```bash
curl -sI https://nsofm-physical-gift-cards.fly.dev/ | head -5
```

Expected: `HTTP/2 302` (or `301`) with a `location:` header pointing at Shopify's auth flow. A 200 response on the root would be wrong — it means the Shopify auth wrapper isn't engaging.

---

## Task 7: Cutover Shopify config to the temporary `fly.dev` URL

This is the temporary staging step. We point the Shopify app at the `fly.dev` URL first, verify everything works end-to-end on a dev store, then in Task 9 swap to the production custom domain.

**Files:**
- Modify: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/shopify.app.toml`

- [ ] **Step 1: Update `shopify.app.toml`**

Edit `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/shopify.app.toml`. Change two values:

Before:
```toml
application_url = "https://giftcards.kyleshepherd.co.uk"
```
After:
```toml
application_url = "https://nsofm-physical-gift-cards.fly.dev"
```

And in `[auth]`:
```toml
redirect_urls = [ "https://giftcards.kyleshepherd.co.uk/auth/callback" ]
```
becomes:
```toml
redirect_urls = [ "https://nsofm-physical-gift-cards.fly.dev/auth/callback" ]
```

Do **not** commit this change yet — it's temporary.

- [ ] **Step 2: Update the secret to match**

Run:
```bash
fly secrets set SHOPIFY_APP_URL=https://nsofm-physical-gift-cards.fly.dev --app nsofm-physical-gift-cards
```

Expected: `Secrets are staged for deployment.` Fly will redeploy the machine with the new value automatically.

- [ ] **Step 3: Push config to Shopify**

Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
shopify app deploy
```

Expected: prompts you to confirm the URL change, then pushes new config to Partners. Confirm yes.

- [ ] **Step 4: Re-install the app on a dev store**

Open https://partners.shopify.com → Apps → Physical Gift Cards → Test your app → pick a development store → install.

Expected: OAuth flow completes, you land on the embedded app inside Shopify admin.

- [ ] **Step 5: Confirm a session row was written to the volume**

Run:
```bash
fly ssh console --app nsofm-physical-gift-cards --command 'sqlite3 /data/dev.sqlite "SELECT shop, isOnline FROM Session;"'
```

Expected: at least one row with the dev store's `*.myshopify.com` domain.

---

## Task 8: Verify webhook delivery on the dev store

**No file changes.**

- [ ] **Step 1: Place a test order in the dev store**

In the dev store admin: create a draft order containing a product set up as a physical gift card → mark as paid → confirm.

- [ ] **Step 2: Confirm the handler ran**

In a separate terminal during/after Step 1:
```bash
fly logs --app nsofm-physical-gift-cards | tail -100
```

Expected: log lines from the `webhooks.orders.paid.tsx` handler showing the live `orders/paid` webhook arrived and the gift card metafield was created.

- [ ] **Step 3: Confirm the metafield landed**

In the dev store admin: Orders → click the test order → scroll to the Metafields section.

Expected: the gift-card metafield is present with the expected value.

If any of these steps fail, do **not** proceed to the production cutover. Roll back by reverting `shopify.app.toml` and re-running `shopify app deploy`. The GCE app is still serving production at `giftcards.kyleshepherd.co.uk`, so production is unaffected.

---

## Task 9: Custom domain cutover

**Files:**
- Modify: `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/shopify.app.toml` (revert)

- [ ] **Step 1: Add the custom hostname to Fly**

Run:
```bash
fly certs create giftcards.kyleshepherd.co.uk --app nsofm-physical-gift-cards
```

Expected: prints the DNS records you need to add — typically:
- A record: `giftcards.kyleshepherd.co.uk` → `<Fly IPv4>` (the shared IPv4)
- AAAA record: `giftcards.kyleshepherd.co.uk` → `<Fly IPv6>`
- Plus an `_acme-challenge.giftcards.kyleshepherd.co.uk` CNAME for cert validation.

Copy those values.

- [ ] **Step 2: Update DNS at the registrar for `kyleshepherd.co.uk`**

Log into the DNS provider for `kyleshepherd.co.uk`. Find the existing record for `giftcards` (currently pointing at GCE). **Do not delete it yet** — instead:

1. Add the new A and AAAA records pointing at Fly (alongside the existing GCE A record). DNS will round-robin briefly.
2. Add the `_acme-challenge` CNAME.
3. Wait ~5 minutes, then **remove** the old GCE A record so traffic goes only to Fly.

Cert provisioning needs the `_acme-challenge` to resolve correctly.

- [ ] **Step 3: Wait for the cert**

Run:
```bash
fly certs show giftcards.kyleshepherd.co.uk --app nsofm-physical-gift-cards
```

Expected within 5–10 minutes: `Status: Ready`. If it stays `Awaiting configuration` for more than 15 minutes, double-check the DNS records.

- [ ] **Step 4: Verify HTTPS works**

Run:
```bash
curl -sI https://giftcards.kyleshepherd.co.uk/ | head -5
```

Expected: same `HTTP/2 302` Shopify redirect as `Task 6 Step 4`, with a valid cert (no `--insecure` needed).

- [ ] **Step 5: Revert `shopify.app.toml` to the production URL**

Edit `/Users/kyleshepherd/personal/nsofm-physical-gift-cards/shopify.app.toml`:

```toml
application_url = "https://giftcards.kyleshepherd.co.uk"
```

And:

```toml
redirect_urls = [ "https://giftcards.kyleshepherd.co.uk/auth/callback" ]
```

These should match the original values exactly (compare with `git diff shopify.app.toml` — should now show no change versus `main`).

- [ ] **Step 6: Update the Fly secret**

Run:
```bash
fly secrets set SHOPIFY_APP_URL=https://giftcards.kyleshepherd.co.uk --app nsofm-physical-gift-cards
```

- [ ] **Step 7: Push Shopify config**

Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
shopify app deploy
```

Expected: confirms reverting `application_url` back to the production URL.

- [ ] **Step 8: Verify in Shopify admin**

Open the merchant's live shop admin → Apps → Physical Gift Cards. The embedded app should load over the production URL, served by Fly.

---

## Task 10: Verify session persistence across redeploys

**No file changes.**

This is the spec's "Persistence check" verification step.

- [ ] **Step 1: Note the current session row**

Run:
```bash
fly ssh console --app nsofm-physical-gift-cards --command 'sqlite3 /data/dev.sqlite "SELECT id, shop FROM Session;"'
```

Expected: at least one row. Copy the `id` and `shop` values.

- [ ] **Step 2: Trigger a no-op redeploy**

Run:
```bash
fly deploy --app nsofm-physical-gift-cards --strategy immediate
```

Expected: completes successfully.

- [ ] **Step 3: Confirm the same row still exists**

Run:
```bash
fly ssh console --app nsofm-physical-gift-cards --command 'sqlite3 /data/dev.sqlite "SELECT id, shop FROM Session;"'
```

Expected: same `id` and `shop` as Step 1. If the row is gone, the volume is not properly mounted — investigate with `fly volumes list` and `fly machine status` before proceeding.

---

## Task 11: 48-hour monitoring window

**No file changes.** This is wall-clock time, not engineering time.

- [ ] **Step 1: Check logs daily for 48 hours**

Run periodically:
```bash
fly logs --app nsofm-physical-gift-cards | grep -iE 'error|fatal|exception' | tail -20
```

Expected: no recurring errors. The occasional Shopify webhook signature mismatch from probes is fine; repeated 500s on real handlers are not.

- [ ] **Step 2: Confirm a real customer checkout fires the webhook (if one happens organically)**

If a customer buys a physical gift card during the window: confirm the metafield was created, same as Task 8 Step 3 but on the live shop.

- [ ] **Step 3: Spot-check latency vs the GCE baseline**

The previous setup was in `us-east1` serving a UK shop, adding ~80–100ms transatlantic latency. Confirm the move to `lhr` actually helped:
```bash
curl -o /dev/null -s -w 'connect: %{time_connect}s\nttfb: %{time_starttransfer}s\ntotal: %{time_total}s\n' \
  https://giftcards.kyleshepherd.co.uk/
```

Expected: `ttfb` well under 200ms from a UK network connection. If it's worse than what you'd see hitting the GCE URL directly, something is misconfigured (e.g. wrong Fly region).

- [ ] **Step 4: Check projected billing at the 1-week mark (or sooner)**

Open https://fly.io/dashboard/<owner-org>/billing → expected projected monthly: **under £3**. If it's higher, review `fly.toml` and `fly machine list` against the spec's cost guardrails before proceeding.

- [ ] **Step 5: Hold the line**

Do not start Task 12 until 48 hours have elapsed with no production issues.

---

## Task 12: Decommission GCE

**No file changes.** All actions in the GCP console.

- [ ] **Step 1: Final session check on Fly**

Confirm one last time the Fly app is healthy:
```bash
curl -sI https://giftcards.kyleshepherd.co.uk/ | head -3
fly status --app nsofm-physical-gift-cards
```

Expected: 302 redirect; status shows 1 machine `started` in `lhr`.

- [ ] **Step 2: Stop the GCE container (revocable safety check)**

SSH into the GCE VM and run:
```bash
docker stop $(docker ps -q --filter name=gift-cards)
```

Wait 1 hour. If anything breaks (it shouldn't — DNS already points at Fly), starting the container again is `docker start <id>`.

- [ ] **Step 3: Delete the GCE VM**

Console → Compute Engine → VM instances → tick the instance → **Delete**. Confirm.

This deletes the boot disk too by default. If a separate persistent disk is shown attached, delete that too: Console → Compute Engine → Disks.

- [ ] **Step 4: Release any reserved static IPs**

Console → VPC network → IP addresses. If any are listed as **Reserved** for this project (likely none for an `e2-micro`-only setup), release them — reserved-but-unused IPs are billed.

- [ ] **Step 5: Check for orphaned resources**

Console → Billing → Reports → filter by Project. Set time range to "Today". Expected: no Compute Engine usage from now on. Re-check tomorrow to confirm.

If you see lingering charges, investigate: typical culprits are Container Registry images, Cloud Storage buckets, or unused snapshots.

- [ ] **Step 6: Final commit**

The repo should now be in its clean post-migration state. Run:
```bash
cd /Users/kyleshepherd/personal/nsofm-physical-gift-cards
git status
git log --oneline -10
```

Expected: a clean tree, with commits from Tasks 1 and 2 (and any incidental fixes) on `main`. The `shopify.app.toml` should be unchanged from before the migration.

---

## Done criteria

- [ ] All session traffic for `giftcards.kyleshepherd.co.uk` served by Fly.io in `lhr`
- [ ] `orders/paid` webhook delivery confirmed on the live shop
- [ ] No GCE resources billing in the project
- [ ] Fly billing dashboard shows the owner's payment method and a projected monthly under £3
- [ ] Repo on `main` contains `fly.toml` and the `.env`/`.dockerignore` cleanup commits, with no other deltas vs pre-migration
