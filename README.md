# first-of-the-month-feed

Public video feed for the **First of the Month Alarm** app. The app reads `videos.json` from this repo to know which TikTok video to play when the alarm fires on the 1st.

Nothing sensitive lives here. App code is in a separate private repo.

## What's in here

| File | What it does |
|---|---|
| `videos.json` | This month's video (`primary`) plus up to 3 `backups`. The app reads this. |
| `scripts/pick-video.mjs` | Searches TikTok (via Apify), ranks today's trend videos by views, validates them, writes `videos.json`. |
| `.github/workflows/monthly-pick.yml` | Runs the script on the 1st of every month, every 2 hours from 09:00–19:00 UTC, and commits the result. |

App reads from:

```
https://raw.githubusercontent.com/redlawnmower/first-of-the-month-feed/main/videos.json
```

## How it picks

1. Runs Apify's TikTok Scraper (`clockworks/tiktok-scraper`) on TikTok search for "first of the month" and "#firstofthemonth", 25 results each.
2. Keeps videos posted in the last 30 hours whose caption mentions the trend and has no blocklisted words. Ads are skipped.
3. Ranks by view count and confirms each one loads in TikTok's public player (oEmbed).
4. Saves the top one as `primary` and the next 3 as `backups`.
5. Every later run that day re-ranks with fresh view counts, so the pick gets better through the morning. Earlier picks stay in the pool, so a flaky run can't make it worse.
6. If nothing from today qualifies yet, the current videos (last month's) stay, minus any dead links.

The pick then stays for the rest of the month.

## Setup

1. **Apify token:** saved as the repo secret `APIFY_TOKEN` (Settings → Secrets and variables → Actions). ✅ Done.
2. **Test it once:** Actions tab → "Monthly video pick" → Run workflow (leave "force" checked). Forced runs ignore the today-only filter so you can see a real pick before Dec 1.
3. If the commit step fails with a permission error: Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.

## Cost

Apify Free gives $5 of usage each month, no card required. This uses ~300 results/month (2 queries × 25 × 6 runs), roughly $1–2. Each run is capped at $0.50 (`MAX_CHARGE_PER_RUN_USD`). With no card on file, the worst case is the scraper stops for the month; nothing gets charged.

## Manual override

Edit `videos.json` on github.com and paste a new `id` / `url` / `embedUrl` into `primary`. Runs on the 1st will re-rank and may replace it.
