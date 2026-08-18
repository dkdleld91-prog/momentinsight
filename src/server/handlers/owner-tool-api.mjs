import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { protectedJson } from "../security.mjs";

const MAX_TOTAL = 999_999_999_999_999n;
const OWNER_TOOL_PATH = "/api/owner/tool";
const MAX_ASSISTANT_INPUT = 6000;
const MAX_ASSISTANT_SEGMENTS = 12;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = new Map([
  ["월", 0], ["화", 1], ["수", 2], ["목", 3], ["금", 4], ["토", 5], ["일", 6],
]);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function kstDateParts(now) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addCalendarDays(parts, days) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function validCalendarDate(parts) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return value.getUTCFullYear() === parts.year
    && value.getUTCMonth() + 1 === parts.month
    && value.getUTCDate() === parts.day;
}

function assistantDateParts(text, now) {
  const base = kstDateParts(now);
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/u);
  if (iso) {
    const parts = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    return validCalendarDate(parts) ? parts : null;
  }
  const korean = text.match(/\b(\d{1,2})월\s*(\d{1,2})일\b/u);
  if (korean) {
    const parts = { year: base.year, month: Number(korean[1]), day: Number(korean[2]) };
    return validCalendarDate(parts) ? parts : null;
  }
  if (/모레/u.test(text)) return addCalendarDays(base, 2);
  if (/내일/u.test(text)) return addCalendarDays(base, 1);
  if (/오늘/u.test(text)) return base;
  const weekday = text.match(/(?:(이번\s*주|다음\s*주)\s*)?([월화수목금토일])요일/u);
  if (!weekday) return null;
  const baseDate = new Date(Date.UTC(base.year, base.month - 1, base.day));
  const baseMondayIndex = (baseDate.getUTCDay() + 6) % 7;
  const targetIndex = WEEKDAYS.get(weekday[2]);
  if (weekday[1]) {
    const weekOffset = /다음/u.test(weekday[1]) ? 7 : 0;
    return addCalendarDays(base, -baseMondayIndex + weekOffset + targetIndex);
  }
  let distance = targetIndex - baseMondayIndex;
  if (distance < 0) distance += 7;
  return addCalendarDays(base, distance);
}

function assistantTimeParts(text) {
  const clock = text.match(/(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$|[,.])/u);
  if (clock) return { hour: Number(clock[1]), minute: Number(clock[2]), explicit: true };
  const korean = text.match(/(?:(오전|오후)\s*)?(\d{1,2})시(?:\s*(\d{1,2})분)?/u);
  if (!korean) return { hour: 9, minute: 0, explicit: false };
  let hour = Number(korean[2]);
  const minute = Number(korean[3] || 0);
  if (hour > 23 || minute > 59 || (korean[1] && hour > 12)) return null;
  if (korean[1] === "오후" && hour < 12) hour += 12;
  if (korean[1] === "오전" && hour === 12) hour = 0;
  return { hour, minute, explicit: true };
}

function assistantIso(parts, time) {
  return new Date(`${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(time.hour)}:${pad2(time.minute)}:00+09:00`).toISOString();
}

function assistantScheduleType(text) {
  const rules = [
    ["meeting", /미팅|회의|통화|상담/u],
    ["report_due", /보고서|리포트|제출/u],
    ["shooting", /촬영/u],
    ["creative", /소재|디자인|배너|영상\s*제작/u],
    ["content_upload", /콘텐츠\s*업로드|게시|발행/u],
    ["distribution", /배포|블로그|카페/u],
    ["review", /리뷰/u],
    ["promotion", /프로모션|행사|할인/u],
    ["keyword", /키워드|SEO|검색/u],
    ["ad_setup", /광고|캠페인|세팅/u],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "ad_setup";
}

function assistantTitle(text) {
  const cleaned = String(text || "")
    .replace(/^(?:[-*•]|\d+[.)])\s*/u, "")
    .replace(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}월\s*\d{1,2}일\b/gu, " ")
    .replace(/(?:이번\s*주|다음\s*주)?\s*[월화수목금토일]요일|오늘|내일|모레/gu, " ")
    .replace(/(?:오전|오후)?\s*\d{1,2}시(?!간)(?:\s*\d{1,2}분)?|(?:^|\s)(?:[01]?\d|2[0-3]):[0-5]\d(?=\s|$|[,.])/gu, " ")
    .replace(/\d{1,2}시간|\d{1,3}분/gu, " ")
    .replace(/(?:담당|담당자)\s*[:：]\s*[^,|/]{1,60}/gu, " ")
    .replace(/^회의\s*메모\s*[:：-]?/u, "")
    .replace(/(?:일정(?:에)?\s*)?(?:등록|추가)(?:해\s*줘|해주세요|해줘|해요)?[.!?]?$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.slice(0, 120);
}

