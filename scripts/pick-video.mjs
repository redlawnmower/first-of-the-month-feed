// Monthly video picker for First of the Month Alarm.
// Runs in GitHub Actions. No dependencies (Node 20+ built-in fetch).
//
// 1. Searches the web (Brave Search API) for TikTok videos of the trend.
// 2. Validates each candidate with TikTok's public oEmbed endpoint
//    (must exist, be public/embeddable, and caption must match the trend).
// 3. Writes primary + backups to videos.json.
// 4. If nothing passes, keeps the current file (only drops dead links).

import { readFile, writeFile } from "node:fs/promises";

const FEED_PATH = new URL("../videos.json", import.meta.url);
const API_KEY = process.env.BRAVE_API_KEY;

const QUERIES = [
  'site:tiktok.com "first of the month"',
  'site:tiktok.com "wake up it\'s the first of the month"',
  'site:tiktok.com "#firstofthemonth"',
  'site:tiktok.com "1st of the month"',
];

// Caption/title must contain at least one of these (case-insensitive).
const MUST_MATCH = [
  "first of the month",
  "1st of the month",
  "firstofthemonth",
  "1stofthemonth",
  "first of tha month",
  "1st of tha month",
];

// Skip anything whose caption or author contains these.
const BLOCKLIST = [
  "nsfw", "18+", "onlyfans", "of link", "sex", "nude", "porn",
  "kill", "dead", "rip ", "fight", "shooting", "drug",
  "scam", "giveaway", "crypto", "casino", "betting",
];

const BACKUP_COUNT = 3;
const HISTORY_KEEP = 24;
const AVOID_REPEAT_MONTHS = 6;

const VIDEO_URL_RE = /https?:\/\/(?:www\.)?tiktok\.com\/@([\w.-]+)\/video\/(\d+)/i;

function nextMonthKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function braveSearch(q) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "20");
  url.searchParams.set("safesearch", "strict");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": API_KEY },
  });
  if (!res.ok) {
    console.warn(`Search failed (${res.status}) for: ${q}`);
    return [];
  }
  const data = await res.json();
  const results = [...(data.web?.results ?? []), ...(data.videos?.results ?? [])];
  return results.map((r) => r.url).filter(Boolean);
}

async function oembed(videoUrl) {
  const url = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.type !== "video") return null;
    return data;
  } catch {
    return null;
  }
}

function passesFilters(meta) {
  const text = `${meta.title ?? ""} ${meta.author_name ?? ""} ${meta.author_unique_id ?? ""}`.toLowerCase();
  if (!MUST_MATCH.some((k) => text.includes(k))) return false;
  if (BLOCKLIST.some((k) => text.includes(k))) return false;
  return true;
}

function toEntry(id, author, meta) {
  return {
    id,
    url: `https://www.tiktok.com/@${author}/video/${id}`,
    embedUrl: `https://www.tiktok.com/player/v1/${id}`,
    author: meta.author_name ?? author,
    authorHandle: author,
    caption: (meta.title ?? "").slice(0, 300),
    thumbnailUrl: meta.thumbnail_url ?? null,
    checkedAt: new Date().toISOString(),
  };
}

async function stillAlive(entry) {
  return entry && (await oembed(entry.url)) !== null;
}

async function main() {
  const feed = JSON.parse(await readFile(FEED_PATH, "utf8"));
  const month = nextMonthKey();

  if (!API_KEY) {
    console.error("BRAVE_API_KEY is not set. Add it under repo Settings → Secrets and variables → Actions.");
    process.exit(1);
  }

  // Collect candidate URLs in search-rank order, de-duplicated by video id.
  const seen = new Map();
  for (const q of QUERIES) {
    for (const u of await braveSearch(q)) {
      const m = u.match(VIDEO_URL_RE);
      if (m && !seen.has(m[2])) seen.set(m[2], m[1]);
    }
  }
  console.log(`Found ${seen.size} candidate TikTok videos.`);

  const recentIds = new Set(
    (feed.history ?? []).slice(0, AVOID_REPEAT_MONTHS).map((h) => h.id)
  );

  const fresh = [];
  const repeats = [];
  for (const [id, author] of seen) {
    if (fresh.length >= BACKUP_COUNT + 1) break;
    const meta = await oembed(`https://www.tiktok.com/@${author}/video/${id}`);
    if (!meta || !passesFilters(meta)) continue;
    const entry = toEntry(id, author, meta);
    (recentIds.has(id) ? repeats : fresh).push(entry);
  }

  const picks = [...fresh, ...repeats].slice(0, BACKUP_COUNT + 1);

  if (picks.length === 0) {
    console.warn("No valid candidates. Keeping current feed; pruning dead links only.");
    const alive = [];
    for (const e of [feed.primary, ...(feed.backups ?? [])]) {
      if (await stillAlive(e)) alive.push(e);
    }
    feed.primary = alive[0] ?? null;
    feed.backups = alive.slice(1);
    feed.updatedAt = new Date().toISOString();
    await writeFile(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
    return;
  }

  const [primary, ...backups] = picks;
  feed.schemaVersion = 1;
  feed.month = month;
  feed.updatedAt = new Date().toISOString();
  feed.primary = primary;
  feed.backups = backups;
  feed.history = [
    { month, id: primary.id, url: primary.url },
    ...(feed.history ?? []).filter((h) => h.month !== month),
  ].slice(0, HISTORY_KEEP);

  await writeFile(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
  console.log(`Picked ${primary.url} for ${month} with ${backups.length} backups.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
