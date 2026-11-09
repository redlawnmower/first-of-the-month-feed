// Video picker for First of the Month Alarm.
// Runs in GitHub Actions on the 1st of every month, several times that morning.
// No dependencies (Node 20+ built-in fetch).
//
// 1. Runs the Apify TikTok Scraper (clockworks/tiktok-scraper) to search TikTok
//    for the trend and get view counts.
// 2. Keeps only videos posted in the last ~30 hours whose caption matches the
//    trend and has no blocklisted words.
// 3. Ranks by views, confirms each one loads through TikTok's public oEmbed
//    endpoint, and writes the top pick + 3 backups to videos.json.
// 4. Later runs the same day re-rank with fresh view counts, so the pick gets
//    better as the morning goes on.
// 5. If nothing from today qualifies, the current videos stay (last month's
//    pick keeps playing). Dead links are removed.

import { readFile, writeFile } from "node:fs/promises";

const FEED_PATH = new URL("../videos.json", import.meta.url);
const TOKEN = process.env.APIFY_TOKEN;
const FORCE = process.env.FORCE_RUN === "true"; // manual runs on any day

const ACTOR = "clockworks~tiktok-scraper";
const API = "https://api.apify.com/v2";

// Keep this small: cost scales with results (≈ $3.70 per 1,000 on Apify Free).
// 2 queries × 25 results × 6 runs ≈ 300 results/month ≈ $1.10, under the $5 free credit.
const SEARCH_QUERIES = ["first of the month", "#firstofthemonth"];
const RESULTS_PER_QUERY = 25;
const MAX_CHARGE_PER_RUN_USD = 0.5; // hard cap per run so a bad run can't drain credit

// Only videos posted within this many hours count as "today's".
// 30h covers time zones that hit the 1st before UTC does.
const FRESH_HOURS = 30;

// Caption must contain at least one of these (case-insensitive).
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
  "nsfw", "18+", "onlyfans", "nude", "porn", "sexy",
  "kill", "shooting", "murder", "rip ", "fight",
  "drug", "weed", "scam", "giveaway", "crypto", "casino", "betting",
];

const BACKUP_COUNT = 3;
const HISTORY_KEEP = 24;

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apify(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Apify ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function scrapeTikTok() {
  const input = {
    searchQueries: SEARCH_QUERIES,
    searchSection: "/video",
    resultsPerPage: RESULTS_PER_QUERY,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadSubtitles: false,
  };

  const start = await apify(
    `/acts/${ACTOR}/runs?waitForFinish=60&maxTotalChargeUsd=${MAX_CHARGE_PER_RUN_USD}`,
    { method: "POST", body: JSON.stringify(input) }
  );
  let run = start.data;

  // Poll up to ~8 more minutes.
  for (let i = 0; i < 8 && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status); i++) {
    run = (await apify(`/actor-runs/${run.id}?waitForFinish=60`)).data;
  }
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify run ended with status ${run.status}`);
  }

  const res = await fetch(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Dataset fetch → ${res.status}`);
  return res.json();
}

function authorOf(item) {
  return item.authorMeta?.name ?? item["authorMeta.name"] ?? null;
}

function idOf(item) {
  if (item.id) return String(item.id);
  const m = String(item.webVideoUrl ?? "").match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function passesFilters(text) {
  const t = text.toLowerCase();
  return MUST_MATCH.some((k) => t.includes(k)) && !BLOCKLIST.some((k) => t.includes(k));
}

function isFresh(item, now) {
  const created = item.createTimeISO
    ? Date.parse(item.createTimeISO)
    : item.createTime
      ? item.createTime * 1000
      : NaN;
  return Number.isFinite(created) && now - created <= FRESH_HOURS * 3600 * 1000;
}

async function oembedOk(url) {
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.type === "video" ? data : null;
  } catch {
    return null;
  }
}