function assistantDraft(segment, now) {
  const date = assistantDateParts(segment, now);
  const time = assistantTimeParts(segment);
  if (!date || !time) return null;
  const startsAt = assistantIso(date, time);
  const durationHours = Math.min(12, Math.max(0, Number(segment.match(/(\d{1,2})시간/u)?.[1] || 0)));
  const durationMinutes = Math.min(720, Math.max(0, Number(segment.match(/(?:소요\s*(\d{1,3})분|(\d{1,3})분\s*동안)/u)?.slice(1).find(Boolean) || 0)));
  const durationMs = (durationHours * 60 + durationMinutes || 60) * 60 * 1000;
  const title = assistantTitle(segment);
  if (!title) return null;
  const assignee = segment.match(/(?:담당|담당자)\s*[:：]\s*([^,|/]{1,60})/u)?.[1]?.trim() || "";
  return {
    title,
    scheduleType: assistantScheduleType(segment),
    status: "planned",
    priority: /긴급|최우선|중요/u.test(segment) ? "high" : "medium",
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + durationMs).toISOString(),
    assigneeName: assignee.slice(0, 60),
    internalNote: `자비스 초안 원문: ${segment}`.slice(0, 4000),
    isAllDay: !time.explicit,
    visibility: "internal",
    publicTitle: "",
    publicComment: "",
  };
}

export function parseOwnerAssistantDrafts(value, options = {}) {
  const prompt = String(value ?? "").trim();
  if (!prompt || prompt.length > MAX_ASSISTANT_INPUT) {
    return { ok: false, message: prompt ? "입력은 6,000자 이하로 작성해주세요." : "일정 또는 회의 메모를 입력해주세요." };
  }
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const segments = prompt
    .split(/\n+|(?<=[.!?])\s+(?=(?:오늘|내일|모레|이번\s*주|다음\s*주|20\d{2}[-/.]|\d{1,2}월))/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_ASSISTANT_SEGMENTS);
  const drafts = [];
  const unresolved = [];
  for (const segment of segments) {
    const draft = assistantDraft(segment, now);
    if (draft) drafts.push(draft);
    else unresolved.push(segment.slice(0, 500));
  }
  return {
    ok: true,
    source: "deterministic-private-v1",
    generatedAt: now.toISOString(),
    drafts,
    unresolved,
  };
}

