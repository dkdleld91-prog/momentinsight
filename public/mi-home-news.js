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
  // 실제 운영 집계 띠: 추적 그룹·수집 시각은 공개 상태 API, 기사 수는 뉴스 응답에서. 고객명·키워드는 나가지 않는다.
  function renderStats(news) {
    var box = document.querySelector("[data-hp-live-stats]");
    if (!box) return;
    var two = function (value) { return String(value).replace(/^(\d)$/, "0$1"); };
    var set = function (key, value) {
      var node = box.querySelector('[data-hp-stat="' + key + '"]');
      if (node) node.textContent = value;
    };
    var naver = news && news.naver && news.naver.ok !== false ? Number(news.naver.count7d || 0) : null;
    var coupang = news && news.coupang && news.coupang.ok !== false ? Number(news.coupang.count7d || 0) : null;
    set("news", naver === null && coupang === null ? "확인 필요" : "네이버 " + (naver || 0) + "건 · 쿠팡 " + (coupang || 0) + "건");
    fetch("/api/rank-collection-health", { credentials: "omit", cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (health) {
        if (!health || !health.trackers) { set("groups", "확인 필요"); set("collect", "확인 필요"); return; }
        set("groups", Number(health.trackers.activeProductKeywordGroups || 0) + "개 · 상품 " + Number(health.trackers.activeProduct || 0) + "개");
        var last = health.lanes && health.lanes.product && health.lanes.product.lastSuccessAt ? new Date(health.lanes.product.lastSuccessAt) : null;
        var clock = last && isFinite(last.getTime()) ? two(last.getHours()) + ":" + two(last.getMinutes()) : "";
        set("collect", (clock ? "마지막 성공 " + clock + " · " : "") + "하루 2회 09:00 · 15:00");
      })
      .catch(function () { set("groups", "확인 필요"); set("collect", "확인 필요"); });
  }
  function fail() {
    renderBrand("naver", null);
    renderBrand("coupang", null);
    renderStats(null);
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
      renderStats(news);
      text(updated, news.updatedAt ? minutesAgo(news.updatedAt) : "갱신 시각 확인 중");
    })
    .catch(fail);
})();