# Deploying Vouch on Render

Render pricing and disk rules change. Confirm the plan and disk cost on render.com/pricing before you click Create.

## Settings (dashboard: New + > Web Service > connect `Shivaan2007/Vouch-`)
| Field | Value |
|---|---|
| Name | `vouch` |
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Instance type | **Starter** (free sleeps when idle and has no disk) |
| Health Check Path | `/health` |
| Auto-Deploy | On Commit |

Or skip the table: New + > Blueprint > pick the repo, and Render reads `render.yaml`.

## Environment variables
| Key | Value |
|---|---|
| `NODE_VERSION` | `20` (must be 20 or 22; `better-sqlite3` 12 supports both) |
| `DB_PATH` | `/var/data/vouch.db` |
| `DEMO_KEY` | a long random string you make up. Enables `/demo`. Never commit it. |
| `GEMINI_API_KEY` | Tejasv's key. Optional: without it everything runs rules-only. |
| `GEMINI_MODEL` | `gemini-2.5-flash` (confirm in AI Studio) |
Do not set `PORT`: Render provides it and the server reads it.

## Persistent disk (do this, or every deploy wipes all pairings)
Service > Disks > Add Disk: name `vouch-data`, mount path `/var/data`, size 1 GB. Then `DB_PATH` above points at it.
A service with a disk redeploys with a short gap, and the pairings survive. Without a disk, every deploy and restart erases users and pairs while the phones still hold their keys (gotcha 11).

## After the first deploy
1. Open `https://<name>.onrender.com/health`. Expect `{"ok":true}`. Post the URL in the team chat.
2. Open the URL on an iPhone and an Android. It must load over HTTPS (WebCrypto and the camera need it).
3. Open `/demo`, enter `DEMO_KEY`, press Check status. Expect 0 users until phones pair.
4. Pair the three demo phones once. From now on use Reset (not Wipe) between judges.

## Custom domain (.tech from the MLH/GoDaddy offer)
Service > Settings > Custom Domains > Add. Render shows the DNS records. At the registrar:
- subdomain (`app.yourname.tech`): add the CNAME Render shows.
- apex (`yourname.tech`): add the A/ALIAS record Render shows.
Wait for the green check (certificate), then test HTTPS on a phone. Do this before the expo, not at it.

## Expo day
- Final deploy at the 10:00 AM feature freeze, then re-pair only if you used a hard reset. No deploys after that.
- Warm the server before each rehearsal and before the expo: open `/health`.
- Do not use Wipe on `/demo` at the expo; use Reset.
- Revert a bad deploy: on GitHub press Revert on the last PR, or Render > Events > Rollback.