const toolCss = String.raw`
#mi-admin .mi-vat-layout{display:grid;grid-template-columns:minmax(0,.86fr) minmax(420px,1.14fr);gap:16px;align-items:stretch}
#mi-admin .mi-vat-entry,#mi-admin .mi-vat-results{min-width:0;padding:26px}
#mi-admin .mi-vat-entry{display:flex;flex-direction:column;justify-content:space-between;gap:24px}
#mi-admin .mi-vat-entry-head{display:grid;gap:5px}
#mi-admin .mi-vat-entry-head h2,#mi-admin .mi-vat-results h2{margin-bottom:0;font-size:20px}
#mi-admin .mi-vat-entry-head p{font-size:13px}
#mi-admin .mi-vat-field{display:grid;gap:9px;color:var(--mi-muted);font-size:12px;font-weight:900}
#mi-admin .mi-vat-amount-control{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-height:68px;border:1px solid rgba(6,26,58,.18);border-radius:10px;padding:0 18px;background:linear-gradient(180deg,#fff 0%,#f8fafc 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.9);transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
#mi-admin .mi-vat-amount-control:focus-within{border-color:rgba(6,26,58,.46);background:#fff;box-shadow:0 0 0 4px rgba(6,26,58,.07)}
#mi-admin .mi-vat-amount-control input{min-width:0;width:100%;border:0;padding:0 12px 0 0;color:var(--mi-navy);background:transparent;outline:0;font-size:30px;font-weight:950;letter-spacing:-.025em;text-align:right}
#mi-admin .mi-vat-amount-control input::placeholder{color:#b0b8c5}
#mi-admin .mi-vat-amount-control span{color:var(--mi-muted);font-size:15px;font-weight:900}
#mi-admin .mi-vat-entry-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:2px}
#mi-admin .mi-vat-entry-footer p{max-width:310px;font-size:12px;line-height:1.55}
#mi-admin .mi-vat-results{display:grid;gap:12px;background:linear-gradient(145deg,#fff 0%,#f7f9fc 100%)}
#mi-admin .mi-vat-result-list{display:grid;gap:9px}
#mi-admin .mi-vat-result{display:grid;grid-template-columns:minmax(108px,.55fr) minmax(150px,1fr) auto;gap:14px;align-items:center;min-height:72px;border:1px solid var(--mi-line);border-radius:9px;padding:12px 13px 12px 16px;background:rgba(255,255,255,.92)}
#mi-admin .mi-vat-result.is-total{border-color:rgba(6,26,58,.16);background:linear-gradient(135deg,rgba(6,26,58,.965) 0%,#0b2a57 100%);box-shadow:0 14px 28px rgba(6,26,58,.13)}
#mi-admin .mi-vat-result-label{display:grid;gap:2px;color:var(--mi-muted);font-size:13px;font-weight:900}
#mi-admin .mi-vat-result-label small{color:#98a2b3;font-size:10px;font-weight:800}
#mi-admin .mi-vat-result strong{color:var(--mi-navy);font-size:23px;line-height:1.15;text-align:right;white-space:nowrap}
#mi-admin .mi-vat-result.is-total .mi-vat-result-label,#mi-admin .mi-vat-result.is-total .mi-vat-result-label small{color:rgba(255,255,255,.72)}
#mi-admin .mi-vat-result.is-total strong{color:#fff}
#mi-admin .mi-vat-copy{min-width:74px;min-height:36px;border:1px solid rgba(6,26,58,.13);border-radius:8px;padding:0 11px;color:var(--mi-navy);background:#fff;font-size:12px;font-weight:900;cursor:pointer;transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease,opacity .14s ease}
#mi-admin .mi-vat-copy:hover:not(:disabled){border-color:rgba(6,26,58,.34);box-shadow:0 7px 16px rgba(6,26,58,.1);transform:translateY(-1px)}
#mi-admin .mi-vat-copy:active:not(:disabled){transform:translateY(1px)}
#mi-admin .mi-vat-copy:focus-visible{outline:3px solid rgba(30,99,215,.2);outline-offset:2px}
#mi-admin .mi-vat-copy:disabled{cursor:not-allowed;opacity:.45}
#mi-admin .mi-vat-result.is-total .mi-vat-copy{border-color:rgba(255,255,255,.22);color:#fff;background:rgba(255,255,255,.1)}
#mi-admin .mi-vat-result.is-total .mi-vat-copy:hover:not(:disabled){border-color:rgba(255,255,255,.48);background:rgba(255,255,255,.16)}
#mi-admin .mi-vat-status{min-height:20px;color:var(--mi-muted);font-size:12px;font-weight:800}
#mi-admin .mi-vat-status.is-ok{color:var(--mi-green)}
#mi-admin .mi-vat-status.is-warn{color:var(--mi-orange)}
@media(max-width:900px){#mi-admin .mi-vat-layout{grid-template-columns:1fr}}
@media(max-width:520px){#mi-admin .mi-vat-entry,#mi-admin .mi-vat-results{padding:18px}#mi-admin .mi-vat-entry-footer{align-items:flex-start;flex-direction:column}#mi-admin .mi-vat-amount-control{min-height:62px;padding:0 14px}#mi-admin .mi-vat-amount-control input{font-size:25px}#mi-admin .mi-vat-result{grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;padding:13px}#mi-admin .mi-vat-result-label{grid-column:1/-1}#mi-admin .mi-vat-result strong{font-size:21px;text-align:left}}
`;

