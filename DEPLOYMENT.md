# DropDrop deployment guide (₹0 / month)

> **Status: prepared, not deployed.** Nothing has been deployed, published or purchased, and no Atlas setting has
> been changed. Steps that create something outside this computer are marked **[needs your approval]**.

```
Website (React/Vite) ─────────► Vercel Hobby   (static files + SPA fallback)
Browsers / VS Code ─ https://… ► Render Free    (ONE Node process: REST + wss://…/ws; sleeps when idle)
                                      │
                                      └──────► MongoDB Atlas free cluster (all room data lives here)
```

## 1. Billing safety rules (the whole plan depends on these)

* **Never add a payment method to Render.** Render's documentation says that without one, a workspace that uses up
  its free hours or bandwidth has its services *suspended until the next month* instead of being billed
  ([Render free tier](https://render.com/docs/free), [outbound bandwidth](https://render.com/docs/outbound-bandwidth)).
* **Never click Upgrade** on Render, Vercel or Atlas. Vercel's pay-as-you-go is a *Pro* feature
  ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)); the Atlas free cluster is "free forever" and does
  not auto-upgrade to a paid tier.
* **If any signup asks for card or payment details, stop.** Do not enter them.
* No paid Redis or any other paid service is used, and none is needed.

## 2. Are the services free for this use?

| Service | Terms that matter | At the limit |
|---|---|---|
| **Vercel Hobby** | **Non-commercial, personal use only** (below) | Sustained overuse can pause the project; Hobby has no pay-as-you-go |
| **Render Free web service** | 750 free hours/month per workspace; sleeps after 15 min without inbound traffic; 5 GB/month outbound; 512 MB RAM, 0.1 CPU; *"Do not use [Free instances] for production applications"*; may be restarted or suspended at any time | **Suspended** until next month (no card on file = no charge) |
| **Atlas free cluster** | 512 MB, 100 operations/s, 500 connections, 10 GB in + 10 GB out per rolling 7 days, no backups, pauses after 30 days with zero connections (can be resumed) | Throttled/limited, never charged |
| **VS Code Marketplace** | Free to publish | n/a |

**Vercel Hobby is only for non-commercial personal use.** Commercial use is any deployment used for the *financial
gain of anyone involved in any part of its production*: requesting or processing payment from visitors, selling a
product or service, ads (including AdSense), affiliate links as the main purpose, or being paid to create, update or
host the site. **Donations are allowed.** DropDrop as a free tool with no ads, payments or affiliate links, built as a
personal project, fits. If it is ever built or hosted as paid work, or ads/payments are added, it needs a paid plan.

## 3. How Render Free fits DropDrop (and what it cannot do)

