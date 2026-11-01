// 모먼트 옵션 확인(정식판) — 화면 부분. 혼자 쓰는 파일이 아니다: build.mjs 가 core.mjs(export 를 걷어 냄) 바로 뒤에
// 이 파일을 붙여 한 함수로 묶는다. 그래서 findGroupOptions·productPageFromUrl·isServerProductId·optionFill*·OPTION_CHECK_VERSION 은
// core.mjs 것을 쓴다.
// - 그림자 DOM 안에서만 그린다(페이지 모양에 영향 없음). 글은 textContent 로만 넣는다.
// - 페이지에 이미 있는 데이터를 읽기만 한다. 네이버에 요청을 보내거나 이 페이지 주소를 바꾸거나 무엇을 저장하는 코드가 없다.
// - 결과창은 '한 가지 다음 행동'만 둔다(advertiser-impl-spec 3절, 2.1.0). 번호 표·번호 복사·진단 복사·숨은 글 칸은 없다.
//   찾음 → '모먼트에서 확인하고 저장' · 닫기 / 확인 못 함(거절·목록 없음 모두) → '모먼트에서 직접 입력' · 닫기 / 상품 페이지 아님 → 닫기.
// - 창 열기는 주 버튼을 누를 때 한 번, 빌드가 박은 고정 인사이트 주소(OPTION_FILL_TARGET) 하나로만 새 탭을 연다.
//   번호·진단은 주소의 '#mi-optfill=' 뒤에만 싣는다(쿼리 없음, 그 탭을 여는 요청에도 실리지 않음). 저장은 인사이트에서 사람이 누른다.
// 빌드가 이 줄의 글자를 '…/admin' 또는 '…/client' 로 바꿔 끼운다(build.mjs OPTION_FILL_TARGETS). 여기서 주소를 조합하지 않는다.
const OPTION_FILL_TARGET = "__MI_OPTION_FILL_TARGET__";
const PANEL_HOST_ID = "mi-option-check-host";
const PANEL_TITLE = "모먼트 옵션 확인";
// 만들 수 있는 요소는 이 목록뿐이다(링크·그림·스크립트·틀·글 칸처럼 요청·이동을 부르거나 값을 담는 요소는 없다).
// 모든 요소는 el() 로만 만든다. 시험(test/bookmarklet.test.mjs)이 같은 목록인지 확인한다.
const PANEL_TAGS = Object.freeze(["div", "style", "h1", "button"]);

function el(tag, cls, text) {
  if (!PANEL_TAGS.includes(tag)) throw new Error(`만들 수 없는 요소입니다: ${String(tag).slice(0, 20)}`);
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const previousHost = document.getElementById(PANEL_HOST_ID);
if (previousHost) previousHost.remove();

const hostEl = el("div");
hostEl.id = PANEL_HOST_ID;
hostEl.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;";
const shadow = hostEl.attachShadow({ mode: "open" });
const panelStyle = el("style");
panelStyle.textContent = `
  .p{width:400px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;
     background:#fff;color:#1d2433;border:1px solid #c9d2e3;border-radius:10px;box-shadow:0 12px 32px rgba(20,30,60,.22);
     font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;padding:14px 16px}
  h1{font-size:15px;margin:0 0 2px} .v{color:#6b7488;font-size:11px;margin-bottom:10px}
  .st{padding:8px 10px;border-radius:8px;font-weight:600;margin:8px 0}
  .ok{background:#e7f6ec;color:#16653a} .no{background:#fdecec;color:#9b1c1c}
  .nm{font-size:12px;color:#33405a;margin:0 0 6px;word-break:break-all}
  button{font:inherit;border:1px solid #2f5bd3;background:#2f5bd3;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;margin:4px 6px 0 0}
  button.s{background:#fff;color:#2f5bd3} button:focus-visible{outline:2px solid #1d2433;outline-offset:2px}
`;
shadow.appendChild(panelStyle);
const panel = el("div", "p");
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-label", PANEL_TITLE);
shadow.appendChild(panel);
panel.appendChild(el("h1", "", PANEL_TITLE));
panel.appendChild(el("div", "v", `버전 ${OPTION_CHECK_VERSION} · 네이버에 요청을 보내지 않습니다`));
// 상태 글과 버튼은 이 칸에만 그린다(실행 중 오류가 나면 비우고 다시 그림).
const content = el("div");
panel.appendChild(content);

// 주 버튼(있으면)과 '닫기'. 주 버튼을 누를 때만 고정 주소 하나를 새 탭으로 연다. 이 밖의 곳에는 창 열기가 없다.
// 페이지 스크립트가 만든 가짜 누르기(합성 click)로는 열지 않는다 — 사람이 마우스·키보드로 누른 것(isTrusted)만 연다.
function addButtons(primaryLabel, payload) {
  if (primaryLabel) {
    const primary = el("button", "", primaryLabel);
    primary.type = "button";
    primary.addEventListener("click", (event) => {
      if (!event || event.isTrusted !== true) return;
      try {
        window.open(OPTION_FILL_TARGET + "#mi-optfill=" + payload, "_blank", "noopener,noreferrer");
      } catch {
        return;
      }
      hostEl.remove();
    });
    content.appendChild(primary);
  }
  const closeButton = el("button", primaryLabel ? "s" : "", "닫기");
  closeButton.type = "button";
  closeButton.addEventListener("click", () => hostEl.remove());
  content.appendChild(closeButton);
}

function renderNotProductPage() {
  content.appendChild(el("div", "st no", "스마트스토어 상품 페이지에서 눌러 주세요."));
  addButtons("", "");
}

function renderCouldNotConfirm(pageId, diag) {
  content.appendChild(el("div", "st no", "이 페이지에서 그룹상품 옵션을 자동으로 확인하지 못했습니다."));
  const payload = optionFillRefusedPayload(pageId, diag);
  addButtons(payload ? "모먼트에서 직접 입력" : "", payload);
}

function renderFound(result, payload) {
  content.appendChild(el("div", "st ok", `그룹상품 옵션 ${result.items.length}개를 찾았습니다.`));
  const currentItem = result.items.find((item) => item.current);
  if (currentItem && currentItem.name) content.appendChild(el("div", "nm", currentItem.name));
  addButtons("모먼트에서 확인하고 저장", payload);
}

// 데이터로 읽는 스크립트(H4). type 이 application/json 이거나 id 에 state·data 가 든 스크립트는 JSON 으로 읽고, 하나라도
// 못 읽으면 거절한다(못 읽은 쪽에 진짜 그룹 목록이 있을 수 있음). 페이지 상태 객체를 읽다 오류가 나도 거절한다.
// - id 가 맞아도 type 이 자바스크립트(없음·text/javascript·module 등)면 코드다: JSON 으로 읽히면 쓰고, 안 읽혀도 거절하지 않고
//   진단에만 센다(코드에 담긴 값은 원래 이 버튼이 읽는 데이터가 아님).
// - application/ld+json(검색용 정보)은 못 읽어도 거절하지 않고 진단에만 센다.
const DATA_SCRIPT_ID = /state|data/i;
const CODE_SCRIPT_TYPE = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma|j)script)$/;