const developmentCss = String.raw`
#mi-admin .mi-owner-development-nav{position:relative;margin-top:22px;padding-top:17px}
#mi-admin .mi-owner-development-nav:before{content:"";position:absolute;inset:0 10px auto;height:1px;background:linear-gradient(90deg,transparent,rgba(6,26,58,.17),transparent)}
#mi-admin .mi-owner-development-nav .mi-nav-title{display:flex;align-items:center;gap:7px;color:#59667a;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;letter-spacing:.075em}
#mi-admin .mi-owner-development-nav .mi-nav-title:before{content:"";width:6px;height:6px;border-radius:50%;background:#24a06b;box-shadow:0 0 0 4px rgba(36,160,107,.1)}
#mi-admin .mi-owner-development-nav a{border-color:rgba(6,26,58,.08);background:linear-gradient(135deg,rgba(255,255,255,.88),rgba(241,245,249,.88));box-shadow:inset 0 1px 0 rgba(255,255,255,.8)}
#mi-admin .mi-owner-development-nav a small{display:inline-flex;min-height:20px;align-items:center;border:1px solid rgba(36,160,107,.2);border-radius:999px;padding:1px 7px;color:#157a53;background:rgba(36,160,107,.08);font-size:9px;font-weight:950;letter-spacing:.06em}
#mi-admin .mi-owner-development{display:none;gap:18px}
#mi-admin .mi-owner-development.is-active{display:grid}
#mi-admin .mi-owner-development-hero{position:relative;display:flex;align-items:center;justify-content:space-between;gap:22px;overflow:hidden;border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:28px 30px;color:#fff;background:radial-gradient(circle at 88% -20%,rgba(62,205,151,.22),transparent 38%),linear-gradient(135deg,#061a34 0%,#0b2b50 58%,#123e66 100%);box-shadow:0 22px 54px rgba(6,26,52,.18)}
#mi-admin .mi-owner-development-hero:after{content:"</>";position:absolute;right:24px;bottom:-32px;color:rgba(255,255,255,.045);font:950 112px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:-.12em;pointer-events:none}
#mi-admin .mi-owner-development-identity{position:relative;z-index:1;display:grid;grid-template-columns:54px minmax(0,1fr);gap:16px;align-items:center;min-width:0}
#mi-admin .mi-owner-development-symbol{display:grid;width:54px;height:54px;place-items:center;border:1px solid rgba(255,255,255,.16);border-radius:16px;color:#8df0c8;background:rgba(255,255,255,.07);box-shadow:inset 0 1px 0 rgba(255,255,255,.12);font:900 17px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:-.08em}
#mi-admin .mi-owner-development-copy{display:grid;gap:5px}
#mi-admin .mi-owner-development-copy small{color:#8df0c8;font-size:10px;font-weight:950;letter-spacing:.14em;text-transform:uppercase}
#mi-admin .mi-owner-development-copy h1{margin:0;color:#fff;font-size:26px;line-height:1.2;letter-spacing:-.035em}
#mi-admin .mi-owner-development-copy p{max-width:710px;margin:0;color:#bfd0e3;font-size:12.5px;font-weight:700;line-height:1.6}
#mi-admin .mi-owner-development-seal{position:relative;z-index:1;display:grid;flex:0 0 auto;gap:3px;min-width:142px;border:1px solid rgba(141,240,200,.28);border-radius:14px;padding:11px 14px;background:rgba(4,18,37,.32);box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}
#mi-admin .mi-owner-development-seal span{color:#8df0c8;font-size:9px;font-weight:950;letter-spacing:.12em}
#mi-admin .mi-owner-development-seal strong{color:#fff;font-size:12px;font-weight:900}
#mi-admin .mi-owner-development-frame{display:grid;gap:14px;border:1px solid rgba(6,26,58,.09);border-radius:20px;padding:18px;background:linear-gradient(180deg,#fff 0%,#f7f9fc 100%);box-shadow:0 16px 42px rgba(6,26,58,.075)}
#mi-admin .mi-owner-development-principles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
#mi-admin .mi-owner-development-principle{display:grid;gap:5px;min-height:78px;border:1px solid rgba(6,26,58,.085);border-radius:14px;padding:13px 14px;background:rgba(255,255,255,.9);box-shadow:0 8px 20px rgba(6,26,58,.045)}
#mi-admin .mi-owner-development-principle span{color:#24a06b;font:950 9px/1.3 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:.1em}
#mi-admin .mi-owner-development-principle strong{color:var(--mi-navy);font-size:13px;font-weight:950}
#mi-admin .mi-owner-development-principle small{color:#69778a;font-size:10.5px;font-weight:750;line-height:1.45}
#mi-admin .mi-owner-development-rail{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:1px 2px}
#mi-admin .mi-owner-development-rail div{display:grid;gap:3px}
#mi-admin .mi-owner-development-rail span{color:#7b8797;font-size:9.5px;font-weight:950;letter-spacing:.105em}
#mi-admin .mi-owner-development-rail strong{color:var(--mi-navy);font-size:13px;font-weight:950}
#mi-admin .mi-owner-development-rail>span{display:inline-flex;min-height:26px;align-items:center;border:1px solid rgba(6,26,58,.1);border-radius:999px;padding:3px 10px;color:#526175;background:#fff;letter-spacing:.025em}
#mi-admin .mi-owner-development .mi-rank-worker-operations{gap:17px;margin:0;border-radius:18px;padding:20px;background:radial-gradient(circle at 92% -15%,rgba(77,181,145,.18),transparent 35%),linear-gradient(145deg,#071c36 0%,#0d2a4b 100%);box-shadow:0 18px 40px rgba(7,31,61,.14)}
#mi-admin .mi-owner-development .mi-rank-worker-head strong{font-size:18px;letter-spacing:-.02em}
#mi-admin .mi-owner-development .mi-rank-worker-head small{margin-top:2px;font-size:11.5px}
#mi-admin .mi-rank-worker-sections{display:grid;gap:14px}
#mi-admin .mi-rank-worker-section{display:grid;gap:8px}
#mi-admin .mi-rank-worker-section+.mi-rank-worker-section{border-top:1px solid rgba(255,255,255,.1);padding-top:14px}
#mi-admin .mi-rank-worker-section-head{display:flex;align-items:center;gap:8px}
#mi-admin .mi-rank-worker-section-head span{display:grid;width:23px;height:23px;place-items:center;border:1px solid rgba(141,240,200,.24);border-radius:7px;color:#8df0c8;background:rgba(141,240,200,.07);font:950 9px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
#mi-admin .mi-rank-worker-section-head strong{color:#e8f1fb;font-size:11px;font-weight:950;letter-spacing:.04em}
#mi-admin .mi-owner-development .mi-rank-worker-metric{min-height:88px;border-radius:13px;padding:12px 13px;background:linear-gradient(145deg,rgba(255,255,255,.075),rgba(255,255,255,.035));box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
#mi-admin .mi-owner-development .mi-rank-worker-metric strong{margin:8px 0 4px;font-size:15px}
#mi-admin .mi-owner-development .mi-rank-worker-section.is-safety .mi-rank-worker-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
#mi-admin .mi-owner-development .mi-rank-worker-actions{gap:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:15px}
#mi-admin .mi-owner-development .mi-rank-worker-actions .mi-button{min-height:42px;border-radius:10px;padding:0 15px}
#mi-admin .mi-owner-development .mi-rank-worker-actions .mi-button.is-danger{margin-right:auto}
#mi-admin .mi-owner-development .mi-rank-worker-note{border-radius:9px;padding:9px 11px;background:rgba(255,255,255,.045)}
@media(max-width:1120px){#mi-admin .mi-owner-development .mi-rank-worker-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){#mi-admin .mi-owner-development-nav{margin-top:0;padding-top:0}#mi-admin .mi-owner-development-nav:before{display:none}#mi-admin .mi-owner-development-nav .mi-nav-title{display:none}}
@media(max-width:760px){#mi-admin .mi-owner-development-hero{align-items:flex-start;flex-direction:column;padding:23px}#mi-admin .mi-owner-development-seal{min-width:0}#mi-admin .mi-owner-development-frame{padding:13px}#mi-admin .mi-owner-development-principles{grid-template-columns:1fr}#mi-admin .mi-owner-development-rail{align-items:flex-start;flex-direction:column}#mi-admin .mi-owner-development .mi-rank-worker-operations{padding:15px}}
@media(max-width:520px){#mi-admin .mi-owner-development-identity{grid-template-columns:44px minmax(0,1fr);gap:12px}#mi-admin .mi-owner-development-symbol{width:44px;height:44px;border-radius:13px;font-size:14px}#mi-admin .mi-owner-development-copy h1{font-size:22px}#mi-admin .mi-owner-development-copy p{font-size:11.5px}#mi-admin .mi-owner-development .mi-rank-worker-metrics,#mi-admin .mi-owner-development .mi-rank-worker-section.is-safety .mi-rank-worker-metrics{grid-template-columns:1fr}#mi-admin .mi-owner-development .mi-rank-worker-actions .mi-button{width:100%;margin-right:0}}
`;

