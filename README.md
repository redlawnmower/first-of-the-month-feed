# first-of-the-month-feed

Public video feed for the **First of the Month Alarm** app. The app reads `videos.json` from this repo to know which TikTok video to play when the alarm fires on the 1st.

Nothing sensitive lives here. App code is in a separate private repo.

## What's in here

| File | What it does |
|---|---|
| `videos.json` | The current month's video (`primary`) plus `backups`. The app reads this. |
| `scripts/pick-video.mjs` | Finds the top trend video, validates it, writes `videos.json`. |
| `.github/workflows/monthly-pick.yml` | Runs the script automatically on the 26th of every month and commits the result. |

App reads from:

```
https://raw.githubusercontent.com/redlawnmower/first-of-the-month-feed/main/videos.json
```

## One-time setup (≈5 min, then never again)

1. **Get a Brave Search API key** at https://api-dashboard.search.brave.com. Pick the Search plan. It includes monthly free credits; this job uses ~4 searches a month, so it should cost $0. A card is required on file.
2. **Add the key to this repo:** Settings → Secrets and variables → Actions → New repository secret
   - Name: `BRAVE_API_KEY`
   - Value: your key
3. **Let the job save its own changes:** Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
4. **Run it once now** so the feed isn't empty: Actions tab → "Monthly video pick" → Run workflow.

After that it runs itself on the 26th of every month. No approvals needed.

## Safety rules the picker follows

- The video must load through TikTok's official oEmbed endpoint (public + embeddable).
- The caption must mention the trend ("first of the month", "#firstofthemonth", etc.).
- Captions/authors with blocklisted words are skipped (see `BLOCKLIST` in the script).
- Avoids repeating a video used in the last 6 months when fresh ones exist.
- If nothing passes, last month's video stays and dead links are removed. The app falls back to a TikTok search button if every link is dead.

## Manual override

Edit `videos.json` on github.com and paste a new `url`/`id`/`embedUrl` into `primary`. The next automatic run will overwrite it on the 26th.