function scriptKind(script) {
  const type = String(script.type || "").split(";")[0].trim().toLowerCase();
  if (type === "application/ld+json") return "ld";
  if (type === "application/json") return "json";
  if (!DATA_SCRIPT_ID.test(String(script.id || ""))) return "";
  return CODE_SCRIPT_TYPE.test(type) ? "code" : "json";
}

function collectRoots() {
  const roots = [];
  const sources = { preloadedState: "없음", jsonScripts: 0, jsonScriptErrors: 0, ldJsonErrors: 0, codeScriptsSkipped: 0, unreadable: 0 };
  try {
    const state = window.__PRELOADED_STATE__;
    if (state && typeof state === "object") {
      roots.push({ label: "STATE", value: state });
      sources.preloadedState = "있음";
    }
  } catch {
    sources.preloadedState = "읽기 실패";
    sources.unreadable += 1;
  }
  for (const script of document.querySelectorAll("script[type], script[id]")) {
    const kind = scriptKind(script);
    if (!kind) continue;
    const text = script.textContent || "";
    if (kind === "code" && !text.trim()) continue;
    let value = null;
    try {
      value = JSON.parse(text || "null");
    } catch {
      if (kind === "ld") sources.ldJsonErrors += 1;
      else if (kind === "code") sources.codeScriptsSkipped += 1;
      else {
        sources.jsonScriptErrors += 1;
        sources.unreadable += 1;
      }
      continue;
    }
    roots.push({ label: `SCRIPT${sources.jsonScripts}`, value });
    sources.jsonScripts += 1;
  }
  return { roots, sources };
}

// 실행 중 오류가 나도 지금 상품번호를 알면 '확인 못 함'(직접 입력)으로 보낸다.
let checkedPageId = "";

function runOptionCheck() {
  const page = productPageFromUrl(location.href);
  // 지금 상품번호가 서버 규칙(5~20자리) 밖이면 인사이트로 넘길 수 없으므로 상품 페이지가 아닌 것으로 본다.
  if (!page || !isServerProductId(page.productId)) {
    renderNotProductPage();
    return;
  }
  checkedPageId = page.productId;
  const { roots, sources } = collectRoots();
  const result = findGroupOptions(roots, page.productId, { unreadableSources: sources.unreadable });
  const payload = result.status === "found" ? optionFillFoundPayload(page.productId, result.items.map((item) => item.id)) : "";
  if (payload) renderFound(result, payload);
  else renderCouldNotConfirm(page.productId, optionFillDiag(result, { sources }));
}

try {
  runOptionCheck();
} catch {
  content.textContent = "";
  if (checkedPageId) renderCouldNotConfirm(checkedPageId, optionFillDiag(null, { runtimeError: true }));
  else renderNotProductPage();
}
(document.body || document.documentElement).appendChild(hostEl);
panel.scrollTop = 0;
