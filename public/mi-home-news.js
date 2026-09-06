// 공개 홈페이지 뉴스 패널(2026-09-06). /api/public/market-news 는 세션 없이 플랫폼 뉴스만 돌려준다.
(function () {
  var panel = document.querySelector("[data-hp-news-panel]");
  if (!panel || typeof window.fetch !== "function") return;
  var updated = panel.querySelector("[data-hp-news-updated]");

  function text(node, value) { if (node) node.textContent = value; }
  function dateLabel(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return "";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function minutesAgo(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return "방금 갱신";
    var min = Math.round(ms / 60000);
    return min < 1 ? "방금 갱신" : min < 60 ? min + "분 전 갱신" : Math.round(min / 60) + "시간 전 갱신";
  }
  function article(item, lead) {
    var a = document.createElement("a");
    a.className = "mi-hp-item" + (lead ? " is-lead" : "");
    a.href = item.link || "#";
    a.target = "_blank";
    a.rel = "noopener nofollow";
    var title = document.createElement("p");
    title.className = "mi-hp-title";
    title.textContent = item.title || "";
    var meta = document.createElement("div");
    meta.className = "mi-hp-meta";
    meta.textContent = [item.source, dateLabel(item.publishedAt)].filter(Boolean).join(" · ");
    a.appendChild(title);
    a.appendChild(meta);
    return a;
  }
  function renderBrand(key, section) {
    var list = panel.querySelector('[data-hp-news="' + key + '"]');
    var count = panel.querySelector('[data-hp-news-count="' + key + '"]');
    if (!list) return;
    list.textContent = "";
    if (!section || section.ok === false) {
      var fail = document.createElement("p");
      fail.className = "mi-hp-empty";
      fail.textContent = "기사를 불러오지 못했습니다. 잠시 후 다시 확인합니다.";
      list.appendChild(fail);
      text(count, "확인 필요");
      return;
    }
    var items = [];
    if (section.lead) items.push({ item: section.lead, lead: true });
    (section.items || []).slice(0, 2).forEach(function (item) { items.push({ item: item, lead: false }); });
    if (!items.length) {
      var empty = document.createElement("p");
      empty.className = "mi-hp-empty";
      empty.textContent = "이번 주 셀러 관련 기사가 없습니다.";
      list.appendChild(empty);
    } else {
      items.forEach(function (entry) { list.appendChild(article(entry.item, entry.lead)); });
    }
    text(count, "7일 " + Number(section.count7d || 0) + "건");
  }
  function fail() {
    renderBrand("naver", null);
    renderBrand("coupang", null);
    text(updated, "잠시 후 다시 확인");
  }
  fetch("/api/public/market-news", { credentials: "omit", cache: "no-store" })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (payload) {
      var news = payload && payload.ok && payload.news ? payload.news : null;
      if (!news) return fail();
      renderBrand("naver", news.naver);
      renderBrand("coupang", news.coupang);
      text(updated, news.updatedAt ? minutesAgo(news.updatedAt) : "갱신 시각 확인 중");
    })
    .catch(fail);
})();
