// 모먼트 옵션 확인(정식판) — 화면 부분. 혼자 쓰는 파일이 아니다: build.mjs 가 core.mjs(export 를 걷어 냄) 바로 뒤에
// 이 파일을 붙여 한 함수로 묶는다. 그래서 findGroupOptions·productPageFromUrl·OPTION_CHECK_VERSION 은 core.mjs 것을 쓴다.
// - 그림자 DOM 안에서만 그린다(페이지 모양에 영향 없음). 글은 textContent 로만 넣는다.
// - 페이지에 이미 있는 데이터를 읽기만 한다. 요청을 보내거나 주소를 바꾸거나 무엇을 저장하는 코드가 없다.
// - 거절·못 찾음이면 번호 표·번호 칸·'번호 복사'를 아예 만들지 않는다(formal-plan A5·A6).
// - 번호 칸은 숨겨 두고, 클립보드 복사가 실패했을 때만 보여 직접 선택해 복사하게 한다.
const PANEL_HOST_ID = "mi-option-check-host";
const PANEL_TITLE = "모먼트 옵션 확인";
const DONE_TEXT = "복사했습니다. 인사이트 옵션 편집창에 붙여 넣고 미리 보기 하세요.";
const DIAG_DONE_TEXT = "진단을 복사했습니다. 개발 담당에게 붙여 넣어 보내 주세요.";
const MANUAL_TEXT = "자동 복사가 막혔습니다. 칸 안 글자가 선택돼 있으니 Cmd+C(윈도우는 Ctrl+C)를 눌러 주세요.";
// 만들 수 있는 요소는 이 목록뿐이다(링크·그림·스크립트·틀처럼 요청이나 이동을 부를 수 있는 요소는 없다).
// 모든 요소는 el() 로만 만든다. 시험(test/bookmarklet.test.mjs)이 같은 목록인지 확인한다.
const PANEL_TAGS = Object.freeze(["div", "style", "h1", "table", "tr", "td", "span", "textarea", "button", "details", "summary"]);

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
  .p{width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;
     background:#fff;color:#1d2433;border:1px solid #c9d2e3;border-radius:10px;box-shadow:0 12px 32px rgba(20,30,60,.22);
     font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;padding:14px 16px}
  h1{font-size:15px;margin:0 0 2px} .v{color:#6b7488;font-size:11px;margin-bottom:10px}
  .st{padding:8px 10px;border-radius:8px;font-weight:600;margin:8px 0}
  .ok{background:#e7f6ec;color:#16653a} .no{background:#fdecec;color:#9b1c1c}
  .tw{max-height:240px;overflow:auto;border:1px solid #eef1f6;border-radius:6px;margin:6px 0}
  table{width:100%;border-collapse:collapse;font-size:12px} td{border-top:1px solid #eef1f6;padding:3px 4px;vertical-align:top}
  td.n{font-variant-numeric:tabular-nums;white-space:nowrap;color:#33405a} .mk{color:#16653a;font-weight:700} .nn{color:#8a93a6}
  textarea{width:100%;box-sizing:border-box;height:72px;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid #c9d2e3;border-radius:6px;padding:6px}
  button{font:inherit;border:1px solid #2f5bd3;background:#2f5bd3;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;margin:4px 6px 0 0}
  button.s{background:#fff;color:#2f5bd3} button:focus-visible{outline:2px solid #1d2433;outline-offset:2px}
  details{margin-top:10px} summary{cursor:pointer;color:#33405a;font-weight:600} .d{font-size:11px;color:#4a5468;word-break:break-all}
  .hint{font-size:12px;color:#33405a;margin:6px 0} .msg{font-size:12px;color:#16653a;min-height:16px}
`;
shadow.appendChild(panelStyle);
const panel = el("div", "p");
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-label", PANEL_TITLE);
shadow.appendChild(panel);

function hiddenArea(value, label) {
  const area = el("textarea");
  area.readOnly = true;
  area.value = value;
  area.style.display = "none";
  area.setAttribute("aria-label", label);
  return area;
}

function copyWithFallback(text, area, message, doneText) {
  const done = () => {
    message.textContent = doneText;
  };
  const manual = () => {
    area.style.display = "block";
    area.focus();
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    message.textContent = copied ? doneText : MANUAL_TEXT;
  };
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") navigator.clipboard.writeText(text).then(done, manual);
    else manual();
  } catch {
    manual();
  }
}

function addDiagButtons(diag) {
  const diagText = JSON.stringify(diag);
  const diagArea = hiddenArea(diagText, "진단 정보");
  const diagMessage = el("div", "msg", "");
  const diagButton = el("button", "s", "진단 복사");
  diagButton.type = "button";
  diagButton.addEventListener("click", () => copyWithFallback(diagText, diagArea, diagMessage, DIAG_DONE_TEXT));
  const closeButton = el("button", "s", "닫기");
  closeButton.type = "button";
  closeButton.addEventListener("click", () => hostEl.remove());
  panel.appendChild(diagButton);
  panel.appendChild(closeButton);
  panel.appendChild(diagArea);
  panel.appendChild(diagMessage);
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

function addReasons(reasons) {
  for (const reason of reasons) panel.appendChild(el("div", "d", `· ${reason.text}`));
}

function addDiagDetails(diag, sources) {
  const details = el("details");
  details.appendChild(el("summary", "", "진단 정보"));
  const unread = [];
  if (sources.jsonScriptErrors) unread.push(`못 읽은 JSON 스크립트 ${sources.jsonScriptErrors}개`);
  if (sources.ldJsonErrors) unread.push(`못 읽은 검색용 정보(ld+json) ${sources.ldJsonErrors}개(무시)`);
  if (sources.codeScriptsSkipped) unread.push(`JSON 이 아닌 코드 스크립트 ${sources.codeScriptsSkipped}개(무시)`);
  if (diag.readErrors) unread.push(`읽기 오류 ${diag.readErrors}번`);
  const unreadText = unread.length ? ` · ${unread.join(" · ")}` : "";
  details.appendChild(el("div", "d", `데이터: 페이지 상태 ${sources.preloadedState} · JSON 스크립트 ${sources.jsonScripts}개${unreadText} · 훑은 묶음 ${diag.nodes}개`));
  if (diag.chosen) {
    const names = diag.chosen.names.source === "none" ? "못 찾음" : `${diag.chosen.names.found}개(${diag.chosen.names.source})`;
    details.appendChild(el("div", "d", `고른 목록: ${diag.chosen.path} · 칸 ${diag.chosen.length}개 · 번호 ${diag.chosen.count}개(${diag.chosen.idKey}) · 이름 ${names}`));
    if (diag.chosen.split.length) {
      details.appendChild(el("div", "d", `나뉜 조각 ${diag.chosen.split.length}개: ${diag.chosen.split.map((piece) => `${piece.path} (${piece.count}개)`).join(" / ")}`));
    }
    if (diag.chosen.parallel.length) {
      details.appendChild(el("div", "d", `나란한 번호 칸(조각 아님) ${diag.chosen.parallel.length}개: ${diag.chosen.parallel.map((piece) => `${piece.path} (${piece.count}개)`).join(" / ")}`));
    }
  }
  if (diag.pairLists.length) {
    details.appendChild(el("div", "d", `번호 짝 목록 ${diag.pairLists.length}개: ${diag.pairLists.map((list) => `${list.path} (${list.count}쌍)`).join(" / ")}`));
  }
  const candidates = diag.candidates.map((list) => `${list.path} (${list.count}개${list.hasCurrent ? ", 지금 포함" : ""}${list.excluded ? ", 추천 구역" : ""})`);
  details.appendChild(el("div", "d", `후보 목록 ${candidates.length}개: ${candidates.join(" / ") || "없음"}`));
  details.appendChild(el("div", "d", `group 키 ${diag.groupKeys.length}개: ${diag.groupKeys.map((entry) => `${entry.path}=${entry.type}`).join(" / ") || "없음"}`));
  panel.appendChild(details);
}

function renderFound(result) {
  panel.appendChild(el("div", "st ok", `그룹 옵션 ${result.items.length}개를 찾았습니다(지금 상품 포함)`));
  const table = el("table");
  for (const item of result.items) {
    const row = el("tr");
    const idCell = el("td", "n", item.id);
    if (item.current) idCell.appendChild(el("span", "mk", " ← 지금"));
    row.appendChild(idCell);
    row.appendChild(item.name ? el("td", "", item.name) : el("td", "nn", "(이름 못 찾음)"));
    table.appendChild(row);
  }
  const scroller = el("div", "tw");
  scroller.appendChild(table);
  panel.appendChild(scroller);
  const area = hiddenArea(result.copyText, "옵션 번호 목록");
  const message = el("div", "msg", "");
  const copyButton = el("button", "", "번호 복사");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyWithFallback(result.copyText, area, message, DONE_TEXT));
  panel.appendChild(copyButton);
  panel.appendChild(area);
  panel.appendChild(message);
  panel.appendChild(el("div", "hint", "인사이트 옵션 편집창에 붙여 넣고 미리 보기 하세요"));
}

function runOptionCheck() {
  const page = productPageFromUrl(location.href);
  if (!page) {
    panel.appendChild(el("div", "st no", "스마트스토어 상품 페이지에서 눌러 주세요(주소에 /products/숫자 가 있는 페이지)."));
    addDiagButtons({ v: OPTION_CHECK_VERSION, page: "not_product_page" });
    return;
  }
  const { roots, sources } = collectRoots();
  const result = findGroupOptions(roots, page.productId, { unreadableSources: sources.unreadable });
  if (result.status === "found") {
    renderFound(result);
  } else if (result.status === "refused") {
    panel.appendChild(el("div", "st no", "이 페이지는 버튼으로 다 읽지 못했습니다 — 인사이트 편집창에 손으로 입력해 주세요"));
    addReasons(result.reasons);
  } else {
    panel.appendChild(el("div", "st no", "못 찾음 — 인사이트 편집창에 손으로 입력해 주세요"));
    addReasons(result.reasons);
  }
  addDiagDetails(result.diag, sources);
  addDiagButtons({ ...result.diag, page: `${page.store}/${page.productId}`, sources });
}

panel.appendChild(el("h1", "", PANEL_TITLE));
panel.appendChild(el("div", "v", `버전 ${OPTION_CHECK_VERSION} · 네이버에 요청을 보내지 않고, 결과는 이 화면에만 보입니다`));
try {
  runOptionCheck();
} catch (error) {
  panel.appendChild(el("div", "st no", "실행 중 오류가 났습니다. '진단 복사'를 눌러 개발 담당에게 보내 주세요."));
  addDiagButtons({ v: OPTION_CHECK_VERSION, error: String((error && error.message) || error).slice(0, 120) });
}
(document.body || document.documentElement).appendChild(hostEl);
panel.scrollTop = 0;
