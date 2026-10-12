# smidge-uptime

Independent uptime monitor for the smidge.page sites and LeaseParser.

It runs on **GitHub Actions** every 5 minutes, outside Cloudflare, so it still alerts if Cloudflare itself is having problems. The tms dashboard runs on Cloudflare and can't do that.

- **What it checks:** everything in `targets.json`, plus every site listed in the hub's `https://smidge.page/sites.json`. New sites are picked up automatically.
- **How:** each site's `/health.json` must answer with `"ok"` (LeaseParser: the homepage must answer). A failure is retried once after 20 seconds before it counts.
- **Alerts:** one notification when a site goes down and one when it's back, sent to `ALERT_URL`.
- **Current status:** [STATUS.md](STATUS.md). History is in the commit log.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Required | What |
| --- | --- | --- |
| `ALERT_URL` | yes | `https://ntfy.sh/<topic>` or a Discord webhook URL. |
| `ALERT_TOKEN` | no | ntfy access token, if you use one. |

The repo is public so GitHub Actions minutes are free; the secrets stay private.

## Run it by hand

**Actions → Uptime → Run workflow**, or locally: `ALERT_URL=… node check.mjs`.
