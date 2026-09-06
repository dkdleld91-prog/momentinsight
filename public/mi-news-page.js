// 공개 /news 페이지(2026-09-06): /api/public/market-news 의 7일치 기사를 플랫폼·주제로 걸러 보여준다. 세션 없음.
(function () {
  var list = document.querySelector("[data-news-list]");
  var meta = document.querySelector("[data-news-meta]");
  var topics = document.querySelector("[data-news-topics]");
  var filters = document.querySelector("[data-news-filters]");
  if (!list || typeof window.fetch !== "function") return;
  var state = { platform: "all", topic: "all", items: [] };

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
  function collect(news) {
    var out = [];
    ["naver", "coupang", "elevenst", "gmarket"].forEach(function (key) {
      var section = news[key];
      if (!section || section.ok === false) return;
      var items = [];
      if (Array.isArray(section.all) && section.all.length) {
        section.all.forEach(function (item) { items.push(item); });
      } else {
        if (section.lead) items.push(section.lead);
        (section.items || []).forEach(function (item) { items.push(item); });
      }
      items.forEach(function (item) { out.push({ platform: key, title: item.title || "", link: item.link || "#", source: item.source || "", publishedAt: item.publishedAt || "", topic: item.topic || "" }); });
    });
    out.sort(function (a, b) { return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(); });
    return out;
  }
  function visible() {
    return state.items.filter(function (item) {
      if (state.platform !== "all" && item.platform !== state.platform) return false;
      if (state.topic !== "all" && item.topic !== state.topic) return false;
      return true;
    });
  }
  function render() {
    var items = visible();
    list.textContent = "";
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "조건에 맞는 기사가 없습니다.";
      list.appendChild(empty);
    }
    items.forEach(function (item) {
      var a = document.createElement("a");
      a.className = "row is-" + item.platform;
      a.href = item.link;
      a.target = "_blank";
      a.rel = "noopener nofollow";
      var src = document.createElement("span");
      src.className = "src";
      var dot = document.createElement("i");
      src.appendChild(dot);
      src.appendChild(document.createTextNode({ naver: "네이버", coupang: "쿠팡", elevenst: "11번가", gmarket: "G마켓" }[item.platform] || "기타"));
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = item.title;
      var small = document.createElement("small");
      small.textContent = [item.source, item.topic].filter(Boolean).join(" · ");
      t.appendChild(small);
      var d = document.createElement("span");
      d.className = "d";
      d.textContent = dateLabel(item.publishedAt);
      a.appendChild(src);
      a.appendChild(t);
      a.appendChild(d);
      list.appendChild(a);
    });
    if (meta) meta.textContent = items.length + "건 표시 · 전체 " + state.items.length + "건" + (state.updatedAt ? " · " + minutesAgo(state.updatedAt) : "");
  }
  function renderTopics() {
    if (!topics) return;
    var counts = {};
    state.items.forEach(function (item) { if (item.topic) counts[item.topic] = (counts[item.topic] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    topics.textContent = "";
    if (!keys.length) return;
    var all = document.createElement("button");
    all.type = "button";
    all.className = "chip on";
    all.setAttribute("data-news-topic", "all");
    all.textContent = "주제 전체";
    topics.appendChild(all);
    keys.forEach(function (key) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("data-news-topic", key);
      chip.textContent = key + " " + counts[key];
      topics.appendChild(chip);
    });
  }
  function bind(container, attr, key) {
    if (!container) return;
    container.addEventListener("click", function (event) {
      var chip = event.target.closest("[" + attr + "]");
      if (!chip) return;
      state[key] = chip.getAttribute(attr) || "all";
      container.querySelectorAll("[" + attr + "]").forEach(function (node) { node.classList.toggle("on", node === chip); });
      render();
    });
  }
  bind(filters, "data-news-platform", "platform");
  bind(topics, "data-news-topic", "topic");

  function start(payload) {
    var news = payload && payload.ok && payload.news ? payload.news : null;
    if (!news || news.ok === false) throw new Error("news_unavailable");
    state.items = collect(news);
    state.updatedAt = news.updatedAt || "";
    renderTopics();
    render();
  }
  // 서버가 HTML에 넣어 준 데이터(#news-data)가 있으면 그대로 쓰고, 없을 때만 API를 부른다.
  var embedded = document.getElementById("news-data");
  if (embedded) {
    try {
      start(JSON.parse(embedded.textContent || ""));
      return;
    } catch (error) {}
  }
  fetch("/api/public/market-news", { credentials: "omit", cache: "no-store" })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (payload) { start(payload); })
    .catch(function () {
      list.innerHTML = '<div class="empty">기사를 불러오지 못했습니다. 잠시 후 다시 확인해주세요.</div>';
      if (meta) meta.textContent = "확인 필요";
    });
})();