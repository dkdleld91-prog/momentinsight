#!/usr/bin/env node
// 수집 장애 3분 진단: node diagnose.mjs [hours=6]  — 서버 기록(읽기 전용) + 이 맥의 로그·전원을 한 번에 출력
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execSync } from "node:child_process";
const hours = Number(process.argv[2] || 6);
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), ".config/momentinsight/backup.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const q = async (p) => (await fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, { headers: h })).json();
const kst = (i) => (i ? new Date(i).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 19) : "-");
const sh = (c) => { try { return execSync(c, { encoding: "utf8", timeout: 20000 }).trim(); } catch (e) { return `(실패: ${String(e.message).slice(0, 80)})`; } };
const since = new Date(Date.now() - hours * 3600e3).toISOString();
console.log(`# 지금 ${kst(new Date().toISOString())} KST · 최근 ${hours}시간`);
const c = (await q("naver_shopping_worker_coordination?select=*&lane_key=eq.global"))[0];
const stale = c.primary_seen_at ? Math.round((Date.now() - Date.parse(c.primary_seen_at)) / 60000) : null;
console.log(`\n## 코디네이션\n주작업기 ${c.primary_worker_id} 마지막 신호 ${kst(c.primary_seen_at)} (${stale}분 전) · 임대 ${c.lease_worker_id || "-"} ${c.current_stage || ""} p${c.current_page}\n회로 ${c.circuit_state} ${c.circuit_reason || ""} 열림 ${kst(c.circuit_opened_at)} streak ${c.failure_streak} · cooldown ${kst(c.cooldown_until)} block ${c.last_block_code || "-"} · 런타임 ${c.runtime_version}`);
const runs = await q("naver_shopping_worker_runs?select=worker_id,run_trigger,runtime_version,started_at&order=started_at.desc&limit=6");
console.log("\n## 최근 런"); for (const r of runs) console.log(` ${kst(r.started_at)} ${r.worker_id} ${r.run_trigger} ${r.runtime_version}`);
const ev = await q(`naver_shopping_scheduler_events?select=occurred_at,event_type,error_code,worker_id,tracker_id,details&occurred_at=gte.${since}&event_type=in.(tracker_committed,finite_window_committed,job_failed)&order=occurred_at.desc&limit=400`);
const ids = [...new Set(ev.map((e) => e.tracker_id).filter(Boolean))];
const kw = Object.fromEntries((ids.length ? await q(`naver_rank_trackers?select=id,keyword&id=in.(${ids.join(",")})`) : []).map((t) => [t.id, t.keyword]));
const fails = ev.filter((e) => e.event_type === "job_failed"); const commits = ev.length - fails.length;
const byWorker = {}; for (const e of ev) if (e.event_type !== "job_failed") byWorker[e.worker_id] = (byWorker[e.worker_id] || 0) + 1;
console.log(`\n## 결과 ${hours}h: 커밋 ${commits} · 실패 ${fails.length} (${(fails.length / Math.max(1, ev.length) * 100).toFixed(1)}%) · 워커별 ${JSON.stringify(byWorker)} · 마지막 커밋 ${kst(ev.find((e) => e.event_type !== "job_failed")?.occurred_at)}`);
for (const e of fails.slice(0, 10)) console.log(` 실패 ${kst(e.occurred_at)} ${e.worker_id} ${e.error_code} ${kw[e.tracker_id] || ""}`);
const evd = await q("naver_shopping_failure_evidence?select=occurred_at,error_code,keyword,evidence&order=occurred_at.desc&limit=2");
console.log("\n## 최근 실패 증거"); for (const r of evd) { console.log(` ${kst(r.occurred_at)} ${r.keyword} ${r.error_code} ${r.evidence?.version}`); for (const t of r.evidence?.trace || []) console.log(`   trace: ${t}`); if (r.evidence?.diff) console.log(`   diff: ${JSON.stringify(r.evidence.diff).slice(0, 300)}`); }
console.log("\n## 공개 상태\n" + sh("curl -s -m 15 https://insight.momentlabs.co.kr/api/rank-collection-health | head -c 420") + "\n" + sh("curl -s -m 15 https://insight.momentlabs.co.kr/health | grep -o '\"release\":\"[^\"]*\"'"));
const L = path.join(os.homedir(), "Library/Logs/MomentInsight");
console.log("\n## 이 맥\n전원: " + sh("pmset -g batt | sed -n 1,2p | tr '\\n' ' '"));
const lidClosed = /AppleClamshellState" = Yes/.test(sh("ioreg -r -k AppleClamshellState -d 4 | grep AppleClamshellState | head -1"));
const onBattery = /Battery Power/.test(sh("pmset -g batt | head -1"));
console.log(`뚜껑: ${lidClosed ? "닫힘" : "열림"} · 전원: ${onBattery ? "배터리" : "어댑터"}`);
if (lidClosed) console.log(" ⚠ 뚜껑이 닫혀 있으면 맥은 잠들고 15분마다 수십 초만 깨어난다 → 수집이 provider_deadline_exceeded 로 실패하거나 멈춘다. caffeinate 로는 못 막는다. 대표가 뚜껑을 열고 전원을 꽂아야 한다.");
console.log("네이티브 호스트(1초 만에 exit 0 반복 = 서버가 일을 안 줌, status=1 = 게이트 거절):\n" + sh(`tail -6 "${L}/naver-shopping-native-host.log"`));
console.log("워치독:\n" + sh(`tail -5 "${L}/mi-rank-watchdog.log" | cut -c1-150`));
console.log("절전 이력:\n" + sh("pmset -g log | grep -E 'Entering Sleep|Wake from' | tail -4 | cut -c1-100"));
console.log("\n## 판정 힌트");
if (c.circuit_state === "open") console.log(` 회로 open(${c.circuit_reason}) → 주작업기 무신호 ${stale}분. 사유별 조치는 SKILL.md 판정표, 수동 복구는 recovery-sql.sh "${c.circuit_reason}"`);
else if (stale != null && stale > 3 && !byWorker["macbook-standby"]) console.log(" 주작업기 무신호인데 대기기 커밋 없음 → 맥 전원·뚜껑·Chrome(Profile 5)·네이버 로그인 확인");
else console.log(" 회로 정상. 실패 목록과 증거 trace 를 본다.");