const assistantCss = String.raw`
#mi-admin .mi-owner-assistant{display:none;gap:18px}
#mi-admin .mi-owner-assistant.is-active{display:grid}
#mi-admin .mi-assistant-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;border:1px solid rgba(6,26,58,.08);border-radius:22px;padding:26px 28px;background:radial-gradient(circle at 90% 0,rgba(31,111,235,.13),transparent 38%),linear-gradient(145deg,#fff 0%,#f4f7fb 100%);box-shadow:0 18px 44px rgba(6,26,58,.08)}
#mi-admin .mi-assistant-hero-copy{display:grid;gap:6px}
#mi-admin .mi-assistant-hero-copy small{color:#1f6feb;font-size:10px;font-weight:950;letter-spacing:.14em;text-transform:uppercase}
#mi-admin .mi-assistant-hero-copy h1{margin:0;color:var(--mi-navy);font-size:27px;letter-spacing:-.04em}
#mi-admin .mi-assistant-hero-copy p{max-width:720px;margin:0;color:#64748b;font-size:12.5px;font-weight:750;line-height:1.6}
#mi-admin .mi-assistant-scope{display:grid;flex:0 0 auto;gap:3px;min-width:174px;border:1px solid rgba(31,111,235,.16);border-radius:14px;padding:11px 14px;background:#fff}
#mi-admin .mi-assistant-scope span{color:#718096;font-size:9px;font-weight:950;letter-spacing:.1em}
#mi-admin .mi-assistant-scope strong{overflow:hidden;color:var(--mi-navy);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
#mi-admin .mi-assistant-scope small{color:#8a96a8;font-size:9px;font-weight:750}
#mi-admin .mi-assistant-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(420px,1.2fr);gap:16px;align-items:start}
#mi-admin .mi-assistant-panel{display:grid;gap:15px;min-width:0;border:1px solid rgba(6,26,58,.09);border-radius:19px;padding:20px;background:#fff;box-shadow:0 13px 34px rgba(6,26,58,.055)}
#mi-admin .mi-assistant-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
#mi-admin .mi-assistant-panel-head h2{margin:0;color:var(--mi-navy);font-size:18px}
#mi-admin .mi-assistant-panel-head p{margin:4px 0 0;color:#758197;font-size:11px;font-weight:700;line-height:1.5}
#mi-admin .mi-assistant-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
#mi-admin .mi-assistant-metric{display:grid;gap:4px;border:1px solid #e8edf4;border-radius:13px;padding:13px;background:#f8fafc}
#mi-admin .mi-assistant-metric span{color:#7a8799;font-size:10px;font-weight:900}
#mi-admin .mi-assistant-metric strong{color:var(--mi-navy);font-size:24px;line-height:1}
#mi-admin .mi-assistant-agenda{display:grid;gap:7px}
#mi-admin .mi-assistant-agenda-item{display:grid;grid-template-columns:70px minmax(0,1fr);gap:10px;align-items:center;border-top:1px solid #edf1f6;padding-top:8px}
#mi-admin .mi-assistant-agenda-item time{color:#1f6feb;font-size:10px;font-weight:950}
#mi-admin .mi-assistant-agenda-item strong{overflow:hidden;color:#253858;font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}
#mi-admin .mi-assistant-empty{border:1px dashed #d8e0ea;border-radius:12px;padding:18px;color:#7b8797;background:#fbfcfe;font-size:11px;font-weight:800;text-align:center}
#mi-admin .mi-assistant-chips{display:flex;flex-wrap:wrap;gap:7px}
#mi-admin .mi-assistant-chip{min-height:31px;border:1px solid #dce4ee;border-radius:999px;padding:0 11px;color:#475569;background:#fff;font-size:10px;font-weight:900;cursor:pointer}
#mi-admin .mi-assistant-chip:hover{border-color:#91b7ee;color:#165fbf;background:#f5f9ff}
#mi-admin .mi-assistant-input{min-height:150px;resize:vertical}
#mi-admin .mi-assistant-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
#mi-admin .mi-assistant-actions small{max-width:330px;color:#7a8798;font-size:10px;font-weight:750;line-height:1.45}
#mi-admin .mi-assistant-status{min-height:20px;color:#64748b;font-size:11px;font-weight:850}
#mi-admin .mi-assistant-status.is-ok{color:var(--mi-green)}
#mi-admin .mi-assistant-status.is-warn{color:var(--mi-orange)}
#mi-admin .mi-assistant-results{display:grid;gap:9px}
#mi-admin .mi-assistant-draft{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;border:1px solid #e4eaf2;border-radius:14px;padding:13px 14px;background:#fbfcfe}
#mi-admin .mi-assistant-draft-copy{display:grid;gap:4px;min-width:0}
#mi-admin .mi-assistant-draft-copy strong{overflow:hidden;color:var(--mi-navy);font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}
#mi-admin .mi-assistant-draft-copy span{color:#6f7d90;font-size:10.5px;font-weight:800}
#mi-admin .mi-assistant-draft button{min-height:34px;white-space:nowrap}
#mi-admin .mi-assistant-draft.is-saved{border-color:rgba(30,140,93,.24);background:#f4fbf7}
#mi-admin .mi-assistant-unresolved{display:grid;gap:6px;border:1px solid #f3d8b5;border-radius:12px;padding:12px;background:#fff9f2}
#mi-admin .mi-assistant-unresolved strong{color:#a55b12;font-size:11px}
#mi-admin .mi-assistant-unresolved span{color:#8b6a47;font-size:10.5px;line-height:1.45}
@media(max-width:980px){#mi-admin .mi-assistant-grid{grid-template-columns:1fr}}
@media(max-width:640px){#mi-admin .mi-assistant-hero{align-items:flex-start;flex-direction:column;padding:21px}#mi-admin .mi-assistant-scope{width:100%}#mi-admin .mi-assistant-panel{padding:15px}#mi-admin .mi-assistant-actions{align-items:stretch;flex-direction:column}#mi-admin .mi-assistant-actions .mi-button{width:100%}#mi-admin .mi-assistant-draft{grid-template-columns:1fr}#mi-admin .mi-assistant-draft button{width:100%}}
`;

