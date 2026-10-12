// Uptime check for smidge.page sites, run by GitHub Actions every 5 minutes.
// Runs on GitHub's servers, outside Cloudflare, so it still works if Cloudflare is down.
//
// - Checks every target from targets.json plus every site in the hub's sites.json.
// - A failure is retried once after 20 seconds before it counts, to avoid false alarms.
// - Sends a notification to ALERT_URL (ntfy or Discord) only when a site changes state.
// - Remembers state in state.json, which the workflow commits back to the repo.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 20_000;
const config = JSON.parse(readFileSync("targets.json", "utf8"));
const state = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : { sites: {} };
const now = new Date();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "smidge-uptime (GitHub Actions)", "Cache-Control": "no-cache" },
    });
    const body = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return { up: false, ms, reason: `HTTP ${res.status}` };
    if (target.expect && !body.includes(target.expect)) return { up: false, ms, reason: `answered but without ${target.expect}` };
    return { up: true, ms };
  } catch (e) {
    const reason = e.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : e.cause?.code || e.message;
    return { up: false, ms: Date.now() - started, reason };
  }
}

async function check(target) {
  const first = await probe(target);
  if (first.up) return first;
  await sleep(RETRY_DELAY_MS);
  return probe(target);
}

// The always-checked list, plus every site in the hub directory (if the hub answers).
async function targets() {
  const list = [...config.always];
  try {
    const res = await fetch(config.directory, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const sites = await res.json();
    for (const s of sites) {
      if (!s?.url) continue;
      const url = new URL("health.json", s.url.endsWith("/") ? s.url : s.url + "/").href;
      if (!list.some((t) => t.url === url)) list.push({ name: s.name, url, expect: '"ok"' });
    }
  } catch {
    // Hub down or list unreadable: still check the known sites from the last good run.
    for (const [url, s] of Object.entries(state.sites)) {
      if (!list.some((t) => t.url === url)) list.push({ name: s.name, url, expect: s.expect });
    }
  }
  return list;
}

function duration(fromIso) {
  const min = Math.round((now - new Date(fromIso)) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// title must be plain text (it travels in an HTTP header); `down` picks the ntfy icon.
async function notify(title, text, down) {
  try {
    await send(title, text, down);
  } catch (e) {
    console.log(`::warning::Alert failed: ${e.message}`);
  }
}

async function send(title, text, down) {
  const target = String(process.env.ALERT_URL || "").trim().replace(/^["'<]+|["'>]+$/g, "").trim();
  if (!target) return console.log(`(no ALERT_URL) ${title}: ${text}`);
  const discord = /discord(app)?\.com\/api\/webhooks/.test(target);
  const token = String(process.env.ALERT_TOKEN || "").trim();
  const res = await fetch(target, discord
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `${down ? "🔴" : "🟢"} **${title}**\n${text}` }) }
    : { method: "POST", headers: { Title: title, Tags: down ? "red_circle" : "green_circle", Priority: down ? "high" : "default", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: text });
  console.log(`notify ${res.status}: ${title}`);
  if (!res.ok) console.log(`::warning::Alert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

const list = await targets();
const results = await Promise.all(list.map(async (t) => ({ t, r: await check(t) })));
let changed = false;

for (const { t, r } of results) {
  const prev = state.sites[t.url];
  const line = `${r.up ? "UP  " : "DOWN"} ${t.name.padEnd(36)} ${String(r.ms).padStart(5)} ms  ${r.reason || ""}`;
  console.log(line);

  if (!prev) {
    state.sites[t.url] = { name: t.name, expect: t.expect, up: r.up, since: now.toISOString() };
    changed = true;
    if (!r.up) await notify(`${t.name} is down`, `${t.url}\n${r.reason}`, true);
    continue;
  }
  if (prev.up !== r.up) {
    if (r.up) await notify(`${t.name} is back up`, `Down for ${duration(prev.since)}.\n${t.url}`, false);
    else await notify(`${t.name} is down`, `${t.url}\n${r.reason}`, true);
    Object.assign(prev, { name: t.name, expect: t.expect, up: r.up, since: now.toISOString() });
    changed = true;
  }
  prev.reason = r.up ? undefined : r.reason;
}

// One commit a day even when nothing changes keeps GitHub from pausing the schedule
// (it disables scheduled workflows after 60 days without repository activity).
const today = now.toISOString().slice(0, 10);
if (state.heartbeat !== today) {
  state.heartbeat = today;
  changed = true;
}

if (changed) {
  writeFileSync("state.json", JSON.stringify(state, null, 2) + "\n");
  const rows = Object.entries(state.sites)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([url, s]) => `| ${s.up ? "🟢 Up" : "🔴 Down"} | [${s.name}](${url.replace(/health\.json$/, "")}) | ${s.since.slice(0, 16).replace("T", " ")} UTC |`);
  writeFileSync("STATUS.md", `# Status\n\nChecked every 5 minutes from GitHub Actions (outside Cloudflare). Updated when something changes.\n\n| State | Site | Since |\n| --- | --- | --- |\n${rows.join("\n")}\n`);
}
console.log(changed ? "state changed" : "no change");