| Question | Answer |
|---|---|
| WebSockets? | Yes, no fixed idle limit ([Render WebSockets](https://render.com/docs/websocket)) |
| Single instance? | Yes; the Free plan cannot scale out, so autoscaling is impossible |
| Persistent data on the host? | None needed. Nothing is written to disk; every room is in Atlas (Render's filesystem is wiped on restart) |
| Deploys? | Render runs the old and new instance together for about a minute. The backend is built for that overlap (tested with two instances) |
| Sleeping? | After 15 idle minutes; wake ≈ 1 minute. While a tab is open its presence messages are inbound traffic, so it should stay awake (to be confirmed on the real deployment) |

**Cold starts are handled (F1).** The website and the extension wait up to ~90 seconds for the server, showing
*"Waking the DropDrop server. This may take up to a minute."* with a Cancel button. They poll the read-only health
check and make the single (idempotent) create-room request only after the server answers, so retries and double
clicks can never create duplicate rooms. A wrong address (connection refused, unknown host, blocked port) fails
immediately instead of waiting.

**What cannot be reliable on the free tier**
* Instant availability after idle (first visitor waits about a minute).
* Guaranteed uptime. Render says not to use Free for production.
* Capacity under heavy or abusive use: see the egress section; exceeding 5 GB/month suspends the backend until the 1st.
* Fast sync under load: 0.1 CPU is slow. Fine for light use.
* Backups: Atlas free has none. Run `mongodump` yourself if the data matters.
* Any commercial use of the Vercel site.

## 4. Free-tier settings (backend environment)

| Variable | Default | Free-tier guidance |
|---|---|---|
| `ALLOWED_ORIGINS` (alias `CLIENT_URL`) | `http://localhost:5173` | Your Vercel origin(s), HTTPS, no path |
| `TRUST_PROXY` | `0` | Set to the real number of proxies; confirm with `/api/client-ip` |
| `COLLAB_FLUSH_INTERVAL_MS` | **`1000`** | Keep 1000 to start. 2000–3000 is supported and tested (below) |
| `STORAGE_GUARD` / `STORAGE_LIMIT_MB` / `STORAGE_GUARD_THRESHOLD` / `STORAGE_OTHER_DB_RESERVE_MB` | `on` / `512` / `0.8` / `0` | See the storage guard below |

### Persistence interval and the data-loss window
Each active room is written to Atlas at most once per interval (two operations per write: the update log and the text
mirror). Rough Atlas budget (100 operations/s): about 50 simultaneously *active* rooms at 1 s, about 150 at 3 s.

What can be lost? Edits are saved immediately when the last person leaves a room and on a clean shutdown (Render sends
SIGTERM). A **hard crash** loses edits only if *both* happen: the server dies between writes **and** every client that
holds the unsaved edit disappears before the server is back. A client that stays open re-sends its edits automatically
when the server returns (verified). The loss is at most the last interval of typing, and everything already written
stays intact. The "✓ Saved" indicator only turns on after the write is acknowledged.
All of this is covered by tests at 2 s and 3 s. **The production default stays 1 s**; change it (to 2000–3000) only if
Atlas operations become a problem, as an environment variable, with no code change.

### Storage guard (F3)
When the cluster nears its storage limit, DropDrop **refuses to create new rooms** (REST `503 STORAGE_FULL`, WebSocket
close `4409`) with a clear message; **existing rooms keep working and nothing is ever deleted**.
* It measures the **whole cluster** (`listDatabases` total, which includes other databases that share it), cached for
  60 s. Treat the figure as approximate: it is Atlas's reported on-disk size, not necessarily the exact metric Atlas
  enforces, which is why new rooms stop at **80%** (about 410 MB of 512 MB).
* If the database user is not allowed to list databases (a least-privilege user), only DropDrop's own database can be
  measured. Then set `STORAGE_OTHER_DB_RESERVE_MB` to what other databases on the cluster use; without that value the
  state is reported as `unknown` and new rooms are **allowed** (it never guesses).
* `GET /api/health` shows only a coarse `storage.guard` (`ok`, `refusing-new-rooms`, `unknown`) and its source.

### Monitoring Render's 5 GB/month outbound limit (F4 is deferred: no automatic cutoff)
Measured locally (server → clients, application data; add roughly 10–20% for TLS/TCP overhead):

| Activity | Outbound data |
|---|---|
| Joining a room | ≈ the size of its text: 0.2 KB empty, 10 KB, 98 KB (100k chars), **489 KB (500k-char maximum)** |
| Two idle tabs | ≈ 0.2 KB per minute |
| Typing 5 characters/second | ≈ 7 KB per minute per reader (28.7 KB/min with 4 readers) |

Normal human use is tiny (5 GB ≈ 10,000 joins of a maximum-size room). **The realistic risk is scripted abuse**: the
backend allows each IP up to 120 new connections per minute, so one script repeatedly joining a 500 KB public room
could in principle move several GB per hour. Monitoring:
* Watch the service's bandwidth in the Render dashboard (metrics, and workspace usage/billing; menu names can change,
  see <https://render.com/docs/outbound-bandwidth>). Check it weekly and after sharing the extension publicly.
* If usage looks abnormal: lower the room size cap (`MAX_CONTENT_LENGTH`) or tighten the per-IP connection rate in
  `backend/src/collab/wsServer.js`, redeploy, or suspend the service from the dashboard yourself.
* Not implemented on purpose: an automatic cutoff based on usage estimates, because an inaccurate estimate would
  disconnect legitimate users.

## 5. Atlas network security (decision: option A; nothing created or changed yet)

**Decided:** option A below (new project + own cluster + least-privilege user + Render's regional outbound ranges, never
`0.0.0.0/0`). **Verified on Render's docs:** the ranges are **not printed on any public page**; they are shown only in
the dashboard of an existing service (service → *Connect* → *Outbound*), as CIDR blocks that are **shared by all
services in the same region** (all Render customers there). So the allow-list narrows access to "Render's region", it
does not mean "only DropDrop"; the strong password and TLS remain the real protection. Never type IP addresses from a
blog or from memory. If the dashboard shows no *Outbound* tab/ranges for a Free service, stop (do not widen access).

Render Free has **no fixed outbound IP** (dedicated IPs are a paid add-on), and Atlas free clusters support **only the
IP access list**: no private endpoints, no network peering. The access list is **per project and applies to every
cluster in the project**. Your current cluster also holds `prescripto` and `sample_mflix`, and has a user named
after a person, so opening it to `0.0.0.0/0` would expose all of that. **Not approved, not done.** Options, best first:

| | What | Exposure |
|---|---|---|
| **A (recommended)** | A **new Atlas project with its own free cluster just for DropDrop** (Atlas allows many free clusters across projects: one per project, up to 250 projects per organisation). A new database user **`dropdrop_app`** with `readWrite` on the `dropdrop` database only, scoped to that cluster (not "read and write any database"), a long random password stored only in Render. Access list = the **outbound IP ranges Render publishes for your service's region** (dashboard → service → Connect → *Outbound*), **not** `0.0.0.0/0`. | Smallest. Prescripto is untouched. If Render changes its ranges, DropDrop loses the database until you update the list: a safe failure |
| **B (fallback)** | The same new project, user and password, but `0.0.0.0/0` | Anyone on the internet can *attempt* a login to the DropDrop cluster; protected only by TLS and the strong password. Blast radius is the DropDrop cluster only |
| **C (rejected)** | `0.0.0.0/0` on the current shared project | Exposes Prescripto and the sample data as well |

* Own cluster also means its own 512 MB, 100 ops/s, 10 GB/week transfer and 30-day pause, so the storage guard needs
  no reserve setting. (A new project needs `dropdrop` data migrated if you want your one existing room: a one-off copy,
  never a move.)
* Atlas can add **temporary** access-list entries that expire (up to 7 days): useful for one-off setup work from your own
  computer, not for the runtime.
* Always: TLS (the `mongodb+srv://` connection is TLS), a password of 32+ random characters (use Atlas's generator),
  kept only in Render's environment, never sent to anyone, rotated if you suspect exposure.
* No other free host with fixed outbound IPs and no card was found.

## 6. Order of work [each external step needs your approval]

1. **Git:** approve the commit and push of the prepared file list (browser sign-in via `gh auth login --web`; no password
   or token is ever typed into a prompt). The Git author name only appears in Git history; the product itself never shows any personal name.
2. **Atlas (option A):** create the new project, M0 cluster and user yourself in the Atlas UI (you keep the password).
   Do **not** add any network entry yet (the ranges are unknown until Render exists).
3. **Render:** sign in with GitHub, create the service from `render.yaml` on the **Free** plan, **do not add a payment
   method**, and set `MONGODB_URI` and `ALLOWED_ORIGINS` in its dashboard. The production guard refuses to start
   without a valid HTTPS origin, so use a temporary placeholder (`https://placeholder.example`) until step 5; the
   backend exits at startup when Atlas is unreachable, so this first deploy is **expected to fail** ("exited with
   status 1", database error in the log) until step 4. The service still exists, so its *Outbound* ranges are visible.
   After step 4 use **Manual Deploy → Deploy latest commit** (or restart) and it comes up.
4. **Atlas network access:** copy the CIDR blocks from Render (*Connect* → *Outbound*) into the project's Network Access
   list, one entry each, with a comment such as "Render outbound". Never `0.0.0.0/0`.
5. **Vercel:** import the repository, root `frontend`, set the three `VITE_*` variables (below), deploy.
6. Set `ALLOWED_ORIGINS` on Render to the real Vercel URL (replacing the placeholder); Render redeploys.
7. **Verify** (section 7), then **only then** set the extension defaults to the verified URLs and publish (section 8).

### Environment variables

| Where | Variable | Value |
|---|---|---|
| Render | `NODE_ENV` | `production` (in `render.yaml`) |
| Render | `NODE_VERSION` | `22` (in `render.yaml`) |
| Render | `TRUST_PROXY` | `1`, then confirm (section 7) |
| Render dashboard only | `MONGODB_URI` | Atlas connection string for the `dropdrop` database (secret) |
| Render dashboard | `ALLOWED_ORIGINS` | `https://<your-vercel-project>.vercel.app` |
| Render (optional) | `COLLAB_FLUSH_INTERVAL_MS`, `STORAGE_*` | section 4 |
| Vercel | `VITE_API_URL` | `https://<your-render-service>.onrender.com` |
| Vercel | `VITE_WS_URL` | `wss://<your-render-service>.onrender.com` |
| Vercel | `VITE_PUBLIC_APP_URL` | `https://<your-vercel-project>.vercel.app` |

The website and the extension must use **exactly the same** API and WebSocket address: the three `VITE_*` values and
the extension's `dropdrop.apiUrl` / `dropdrop.websocketUrl` are the same two hosts. Share links come from
`VITE_PUBLIC_APP_URL` (website) and `dropdrop.publicAppUrl` (extension), which must both be the real Vercel URL.
**Neither URL is known yet, and none is hard-coded anywhere.**

## 7. Production verification

```powershell
Invoke-RestMethod https://<backend>/api/health      # status ok, database connected, storage.guard ok
Invoke-RestMethod https://<backend>/api/client-ip   # "ip" must be YOUR public address; else adjust TRUST_PROXY
cd backend
node scripts/verify-deployment.mjs --api https://<backend> --origin https://<your-vercel-url>             # read-only
node scripts/verify-deployment.mjs --api https://<backend> --origin https://<your-vercel-url> --write-test # opens 1 room
```
Then: open `https://<vercel-url>/some-room` in two browsers (Connected, typing syncs, refresh keeps the text); let the
backend sleep 15+ minutes and open the site again (the waking message, then it opens by itself); join the same room
from the VS Code extension and watch it sync with the website.

## 8. VS Code extension (not published)

* **Branding:** the product name is DropDrop everywhere; no personal name or personal links. The manifest has no
  repository/homepage/bugs links. Publisher id **`dropdrop`** (display name "DropDrop"), subject to Marketplace
  availability; if taken, choose another DropDrop-branded id such as `dropdrop-app`, never a personal name.
* **Defaults are not production yet.** They stay `localhost` until the backend and website are deployed **and verified**;
  then they are changed to the verified URLs, the version is bumped, and a new `.vsix` is built.
* **Publishing with no token:** Microsoft is retiring global Azure DevOps tokens on **1 Dec 2026**, so upload the
  `.vsix` in the Marketplace publisher web page instead of `vsce publish` (it needs a Microsoft account; it is not
  confirmed whether creating the publisher also needs a free Azure DevOps organisation). Packaging:
  `cd vscode-extension; npm run package` (does not publish).
* A public extension lets anyone use your free backend, so see the egress section.

## 9. Operational notes
* Local development is unchanged: `npm run dev` in `backend` and `frontend`.
* Anyone who knows a room name can read and edit it; the website and extension both say so.
* One instance only. Horizontal scaling would need a shared pub/sub layer and is out of scope.