function toEntry(item) {
  const id = idOf(item);
  const author = authorOf(item);
  return {
    id,
    url: `https://www.tiktok.com/@${author}/video/${id}`,
    embedUrl: `https://www.tiktok.com/player/v1/${id}`,
    author: item.authorMeta?.nickName ?? author,
    authorHandle: author,
    caption: String(item.text ?? "").slice(0, 300),
    thumbnailUrl: item.videoMeta?.coverUrl ?? null,
    playCount: item.playCount ?? 0,
    postedAt: item.createTimeISO ?? null,
    checkedAt: new Date().toISOString(),
  };
}

async function pruneDead(entries) {
  const alive = [];
  for (const e of entries) if (e && (await oembedOk(e.url))) alive.push(e);
  return alive;
}

async function main() {
  if (!TOKEN) {
    console.error("APIFY_TOKEN is not set. Add it under repo Settings → Secrets and variables → Actions.");
    process.exit(1);
  }

  const now = new Date();
  if (now.getUTCDate() !== 1 && !FORCE) {
    console.log("Not the 1st (UTC) and not a forced run. Nothing to do.");
    return;
  }

  const feed = JSON.parse(await readFile(FEED_PATH, "utf8"));
  const month = monthKey(now);

  let items = [];
  try {
    items = await scrapeTikTok();
  } catch (err) {
    console.error(`Scrape failed: ${err.message}`);
  }
  console.log(`Scraper returned ${items.length} items.`);

  // Today's qualifying videos, best first (de-duplicated by id).
  const fresh = new Map();
  for (const item of items) {
    const id = idOf(item);
    const author = authorOf(item);
    if (!id || !author || item.isAd) continue;
    if (!FORCE && !isFresh(item, now.getTime())) continue;
    if (!passesFilters(`${item.text ?? ""} ${author}`)) continue;
    const prev = fresh.get(id);
    if (!prev || (item.playCount ?? 0) > (prev.playCount ?? 0)) fresh.set(id, item);
  }

  // Carry over earlier picks from THIS month (from earlier runs today) so a
  // flaky later run can't make the pick worse. Fresh view counts win.
  const pool = new Map();
  if (feed.month === month) {
    for (const e of [feed.primary, ...(feed.backups ?? [])]) if (e?.id) pool.set(e.id, e);
  }
  for (const item of fresh.values()) pool.set(idOf(item), toEntry(item));

  const ranked = [...pool.values()].sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));

  const picks = [];
  for (const e of ranked) {
    if (picks.length >= BACKUP_COUNT + 1) break;
    if (await oembedOk(e.url)) picks.push({ ...e, checkedAt: new Date().toISOString() });
  }

  if (picks.length === 0) {
    console.warn("No qualifying videos from today yet. Keeping current feed; pruning dead links.");
    const alive = await pruneDead([feed.primary, ...(feed.backups ?? [])]);
    feed.primary = alive[0] ?? null;
    feed.backups = alive.slice(1);
    feed.updatedAt = now.toISOString();
    await writeFile(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
    return;
  }

  // Fill empty backup slots with last month's videos if they still work.
  if (picks.length < BACKUP_COUNT + 1 && feed.month !== month) {
    const old = await pruneDead([feed.primary, ...(feed.backups ?? [])]);
    for (const e of old) {
      if (picks.length >= BACKUP_COUNT + 1) break;
      if (!picks.some((p) => p.id === e.id)) picks.push(e);
    }
  }

  const [primary, ...backups] = picks;
  feed.schemaVersion = 1;
  feed.month = month;
  feed.updatedAt = now.toISOString();
  feed.primary = primary;
  feed.backups = backups;
  feed.history = [
    { month, id: primary.id, url: primary.url, playCount: primary.playCount },
    ...(feed.history ?? []).filter((h) => h.month !== month),
  ].slice(0, HISTORY_KEEP);

  await writeFile(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
  console.log(`Pick for ${month}: ${primary.url} (${primary.playCount} views), ${backups.length} backups.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
