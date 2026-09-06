// 방문 통계(2026-09-06 피드백 홈 5): 구글 애널리틱스 GA4. 공개 페이지(홈·/news)에만 붙는다. 로그인 안쪽에는 넣지 않는다.
// 세는 것 = 페이지 조회 + 클릭 3종(도입 문의 · 뉴스 기사 · 광고주 로그인). 개인 식별 정보는 보내지 않는다.
(function () {
  var MEASUREMENT_ID = "G-J4TPHH3BZE";
  if (!MEASUREMENT_ID || typeof document === "undefined") return;
  var host = window.location && window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID, { anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false });

  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(script);

  function place(node) {
    if (node.closest("[data-hp-news-panel]")) return "hero_panel";
    if (node.closest("[data-hp-ticker]")) return "ticker";
    if (node.closest("[data-hp-live-stats]")) return "stats_bar";
    if (node.closest("#mi-home-start")) return "cta";
    if (node.closest("footer, .mi-footer")) return "footer";
    if (node.closest(".mi-hero")) return "hero";
    if (node.closest("#news")) return "news_page";
    return "other";
  }
  function platformOf(node) {
    if (node.closest(".is-coupang, [data-hp-news=\"coupang\"]")) return "coupang";
    if (node.closest(".is-naver, [data-hp-news=\"naver\"]")) return "naver";
    var brand = node.querySelector("b");
    if (brand && /쿠팡/.test(brand.textContent || "")) return "coupang";
    if (brand && /네이버/.test(brand.textContent || "")) return "naver";
    return "unknown";
  }
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    var text = (link.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (/^https:\/\/pf\.kakao\.com\//.test(href)) {
      gtag("event", "inquiry_click", { place: place(link), label: text });
      return;
    }
    if (/^mailto:/.test(href)) {
      gtag("event", "inquiry_click", { place: place(link), label: "email" });
      return;
    }
    if (href === "/client" || href.indexOf("/client") === 0) {
      gtag("event", "login_click", { place: place(link), role: "client" });
      return;
    }
    if (href === "/admin" || href.indexOf("/admin") === 0) {
      gtag("event", "login_click", { place: place(link), role: "team" });
      return;
    }
    var isNews = link.classList.contains("mi-hp-item") || link.classList.contains("row") || link.closest("[data-hp-ticker-track]") || link.closest("[data-news-list]");
    if (isNews) {
      gtag("event", "news_click", { place: place(link), platform: platformOf(link), title: text });
      return;
    }
    if (href === "/news" || link.classList.contains("mi-hp-foot-link")) {
      gtag("event", "news_page_open", { place: place(link) });
    }
  }, true);
})();
