// Public related-query entry only. Never reads sessions, private keywords, or rank data.
(function () {
  "use strict";
  var PUBLIC_PATH = "/api/public/related-keywords";
  function createPublicFetch(fetcher, origin) {
    return function (url, options) {
      var target;
      try { target = new URL(url, origin); } catch (_) { return Promise.reject(new Error("public_related_path_invalid")); }
      if (target.origin !== origin || target.pathname !== PUBLIC_PATH || target.username || target.password
        || target.hash || options && options.method && options.method !== "GET") return Promise.reject(new Error("public_related_path_invalid"));
      return fetcher(target.pathname + target.search, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal: options && options.signal });
    };
  }
  function errorMessage(error) {
    return error && error.status === 429 ? "비로그인 조회 한도 또는 전체 요청량 제한에 도달했습니다. 잠시 후 다시 조회해주세요. IP별 1분 5회·1시간 30회까지 이용할 수 있습니다." : "";
  }
  function bootstrap() {
    var doc = window.document;
    var root = doc && doc.getElementById("mi-public-related");
    var host = root && root.querySelector("[data-related-query]");
    if (!host || root.getAttribute("data-public-related-mounted") === "true") return null;
    var api = window.MomentRelatedKeywords;
    var status = host.querySelector("[data-related-query-status]");
    if (!api || typeof api.mount !== "function" || typeof window.fetch !== "function") {
      if (status) status.textContent = "조회 도구를 불러오지 못했습니다. 페이지를 새로고침해주세요.";
      return null;
    }
    var notice = root.querySelector("[data-public-related-login]");
    var selection = root.querySelector("[data-public-related-selection]");
    var login = root.querySelector("[data-public-related-cta]");
    function clearSelection() { if (notice) notice.hidden = true; if (selection) selection.textContent = ""; }
    var controller = api.mount(host, {
      apiUrl: PUBLIC_PATH,
      sessionKey: function () { return "public-related"; },
      fetch: createPublicFetch(function (url, options) { return window.fetch(url, options); }, window.location.origin),
      errorMessage: errorMessage,
      copy: function (keyword) {
        var clipboard = window.navigator && window.navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== "function") return Promise.reject(new Error("clipboard_unavailable"));
        return clipboard.writeText(keyword);
      },
      analyze: function (keyword) {
        if (!notice || !selection || !login) return false;
        selection.textContent = "선택 키워드 · " + keyword;
        notice.hidden = false;
        login.focus();
        return true;
      },
      onReset: clearSelection
    });
    if (!controller) return null;
    var form = host.querySelector("[data-related-query-form]");
    if (form) form.addEventListener("submit", clearSelection);
    root.setAttribute("data-public-related-mounted", "true");
    return controller;
  }
  window.MomentPublicRelatedKeywords = Object.freeze({ createPublicFetch: createPublicFetch, errorMessage: errorMessage, bootstrap: bootstrap });
  if (window.document) {
    if (window.document.readyState === "loading") window.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    else bootstrap();
  }
})();
