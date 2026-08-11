import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { protectedJson } from "../security.mjs";

const MAX_TOTAL = 999_999_999_999_999n;
const OWNER_TOOL_PATH = "/api/owner/tool";

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
@media(max-width:760px){#mi-admin .mi-owner-development-hero{align-items:flex-start;flex-direction:column;padding:23px}#mi-admin .mi-owner-development-seal{min-width:0}#mi-admin .mi-owner-development-frame{padding:13px}#mi-admin .mi-owner-development-principles{grid-template-columns:1fr}#mi-admin .mi-owner-development-rail{align-items:flex-start;flex-direction:column}#mi-admin .mi-owner-development .mi-rank-worker-operations{padding:15px}}
@media(max-width:520px){#mi-admin .mi-owner-development-identity{grid-template-columns:44px minmax(0,1fr);gap:12px}#mi-admin .mi-owner-development-symbol{width:44px;height:44px;border-radius:13px;font-size:14px}#mi-admin .mi-owner-development-copy h1{font-size:22px}#mi-admin .mi-owner-development-copy p{font-size:11.5px}#mi-admin .mi-owner-development .mi-rank-worker-metrics,#mi-admin .mi-owner-development .mi-rank-worker-section.is-safety .mi-rank-worker-metrics{grid-template-columns:1fr}#mi-admin .mi-owner-development .mi-rank-worker-actions .mi-button{width:100%;margin-right:0}}
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

const viewHtml = String.raw`<div class="mi-owner-tool-views" data-owner-tool-views>
  ${developmentViewHtml}
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
          styleText: toolCss + developmentCss,
        },
      });
    }
    if (request.method !== "POST") return response(request, { ok: false, message: "Method not allowed" }, 405);
    if (String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return response(request, { ok: false, message: "JSON 요청만 허용됩니다." }, 415);
    }
    const body = await request.json().catch(() => null);
    if (!body || body.action !== "calculate") return response(request, { ok: false, message: "계산 요청을 확인해주세요." }, 400);
    const amounts = calculateOwnerTax(body.total);
    if (!amounts) return response(request, { ok: false, message: "0원 이상 999조원 이하의 금액을 입력해주세요." }, 400);
    return response(request, { ok: true, amounts });
  },
};