const utilityViewHtml = String.raw`<section class="mi-view" data-mi-admin-view="owner-utility" id="mi-admin-owner-utility" aria-label="총관리자 전용 부가세 계산기">
  <header class="mi-head"><div><span class="mi-kicker">Owner Utility</span><h1>부가세를 빠르게 계산합니다.</h1><p>부가세 포함 금액을 입력하면 공급가액·부가세액·합계금액을 자동으로 계산합니다.</p></div><span class="mi-badge">총관리자 전용</span></header>
  <div class="mi-vat-layout">
    <article class="mi-card mi-vat-entry"><div class="mi-vat-entry-head"><h2>부가세 포함 금액</h2><p>최종 합계금액을 입력해주세요.</p></div><label class="mi-vat-field" for="mi-owner-tool-input">입력 금액<span class="mi-vat-amount-control"><input id="mi-owner-tool-input" data-owner-tool-input inputmode="numeric" autocomplete="off" maxlength="19" placeholder="0" aria-describedby="mi-owner-tool-help"/><span aria-hidden="true">원</span></span></label><div class="mi-vat-entry-footer"><p id="mi-owner-tool-help">입력한 합계금액에서 공급가액과 10% 부가세액을 원 단위로 역산합니다.</p><button class="mi-button is-ghost mi-button-small" type="button" data-owner-tool-reset>초기화</button></div></article>
    <article class="mi-card mi-vat-results" aria-label="부가세 계산 결과"><h2>계산 결과</h2><div class="mi-vat-result-list">
      <div class="mi-vat-result is-total"><span class="mi-vat-result-label">합계금액<small>공급가액 + 부가세액</small></span><strong data-owner-tool-output="total">0원</strong><button class="mi-vat-copy" type="button" data-owner-tool-copy="total" aria-label="합계금액 복사" disabled>복사</button></div>
      <div class="mi-vat-result"><span class="mi-vat-result-label">공급가액<small>부가세 미포함</small></span><strong data-owner-tool-output="supply">0원</strong><button class="mi-vat-copy" type="button" data-owner-tool-copy="supply" aria-label="공급가액 복사" disabled>복사</button></div>
      <div class="mi-vat-result"><span class="mi-vat-result-label">부가세액<small>10%</small></span><strong data-owner-tool-output="tax">0원</strong><button class="mi-vat-copy" type="button" data-owner-tool-copy="tax" aria-label="부가세액 복사" disabled>복사</button></div>
    </div><div class="mi-vat-status" data-owner-tool-status aria-live="polite">금액을 입력하면 자동으로 계산됩니다.</div></article>
  </div>
</section>`;

