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
  function sectionItems(section, limit) {
    var list = [];
    if (!section || section.ok === false) return list;
    if (section.lead) list.push(section.lead);
    (section.items || []).forEach(function (item) { list.push(item); });
    return list.slice(0, limit);
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
    var items = sectionItems(section, 3);
    if (!items.length) {
      var empty = document.createElement("p");
      empty.className = "mi-hp-empty";
      empty.textContent = "이번 주 셀러 관련 기사가 없습니다.";
      list.appendChild(empty);
    } else {
      items.forEach(function (item, index) { list.appendChild(article(item, index === 0)); });
    }
    text(count, "7일 " + Number(section.count7d || 0) + "건");
  }
  // 히어로 아래 헤드라인 티커: 네이버·쿠팡 기사 제목을 한 줄로 흘려 보여준다(두 벌 복제해 끊김 없이 순환).
  function renderTicker(news) {
    var ticker = document.querySelector("[data-hp-ticker]");
    var track = ticker && ticker.querySelector("[data-hp-ticker-track]");
    if (!ticker || !track) return;
    var entries = [];
    sectionItems(news.naver, 6).forEach(function (item) { entries.push({ brand: "네이버", item: item }); });
    sectionItems(news.coupang, 6).forEach(function (item) { entries.push({ brand: "쿠팡", item: item }); });
    if (!entries.length) return;
    track.textContent = "";
    for (var copy = 0; copy < 2; copy += 1) {
      entries.forEach(function (entry) {
        var a = document.createElement("a");
        a.href = entry.item.link || "#";
        a.target = "_blank";
        a.rel = "noopener nofollow";
        if (copy === 1) a.setAttribute("aria-hidden", "true");
        var brand = document.createElement("b");
        brand.textContent = entry.brand;
        a.appendChild(brand);
        a.appendChild(document.createTextNode(entry.item.title || ""));
        track.appendChild(a);
      });
    }
    ticker.hidden = false;
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
      renderTicker(news);
      text(updated, news.updatedAt ? minutesAgo(news.updatedAt) : "갱신 시각 확인 중");
    })
    .catch(fail);
})();