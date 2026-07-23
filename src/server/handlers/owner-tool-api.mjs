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

const menuHtml = '<a href="#mi-admin-owner-utility" data-mi-admin-screen="owner-utility">부가세 계산기</a>';
const viewHtml = String.raw`<section class="mi-view" data-mi-admin-view="owner-utility" id="mi-admin-owner-utility" aria-label="총관리자 전용 부가세 계산기">
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
          screen: "owner-utility",
          menuHtml,
          viewHtml,
          styleText: toolCss,
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