const menuHtml = String.raw`<div class="mi-nav-group mi-owner-development-nav" data-owner-development-nav>
  <p class="mi-nav-title">개발 &lt;/&gt;</p>
  <a href="#mi-admin-owner-development" data-mi-admin-screen="owner-development"><span>N 쇼핑 수집 운영</span><small>OWNER</small></a>
  <a href="#mi-admin-owner-assistant" data-mi-admin-screen="owner-assistant"><span>자비스 운영 비서</span><small>CANARY</small></a>
  <a href="#mi-admin-owner-utility" data-mi-admin-screen="owner-utility"><span>부가세 계산기</span></a>
</div>`;

const developmentViewHtml = String.raw`<section class="mi-view mi-owner-development" data-mi-admin-view="owner-development" id="mi-admin-owner-development" aria-label="총관리자 전용 N 쇼핑 수집 운영 화면">
  <header class="mi-owner-development-hero">
    <div class="mi-owner-development-identity">
      <span class="mi-owner-development-symbol" aria-hidden="true">&lt;/&gt;</span>
      <div class="mi-owner-development-copy"><small>Development control plane</small><h1>N 쇼핑 수집 운영</h1><p>Windows 주 작업기와 Mac 대기 작업기의 수집 상태, 안전 회로, 공정 큐와 실행 계약을 한 화면에서 관리합니다.</p></div>
    </div>
    <div class="mi-owner-development-seal" aria-label="접근 권한"><span>OWNER ACCESS</span><strong>mml93-a01 전용</strong></div>
  </header>
  <div class="mi-owner-development-frame">
    <div class="mi-owner-development-rail"><div><span>LIVE OPERATIONS</span><strong>순위 데이터와 분리된 수집 제어 영역</strong></div><span>Protected workspace</span></div>
    <div class="mi-owner-development-principles" aria-label="수집 운영 원칙">
      <article class="mi-owner-development-principle"><span>01 · SINGLE LANE</span><strong>한 번에 한 키워드</strong><small>Windows 주 작업기와 Mac 대기 작업기가 같은 작업을 중복 실행하지 않습니다.</small></article>
      <article class="mi-owner-development-principle"><span>02 · ATOMIC PROOF</span><strong>오가닉 300개 검증</strong><small>광고를 제외한 완전한 결과만 정상 순위와 이력으로 반영합니다.</small></article>
      <article class="mi-owner-development-principle"><span>03 · FAIL CLOSED</span><strong>마지막 정상 기록 보존</strong><small>보안 제한이나 불완전 수집은 실패로 닫고 정상 데이터를 덮어쓰지 않습니다.</small></article>
    </div>
    <section class="mi-rank-worker-operations" data-rank-worker-operations hidden aria-label="N 쇼핑 순위 수집 운영 상태">
      <div data-rank-worker-operations-content></div>
      <p class="mi-rank-worker-control-status" data-rank-worker-control-status aria-live="polite"></p>
    </section>
  </div>
</section>`;

