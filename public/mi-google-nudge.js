/*!
 * 모먼트 인사이트 · 구글 로그인 연동 안내 팝업 (공용 컴포넌트)
 *
 * 로그인 직후 한 번만 뜬다. "구글 로그인이 아직 연결되지 않은 계정"에게만 보이고,
 * 이미 연결된 계정(대표님 mml93-a01 포함)은 서버 응답의 linked 로 자연히 걸러진다 —
 * 예외 처리를 따로 두지 않는다.
 *
 * 계약(설계 §6.1 과 같은 규칙):
 *  · 자체 fetch 를 부르지 않는다. 페이지가 주입한 miFetch 만 쓴다(CSRF 토큰·자격 헤더 계약).
 *  · 호출 대상은 apiBase + "/google-login" 하나뿐이다 — /api/my 밖으로 나가지 않는다.
 *  · 인라인 핸들러가 없다. 모든 버튼은 addEventListener 로 묶는다(CSP script-src-attr 'none').
 *  · 첫 페인트를 막지 않는다. 착지 후 프레임에서 조회하고, 조회가 실패하면 그냥 안 띄운다.
 *
 * 저장 키는 계정마다 나뉜다. 한 브라우저에서 두 계정을 번갈아 쓰면 공용 키가
 * 서로의 "나중에 하기"를 물려받기 때문이다(실장 비서 상시 대기 토글과 같은 이유).
 */
