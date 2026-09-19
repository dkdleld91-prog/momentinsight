import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), ".config/momentinsight/backup.env"), "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
const since = process.argv[2]; const until = process.argv[3] || new Date().toISOString();
async function q(p) { const r = await fetch(`${url}/rest/v1/${p}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); }
const kst = (iso) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 16);
const ev = await q(`naver_shopping_scheduler_events?select=occurred_at,event_type,error_code,tracker_id,checked_count,worker_id,details&occurred_at=gte.${since}&occurred_at=lt.${until}&event_type=in.(tracker_committed,finite_window_committed,job_failed,quarantine_set)&order=occurred_at.asc&limit=10000`);
const by = (t) => ev.filter(e => e.event_type === t);
const commits = [...by("tracker_committed"), ...by("finite_window_committed")], fails = by("job_failed"), quar = by("quarantine_set");
const ids = [...new Set(ev.map(e => e.tracker_id).filter(Boolean))];
const trackers = ids.length ? await q(`naver_rank_trackers?select=id,keyword,product_url&id=in.(${ids.join(",")})`) : [];
const kw = Object.fromEntries(trackers.map(t => [t.id, t.keyword]));
console.log(`window ${kst(since)} ~ ${kst(until)} KST`);
console.log(`commits=${commits.length} (tracker=${by("tracker_committed").length}, finite=${by("finite_window_committed").length}) failures=${fails.length} quarantine=${quar.length} rate=${(fails.length / Math.max(1, commits.length + fails.length) * 100).toFixed(1)}%`);
console.log(`distinct trackers committed=${new Set(commits.map(e => e.tracker_id)).size}, failed=${new Set(fails.map(e => e.tracker_id)).size}`);
const workers = {}; for (const e of commits) workers[e.worker_id || "?"] = (workers[e.worker_id || "?"] || 0) + 1; console.log("commits by worker:", JSON.stringify(workers));
const hours = {}; for (const e of commits) { const h = kst(e.occurred_at).slice(0, 8); hours[h] = (hours[h] || 0) + 1; } console.log("commits by hour:", Object.entries(hours).map(([h, n]) => `${h.slice(6)}:${n}`).join(" "));
for (const e of [...fails, ...quar]) { const d = e.details || {}; console.log(`FAIL ${kst(e.occurred_at)} ${e.event_type} ${e.error_code || ""} ${(kw[e.tracker_id] || e.tracker_id || "").slice(0, 22)} ${JSON.stringify(d).slice(0, 140)}`); }
const finite = commits.filter(e => (kw[e.tracker_id] || "").includes("탄소매트")); console.log(`탄소매트 commits=${finite.length}`, finite.map(e => kst(e.occurred_at) + ":" + e.event_type).join(", "));
if (process.env.LIST) for (const e of commits) console.log(`OK ${kst(e.occurred_at)} ${e.event_type === "finite_window_committed" ? "finite" : "tracker"} ${(kw[e.tracker_id] || e.tracker_id || "").slice(0, 24)} checked=${e.checked_count ?? ""} ${JSON.stringify(e.details || {}).slice(0, 90)}`);