const assistantViewHtml = String.raw`<section class="mi-view mi-owner-assistant" data-mi-admin-view="owner-assistant" id="mi-admin-owner-assistant" aria-label="mml93-a01 전용 자비스 운영 비서">
  <header class="mi-assistant-hero">
    <div class="mi-assistant-hero-copy"><small>Jarvis · owner canary</small><h1>오늘의 운영을 일정으로 연결합니다.</h1><p>현재 일정표를 요약하고 자연어 일정·회의 메모를 내부 업무 초안으로 정리합니다. 확인하기 전에는 저장하거나 공개하지 않습니다.</p></div>
    <div class="mi-assistant-scope"><span>CURRENT SCOPE</span><strong data-owner-assistant-scope>총관리자 내부 일정</strong><small>광고주 범위는 업무 운영에서 선택</small></div>
  </header>
  <div class="mi-assistant-grid">
    <article class="mi-assistant-panel">
      <div class="mi-assistant-panel-head"><div><h2>오늘 브리핑</h2><p>현재 선택한 일정 범위의 미완료 업무를 기준으로 계산합니다.</p></div><button class="mi-link-button" type="button" data-owner-assistant-refresh>새로고침</button></div>
      <div class="mi-assistant-summary"><div class="mi-assistant-metric"><span>오늘 업무</span><strong data-owner-assistant-metric="today">0</strong></div><div class="mi-assistant-metric"><span>지연 업무</span><strong data-owner-assistant-metric="overdue">0</strong></div><div class="mi-assistant-metric"><span>확인 필요</span><strong data-owner-assistant-metric="needs_check">0</strong></div><div class="mi-assistant-metric"><span>다가오는 업무</span><strong data-owner-assistant-metric="next">0</strong></div></div>
      <div class="mi-assistant-agenda" data-owner-assistant-agenda><div class="mi-assistant-empty">일정표를 불러오면 우선순위를 정리합니다.</div></div>
    </article>
    <article class="mi-assistant-panel">
      <div class="mi-assistant-panel-head"><div><h2>일정·회의 메모 초안</h2><p>날짜가 확인되는 문장만 초안으로 만들고, 나머지는 확인 필요로 남깁니다.</p></div><span class="mi-badge">외부 전송 없음</span></div>
      <div class="mi-assistant-chips"><button class="mi-assistant-chip" type="button" data-owner-assistant-example="내일 오후 2시 광고주 미팅 1시간 등록해줘">미팅 예시</button><button class="mi-assistant-chip" type="button" data-owner-assistant-example="다음 주 월요일 오전 10시 월간 보고서 최종 검수">보고서 예시</button><button class="mi-assistant-chip" type="button" data-owner-assistant-example="회의 메모&#10;- 8월 21일 오후 3시 소재 시안 검토&#10;- 다음 주 금요일 오전 11시 광고주 결과 보고 미팅">회의 메모 예시</button></div>
      <textarea class="mi-textarea mi-assistant-input" data-owner-assistant-input maxlength="6000" placeholder="예: 내일 오후 2시 광고주 미팅 1시간 등록해줘&#10;여러 일정은 줄을 나눠 입력할 수 있습니다."></textarea>
      <div class="mi-assistant-actions"><small>초안은 모두 내부 비공개입니다. 광고주 공개는 기존 일정 편집에서 별도로 확인합니다.</small><button class="mi-button" type="button" data-owner-assistant-draft>초안 만들기</button></div>
      <div class="mi-assistant-status" data-owner-assistant-status aria-live="polite">입력 내용은 외부 AI로 전송하지 않습니다.</div>
      <div class="mi-assistant-results" data-owner-assistant-results><div class="mi-assistant-empty">만든 초안을 확인한 뒤 항목별로 일정표에 등록할 수 있습니다.</div></div>
    </article>
  </div>
</section>`;

const viewHtml = String.raw`<div class="mi-owner-tool-views" data-owner-tool-views>
  ${developmentViewHtml}
  ${assistantViewHtml}
  ${utilityViewHtml}
</div>`;

function ownerRequest(request) {
  return request.headers.get("x-mi-session-role") === "owner"
    && request.headers.get("x-mi-owner-agency-code") === PRIMARY_AGENCY_CODE;
}

function response(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  });
}

export function calculateOwnerTax(value) {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : String(value ?? "").trim();
  if (!/^\d{1,15}$/.test(raw)) return null;
  const total = BigInt(raw);
  if (total > MAX_TOTAL) return null;
  const supply = ((total * 10n) + 5n) / 11n;
  const tax = total - supply;
  return {
    supply: Number(supply),
    tax: Number(tax),
    total: Number(total),
  };
}

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== OWNER_TOOL_PATH) {
      return response(request, { ok: false, message: "Not found" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (!ownerRequest(request)) {
      return response(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
    }
    if (request.method === "GET") {
      return response(request, {
        ok: true,
        tool: {
          screen: "owner-development",
          menuHtml,
          viewHtml,
          styleText: toolCss + developmentCss + assistantCss,
        },
      });
    }
    if (request.method !== "POST") return response(request, { ok: false, message: "Method not allowed" }, 405);
    if (String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return response(request, { ok: false, message: "JSON 요청만 허용됩니다." }, 415);
    }
    const body = await request.json().catch(() => null);
    if (body?.action === "assistant-draft") {
      const result = parseOwnerAssistantDrafts(body.prompt);
      return response(request, result, result.ok ? 200 : 400);
    }
    if (!body || body.action !== "calculate") return response(request, { ok: false, message: "요청 내용을 확인해주세요." }, 400);
    const amounts = calculateOwnerTax(body.total);
    if (!amounts) return response(request, { ok: false, message: "0원 이상 999조원 이하의 금액을 입력해주세요." }, 400);
    return response(request, { ok: true, amounts });
  },
};
