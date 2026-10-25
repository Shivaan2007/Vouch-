# Deploying Vouch on Render (free plan)

Render's free-tier rules change. Confirm them on render.com/pricing.

## Settings (dashboard: New + > Web Service > connect `Shivaan2007/Vouch-`)
| Field | Value |
|---|---|
| Runtime | Node |
| Branch | `main` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Instance type | **Free** ($0, 0.1 CPU, 512 MB) |
| Health Check Path (Advanced) | `/health` |
| Disk | none (a disk needs a paid plan) |

## Environment variables
| Key | Value |
|---|---|
| `NODE_VERSION` | `20` |
| `DB_PATH` | `/tmp/vouch.db` |
| `DEMO_KEY` | long random string you keep private. Enables `/demo`. Never commit it. |
| `GEMINI_API_KEY` | optional. Without it everything runs rules-only. |
| `GEMINI_MODEL` | `gemini-2.5-flash` (confirm in AI Studio) |
Do not set `PORT`: Render provides it.

## The free-plan catch
The free instance sleeps after about 15 minutes with no traffic (the first request after that takes 50 s or more), and its files are
erased when it sleeps, restarts or redeploys. Vouch keeps users and pairings in that file, so **all pairings are lost** then
(the phones still hold their keys, but must pair again).

What to do about it:
1. **Keep it awake.** Create a free monitor (for example UptimeRobot, HTTP(s) monitor, 5-minute interval) on `https://<name>.onrender.com/health`.
2. **No deploys after the 10:00 AM freeze.** Pair the demo phones after the final deploy. Every merge to `main` redeploys (autoDeploy), so turn
   Auto-Deploy off in Settings at the freeze.
3. **Warm it before each rehearsal and before the expo:** open `/health`.
4. **Backup for the expo: run it on the laptop.** `npm start`, then `cloudflared tunnel --url http://localhost:3000`, and open the trycloudflare.com link
   on the phones. Data stays on the laptop and nothing sleeps. Pair the phones against that link.
5. The paid option is the Starter plan with a 1 GB disk at `/var/data` and `DB_PATH=/var/data/vouch.db` (see the comment in `render.yaml`).

## After a deploy
1. Open `https://<name>.onrender.com/health`. Expect `{"ok":true}`.
2. `npm run smoke -- https://<name>.onrender.com` (full request with three fake phones). It leaves fake users; wipe them with
   `DEMO_KEY=... npm run smoke -- <url> --cleanup` (this deletes ALL users) before the real phones pair.
3. `npm run stress -- https://<name>.onrender.com` runs 12 circles at once. Same cleanup rule.
4. Open `/demo`, enter `DEMO_KEY`, press Check status.
5. Pair the three demo phones once. Between judges use Reset, never Wipe.

## Custom domain (.tech from the MLH/GoDaddy offer)
Service > Settings > Custom Domains > Add. Render shows the DNS records. Subdomain: add the CNAME. Apex: add the A/ALIAS record.
Wait for the green check, then test HTTPS on a phone, before the expo.

## Expo day
- Warm the server. Do not use Wipe on `/demo`; use Reset.
- Revert a bad deploy: press Revert on the last PR on GitHub, or Render > Events > Rollback.