(function () {
  "use strict";

  var DISMISS_PREFIX = "mi-google-nudge-dismissed:";
  var STYLE_ID = "mi-google-nudge-style";
  var ROOT_ATTRIBUTE = "data-mi-gnudge";

  var TITLE_TEXT = "로그인 방식이 구글 계정 연동으로 바뀝니다";
  var BODY_LINE_1 = "모먼트 인사이트가 더 안전하고 간편한 구글 계정 로그인으로 전환됩니다.";
  var BODY_LINE_2 = "30일 이내에 구글 계정을 연결해 주세요 — 연결 후에는 코드 입력 없이 바로 로그인할 수 있습니다.";
  var PRIMARY_TEXT = "구글 계정 연결";
  var SECONDARY_TEXT = "나중에 하기";

  // 계정 태그는 로그인 코드 공간의 값이라 그대로 키 이름에 넣지 않는다.
  function normalizeTag(value) {
    return String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 40);
  }

  function dismissKey(role, accountTag) {
    var scope = normalizeTag(role);
    var tag = normalizeTag(accountTag);
    if (!scope || !tag) return "";
    return DISMISS_PREFIX + scope + ":" + tag;
  }

  function isDismissed(key) {
    try {
      return window.sessionStorage.getItem(key) === "1";
    } catch (error) {
      return false;
    }
  }

  function markDismissed(key) {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch (error) {}
  }

  // 개인 API 는 언제나 같은 오리진이다. 로컬 개발에서만 dev 서버 포트로 간다
  // (public/mi-personal-calendar.js 의 apiOrigin 과 같은 판정).
  function apiOrigin() {
    var host = window.location && window.location.hostname;
    if (host && host !== "127.0.0.1" && host !== "localhost") return window.location.origin;
    return "http://127.0.0.1:8790";
  }

  function styleText() {
    return [
      "[" + ROOT_ATTRIBUTE + "]{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:var(--mi-space-4,16px);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-backdrop{position:absolute;inset:0;background:rgba(6,26,58,0.55);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-card{position:relative;width:min(420px,100%);box-sizing:border-box;background:var(--mi-panel,#ffffff);color:var(--mi-ink,#111827);border:1px solid var(--mi-line,#dfe5ef);border-radius:var(--mi-radius,8px);box-shadow:var(--mi-shadow,0 16px 38px rgba(6,26,58,0.07));padding:var(--mi-space-6,24px);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-close{position:absolute;top:var(--mi-space-2,8px);right:var(--mi-space-2,8px);width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:var(--mi-radius,8px);color:var(--mi-muted,#667085);font-size:var(--mi-font-h4,15px);line-height:1;cursor:pointer;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-close:hover{background:var(--mi-grey-50,#f8fafc);color:var(--mi-ink,#111827);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-title{margin:0 var(--mi-space-5,20px) var(--mi-space-3,12px) 0;font-size:var(--mi-font-h3,18px);font-weight:var(--mi-weight-bold,700);color:var(--mi-navy,#061a3a);line-height:1.4;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-body{margin:0 0 var(--mi-space-5,20px);font-size:var(--mi-font-body-lg,13px);color:var(--mi-muted,#667085);line-height:1.7;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-status{margin:0 0 var(--mi-space-3,12px);font-size:var(--mi-font-label,11px);color:var(--mi-warn,#a75f16);line-height:1.6;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-status:empty{display:none;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-actions{display:flex;flex-direction:column;gap:var(--mi-space-2,8px);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-primary{min-height:var(--mi-button-primary-h,44px);width:100%;background:var(--mi-navy,#061a3a);color:var(--mi-panel,#ffffff);border:1px solid var(--mi-navy,#061a3a);border-radius:var(--mi-radius,8px);font-size:var(--mi-font-body-lg,13px);font-weight:var(--mi-weight-bold,700);cursor:pointer;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-primary:hover{background:var(--mi-navy-2,#0b2346);border-color:var(--mi-navy-2,#0b2346);}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-primary[disabled]{opacity:0.6;cursor:default;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-secondary{min-height:var(--mi-button-secondary-h,34px);width:100%;background:transparent;color:var(--mi-muted,#667085);border:1px solid var(--mi-line,#dfe5ef);border-radius:var(--mi-radius,8px);font-size:var(--mi-font-body,12px);cursor:pointer;}",
      "[" + ROOT_ATTRIBUTE + "] .mi-gnudge-secondary:hover{background:var(--mi-grey-50,#f8fafc);color:var(--mi-ink,#111827);}"
    ].join("\n");
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = styleText();
    document.head.appendChild(style);
  }

  // 문자열 조립 대신 노드로 만든다 — 페이지 인라인 스크립트에 마크업이 새어 나가면
  // CSP 해시가 움직이고, 텍스트 노드로 넣으면 이스케이프 걱정이 사라진다.
  function buildOverlay() {
    var overlay = document.createElement("div");
    overlay.setAttribute(ROOT_ATTRIBUTE, "");

    var backdrop = document.createElement("div");
    backdrop.className = "mi-gnudge-backdrop";
    overlay.appendChild(backdrop);

    var card = document.createElement("div");
    card.className = "mi-gnudge-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "mi-gnudge-title");
    card.setAttribute("aria-describedby", "mi-gnudge-body");

    var close = document.createElement("button");
    close.className = "mi-gnudge-close";
    close.type = "button";
    close.setAttribute("aria-label", "안내 닫기");
    close.textContent = "×";
    card.appendChild(close);

    var title = document.createElement("h2");
    title.className = "mi-gnudge-title";
    title.id = "mi-gnudge-title";
    title.textContent = TITLE_TEXT;
    card.appendChild(title);

    var body = document.createElement("p");
    body.className = "mi-gnudge-body";
    body.id = "mi-gnudge-body";
    body.appendChild(document.createTextNode(BODY_LINE_1));
    body.appendChild(document.createElement("br"));
    body.appendChild(document.createTextNode(BODY_LINE_2));
    card.appendChild(body);

    var status = document.createElement("p");
    status.className = "mi-gnudge-status";
    status.setAttribute("role", "status");
    card.appendChild(status);

    var actions = document.createElement("div");
    actions.className = "mi-gnudge-actions";

    var primary = document.createElement("button");
    primary.className = "mi-gnudge-primary";
    primary.type = "button";
    primary.textContent = PRIMARY_TEXT;
    actions.appendChild(primary);

    var secondary = document.createElement("button");
    secondary.className = "mi-gnudge-secondary";
    secondary.type = "button";
    secondary.textContent = SECONDARY_TEXT;
    actions.appendChild(secondary);

    card.appendChild(actions);
    overlay.appendChild(card);

    return { overlay: overlay, backdrop: backdrop, close: close, status: status, primary: primary, secondary: secondary };
  }

  function afterPaint() {
    return new Promise(function (resolve) {
      if (typeof window.requestAnimationFrame !== "function") {
        window.setTimeout(resolve, 0);
        return;
      }
      window.requestAnimationFrame(function () {
        window.setTimeout(resolve, 0);
      });
    });
  }

  async function readPayload(response) {
    var text = await response.text().catch(function () { return ""; });
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  }

  function render(config, key) {
    ensureStyle();
    var parts = buildOverlay();
    var previousFocus = document.activeElement;
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      markDismissed(key);
      document.removeEventListener("keydown", onKeyDown, true);
      if (parts.overlay.parentNode) parts.overlay.parentNode.removeChild(parts.overlay);
      if (previousFocus && typeof previousFocus.focus === "function") {
        try { previousFocus.focus(); } catch (error) {}
      }
    }

    // 가벼운 포커스 트랩: 카드 안 세 버튼만 순환한다.
    function focusables() {
      return [parts.close, parts.primary, parts.secondary].filter(function (node) {
        return node && !node.disabled;
      });
    }

    function onKeyDown(event) {
      if (closed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      var list = focusables();
      if (!list.length) return;
      var index = list.indexOf(document.activeElement);
      var next = event.shiftKey
        ? (index <= 0 ? list.length - 1 : index - 1)
        : (index < 0 || index === list.length - 1 ? 0 : index + 1);
      event.preventDefault();
      list[next].focus();
    }

    async function startLink() {
      if (closed || parts.primary.disabled) return;
      parts.primary.disabled = true;
      parts.status.textContent = "구글 인증 화면으로 이동을 준비하는 중입니다.";
      try {
        var response = await config.fetch(apiOrigin() + config.apiBase + "/google-login", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "link-url" })
        });
        var payload = await readPayload(response);
        if (!response.ok || !payload || payload.ok !== true || !payload.url) {
          throw new Error((payload && payload.message) || "구글 인증 주소를 만들지 못했습니다.");
        }
        window.location.href = payload.url;
      } catch (error) {
        parts.status.textContent = error.message || "구글 인증 주소를 만들지 못했습니다.";
        parts.primary.disabled = false;
      }
    }

    parts.close.addEventListener("click", close);
    parts.secondary.addEventListener("click", close);
    parts.backdrop.addEventListener("click", close);
    parts.primary.addEventListener("click", function () { startLink(); });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.appendChild(parts.overlay);
    parts.primary.focus();
    return { close: close };
  }

  // 로그인 착지 직후 페이지가 부른다. 결과를 기다리지 않아도 되도록 항상 성공한다.
  async function maybeShow(options) {
    var config = options || {};
    var doFetch = typeof config.fetch === "function" ? config.fetch : null;
    var key = dismissKey(config.role, config.accountTag);
    if (!doFetch || !key) return false;
    if (isDismissed(key)) return false;
    if (document.querySelector("[" + ROOT_ATTRIBUTE + "]")) return false;
    var apiBase = String(config.apiBase || "/api/my");
    try {
      await afterPaint();
      var response = await doFetch(apiOrigin() + apiBase + "/google-login", { method: "GET", cache: "no-store" });
      var payload = await readPayload(response);
      if (!response.ok || !payload || payload.ok !== true) return false;
      // 연결된 계정은 절대 보지 않는다. 환경변수가 아직 없으면 연결 버튼이 무의미하므로 띄우지 않는다.
      if (payload.linked === true || payload.configured !== true) return false;
      if (document.querySelector("[" + ROOT_ATTRIBUTE + "]")) return false;
      render({ fetch: doFetch, apiBase: apiBase }, key);
      return true;
    } catch (error) {
      return false;
    }
  }

  window.MomentGoogleNudge = { maybeShow: maybeShow, dismissKey: dismissKey };
})();
