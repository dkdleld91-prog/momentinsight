// 연관어 탐색 전용 상태. 기존 키워드 분석·순위 수집 상태는 읽거나 변경하지 않는다.
(function () {
  "use strict";
  var MAX_ROWS = 30;
  var STORED_CATEGORY_SOURCE = "stored_rank_snapshot_categories";
  var STORED_CATEGORY_BASIS = "stored_top5";
  var STORED_CATEGORY_SAMPLE_SIZE = 5;
  var STORED_CATEGORY_REASONS = {
    stored_sample_consistent: true,
    multiple_categories: true,
    incomplete_sample: true,
    no_stored_evidence: true,
    stale_source: true,
    keyword_mismatch: true,
    evidence_unproven: true,
    scope_unavailable: true,
    source_unavailable: true,
    source_timeout: true
  };
  function text(value) { return typeof value === "string" ? value.trim() : ""; }
  function key(value) { return text(value).replace(/\s+/g, "").toLowerCase(); }
  function number(value) { return value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null; }
  function isStoredCategory(category) { return category.source === STORED_CATEGORY_SOURCE; }
  function hasStoredCategoryClaim(category) { return isStoredCategory(category) || category.basis === STORED_CATEGORY_BASIS; }
  function validCheckedAt(value) { return Boolean(value) && Number.isFinite(Date.parse(value)); }
  function storedEvidenceComplete(category) {
    return category.source === STORED_CATEGORY_SOURCE && category.basis === STORED_CATEGORY_BASIS
      && category.sampleSize === STORED_CATEGORY_SAMPLE_SIZE && category.categorizedCount === STORED_CATEGORY_SAMPLE_SIZE
      && validCheckedAt(category.checkedAt);
  }
  function normalizedCategory(category) {
    category = category && typeof category === "object" ? category : {};
    var seen = Object.create(null);
    var paths = (Array.isArray(category.paths) ? category.paths : []).map(function (path) {
      return { middle: text(path && path.middle), small: text(path && path.small) };
    }).filter(function (path) {
      var id = path.middle + "\u0000" + path.small;
      if (!path.middle || !path.small || seen[id]) return false;
      seen[id] = true;
      return true;
    });
    var evidence = { reason: text(category.reason), sampleSize: number(category.sampleSize), categorizedCount: number(category.categorizedCount), checkedAt: text(category.checkedAt), source: text(category.source), basis: text(category.basis), hasMore: category.hasMore === true };
    var status = category.status;
    if (hasStoredCategoryClaim(evidence)) {
      if (!STORED_CATEGORY_REASONS[evidence.reason]) evidence.reason = "evidence_unproven";
      var complete = storedEvidenceComplete(evidence);
      if (status === "single" && evidence.reason === "stored_sample_consistent" && complete && paths.length === 1 && paths[0].middle === text(category.middle) && paths[0].small === text(category.small)) {
        return Object.assign(evidence, { status: "single", middle: paths[0].middle, small: paths[0].small, paths: paths });
      }
      if (status === "multiple" && evidence.reason === "multiple_categories" && complete && paths.length > 1) {
        return Object.assign(evidence, { status: "multiple", middle: null, small: null, paths: paths });
      }
      if (status === "multiple" && evidence.reason === "incomplete_sample"
        && evidence.source === STORED_CATEGORY_SOURCE && evidence.basis === STORED_CATEGORY_BASIS
        && evidence.sampleSize === STORED_CATEGORY_SAMPLE_SIZE
        && evidence.categorizedCount >= 2 && evidence.categorizedCount < STORED_CATEGORY_SAMPLE_SIZE
        && validCheckedAt(evidence.checkedAt) && paths.length > 1) {
        return Object.assign(evidence, { status: "multiple", middle: null, small: null, paths: paths });
      }
      if ((evidence.reason === "stored_sample_consistent" || evidence.reason === "multiple_categories") && !complete) {
        evidence.reason = evidence.sampleSize !== STORED_CATEGORY_SAMPLE_SIZE || evidence.categorizedCount !== STORED_CATEGORY_SAMPLE_SIZE ? "incomplete_sample" : "evidence_unproven";
      }
      return Object.assign(evidence, { status: "needs_confirmation", middle: null, small: null, paths: paths });
    }
    if (status === "single" && !incomplete(evidence) && paths.length === 1 && paths[0].middle === text(category.middle) && paths[0].small === text(category.small)) {
      return Object.assign(evidence, { status: "single", middle: paths[0].middle, small: paths[0].small, paths: paths });
    }
    if (status === "multiple" && paths.length > 1) return Object.assign(evidence, { status: "multiple", middle: null, small: null, paths: paths });
    return Object.assign(evidence, { status: "needs_confirmation", middle: null, small: null, paths: status === "needs_confirmation" ? paths : [] });
  }
  function normalizeRows(rows, seed) {
    var seen = Object.create(null);
    return (Array.isArray(rows) ? rows : []).filter(function (entry) {
      var id = key(entry && entry.keyword);
      if (!id || id === key(seed) || seen[id]) return false;
      seen[id] = true;
      return true;
    }).slice(0, MAX_ROWS).map(function (entry) {
      return {
        keyword: text(entry.keyword), volume: number(entry.volume), volumeLabel: text(entry.volumeLabel),
        pcVolume: number(entry.pcVolume), mobileVolume: number(entry.mobileVolume), pcVolumeLabel: text(entry.pcVolumeLabel), mobileVolumeLabel: text(entry.mobileVolumeLabel), clicks: number(entry.clicks), ctr: number(entry.ctr),
        competition: text(entry.competition), category: normalizedCategory(entry.category)
      };
    });
  }
  function filterRows(rows, middle, small, status) {
    return rows.filter(function (row) {
      if (status && row.category.status !== status) return false;
      if (!middle && !small) return true;
      return row.category.paths.some(function (path) { return (!middle || path.middle === middle) && (!small || path.small === small); });
    });
  }
  function categoryLabel(category) {
    if (isStoredCategory(category)) return category.status === "single" ? "저장 표본 내 단일 카테고리" : category.status === "multiple" ? "저장 표본 내 복수 카테고리" : "확인 필요";
    return category.status === "single" ? "표본 내 단일 카테고리" : category.status === "multiple" ? "복수 카테고리" : "확인 필요";
  }
  function categoryBasis(category) {
    if (isStoredCategory(category)) return category.basis === STORED_CATEGORY_BASIS ? "기존 순위 수집의 저장 상위 5개 상품 표본 기준" : "저장 표본 근거 확인 필요";
    return category.source === "naver_commerce_catalog_sample" ? "조회된 네이버 카탈로그 기준" : category.source === "naver_shopping_product_categories" ? "조회된 상품 표본 기준" : "확인 필요";
  }
  function categoryReasonLabel(category) {
    var labels = {
      stored_sample_consistent: "저장 표본의 카테고리 일치",
      multiple_categories: "저장 표본에서 복수 카테고리 확인",
      incomplete_sample: "저장 표본이 부족하거나 일부만 분류되어 확인 필요",
      no_stored_evidence: "저장된 순위 표본이 없어 확인 필요",
      stale_source: "저장 표본이 오래되어 확인 필요",
      keyword_mismatch: "키워드 일치 근거를 확인하지 못함",
      evidence_unproven: "저장 표본의 카테고리 근거를 확인하지 못함",
      scope_unavailable: "현재 계정 범위에서 저장 표본을 확인할 수 없음",
      source_unavailable: "저장 표본을 불러오지 못함",
      source_timeout: "저장 표본 확인 시간이 초과됨"
    };
    return labels[category.reason] || "분류 데이터를 확인하지 못했습니다";
  }
  function checkedAtLabel(value) {
    var parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return "확인 필요";
    var date = new Date(parsed + 9 * 60 * 60 * 1000);
    function pad(value) { return String(value).padStart(2, "0"); }
    return date.getUTCFullYear() + "." + pad(date.getUTCMonth() + 1) + "." + pad(date.getUTCDate()) + " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds()) + " KST";
  }
  function incomplete(category) {
    return category.reason === "incomplete_sample"
      || (category.sampleSize !== null && category.categorizedCount !== null && category.categorizedCount < category.sampleSize)
      || (hasStoredCategoryClaim(category) && !storedEvidenceComplete(category));
  }
  function csvCell(value) {
    var result = value === null || value === undefined ? "" : String(value);
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(result) || /^[\t\r\n]/.test(result)) result = "'" + result;
    return '"' + result.replace(/"/g, '""') + '"';
  }
  function csvText(rows) {
    var head = ["키워드", "중분류", "소분류", "카테고리 상태", "카테고리 경로", "카테고리 보완 상태", "분류 표본 수", "분류 확인 수", "카테고리 확인 시각", "통합 월 검색량", "PC 월 검색량", "모바일 월 검색량", "경쟁도", "광고 평균 클릭", "광고 클릭률(%)", "카테고리 기준", "추가 결과 여부"];
    var lines = rows.map(function (row) {
      var category = row.category;
      var supplement = category.status === "needs_confirmation" && isStoredCategory(category) ? categoryReasonLabel(category) : incomplete(category) ? "일부 분류 확인 필요" : "";
      var more = isStoredCategory(category) ? "추가 상품 조회 없음" : category.source === "naver_commerce_catalog_sample" ? category.hasMore ? "추가 결과 있음" : "조회 응답상 마지막 페이지" : "확인 필요";
      return [row.keyword, category.middle, category.small, categoryLabel(category), category.paths.map(function (path) { return path.middle + " > " + path.small; }).join(" | "), supplement, category.sampleSize, category.categorizedCount, category.checkedAt, row.volumeLabel || row.volume, row.pcVolumeLabel || row.pcVolume, row.mobileVolumeLabel || row.mobileVolume, row.competition, row.clicks, row.ctr, categoryBasis(category), more];
    });
    return "\ufeff" + [head].concat(lines).map(function (line) { return line.map(csvCell).join(","); }).join("\r\n");
  }
  function mount(host, options) {
    if (!host || !options || typeof options.fetch !== "function" || typeof options.sessionKey !== "function") return null;
    var doc = host.ownerDocument;
    var form = host.querySelector("[data-related-query-form]");
    var input = host.querySelector("[data-related-query-input]");
    var button = host.querySelector("[data-related-query-run]");
    var body = host.querySelector("[data-related-query-body]");
    var status = host.querySelector("[data-related-query-status]");
    var count = host.querySelector("[data-related-query-count]");
    var title = host.querySelector("[data-related-query-title]");
    var middle = host.querySelector("[data-related-query-middle]");
    var small = host.querySelector("[data-related-query-small]");
    var categoryStatus = host.querySelector("[data-related-query-category-status]");
    var sort = host.querySelector("[data-related-query-sort]");
    var exportButton = host.querySelector("[data-related-query-export]");
    if (!form || !input || !button || !body || !status || !middle || !small || !categoryStatus || !sort || !exportButton) return null;
    var rows = [];
    var requestId = 0;
    var session = options.sessionKey();
    var activeRequest = null;
    function element(tag, value, className) {
      var node = doc.createElement(tag);
      if (value !== undefined) node.textContent = value;
      if (className) node.className = className;
      return node;
    }
    function option(select, value, label) {
      var node = element("option", label);
      node.value = value;
      select.appendChild(node);
    }
    function announce(message, error) { status.textContent = message; status.classList.toggle("is-error", Boolean(error)); }
    function display(value, suffix) { return value === null ? "—" : value.toLocaleString("ko-KR") + (suffix || ""); }
    function choices(select, values, initial) {
      var prior = select.value;
      select.replaceChildren();
      option(select, "", initial);
      values.sort(function (a, b) { return a.localeCompare(b, "ko"); }).forEach(function (value) { option(select, value, value); });
      select.value = values.indexOf(prior) >= 0 ? prior : "";
      select.disabled = !values.length;
    }
    function refreshFilters(reset) {
      if (reset) { middle.value = ""; small.value = ""; categoryStatus.value = ""; }
      var mids = [];
      var smalls = [];
      rows.forEach(function (row) { row.category.paths.forEach(function (path) { if (mids.indexOf(path.middle) < 0) mids.push(path.middle); }); });
      choices(middle, mids, "중분류 전체");
      rows.forEach(function (row) { row.category.paths.forEach(function (path) { if ((!middle.value || path.middle === middle.value) && smalls.indexOf(path.small) < 0) smalls.push(path.small); }); });
      choices(small, smalls, "소분류 전체");
    }
    function visibleRows() {
      var list = filterRows(rows, middle.value, small.value, categoryStatus.value);
      if (sort.value === "name") list.sort(function (a, b) { return a.keyword.localeCompare(b.keyword, "ko"); });
      else {
        var field = sort.value === "mobile" ? "mobileVolume" : sort.value === "pc" ? "pcVolume" : "volume";
        list.sort(function (a, b) { return (b[field] === null ? -1 : b[field]) - (a[field] === null ? -1 : a[field]); });
      }
      return list;
    }
    function categoryCell(category) {
      var node = element("div", undefined, "mi-rq-category");
      var stored = isStoredCategory(category);
      if (category.status === "single") {
        node.appendChild(element("span", category.middle + " > " + category.small));
        if (stored) node.appendChild(element("small", "저장 표본 내 단일 카테고리"));
      }
      else if (category.status === "multiple") {
        node.appendChild(element("span", (stored ? "저장 표본 내 복수 카테고리 · " : "복수 카테고리 · ") + category.paths.length + "개", "mi-rq-badge is-multiple"));
        var details = element("details");
        details.appendChild(element("summary", "카테고리 모두 보기"));
        var list = element("ul");
        category.paths.forEach(function (path) { list.appendChild(element("li", path.middle + " > " + path.small)); });
        details.appendChild(list);
        node.appendChild(details);
        if (incomplete(category)) node.appendChild(element("small", "일부 분류 확인 필요"));
      } else {
        node.appendChild(element("span", "확인 필요", "mi-rq-badge is-unconfirmed"));
        var disconnected = /not_configured|source_unavailable|source_not_configured|source_retired|provider_not_configured|unsupported/.test(category.reason);
        node.appendChild(element("small", stored ? categoryReasonLabel(category) : disconnected ? "카테고리 데이터 연결 필요" : "분류 데이터를 확인하지 못했습니다"));
        if (category.paths.length) {
          var reference = element("details");
          reference.appendChild(element("summary", "확인된 참고 경로 보기"));
          var referencePaths = element("ul");
          category.paths.forEach(function (path) { referencePaths.appendChild(element("li", path.middle + " > " + path.small)); });
          reference.appendChild(referencePaths);
          node.appendChild(reference);
        }
      }
      if (stored) {
        var sample = category.sampleSize === null ? "확인 필요" : category.sampleSize + "개";
        var categorized = category.categorizedCount === null ? "확인 필요" : category.categorizedCount + "개";
        node.appendChild(element("small", "저장된 순위 표본 " + sample + " 중 " + categorized + " 분류 · 수집 " + checkedAtLabel(category.checkedAt)));
        node.appendChild(element("small", "저장 표본 기준 · 전체 분류 아님 · 추가 상품 조회 없음"));
      } else if (category.source === "naver_commerce_catalog_sample") {
        node.appendChild(element("small", categoryBasis(category) + (category.sampleSize !== null ? " · " + category.sampleSize + "개" : "")));
        if (category.hasMore) node.appendChild(element("small", "추가 결과 있음 · 전체 검색 분류가 아닙니다"));
      }
      return node;
    }
    function render(emptyMessage) {
      var list = visibleRows();
      body.replaceChildren();
      if (!list.length) {
        var emptyRow = element("tr");
        var empty = element("td", emptyMessage || (rows.length ? "선택한 조건에 맞는 연관 키워드가 없습니다." : "키워드를 조회하면 확인된 연관어가 표시됩니다."), "mi-rq-empty");
        empty.colSpan = 8;
        emptyRow.appendChild(empty);
        body.appendChild(emptyRow);
      }
      list.forEach(function (entry) {
        var row = element("tr");
        row.appendChild(element("td", entry.keyword));
        var category = element("td");
        category.appendChild(categoryCell(entry.category));
        row.appendChild(category);
        [entry.volumeLabel || display(entry.volume), entry.pcVolumeLabel || display(entry.pcVolume), entry.mobileVolumeLabel || display(entry.mobileVolume), entry.competition || "확인 필요", display(entry.clicks, "회"), display(entry.ctr, "%")].forEach(function (value) { row.appendChild(element("td", value)); });
        body.appendChild(row);
      });
      if (count) count.textContent = "전체 " + rows.length + "개 · 표시 " + list.length + "개 · 최대 30개";
      exportButton.disabled = !list.length;
    }
    function reset(message) {
      requestId += 1;
      if (activeRequest) activeRequest.abort();
      activeRequest = null;
      rows = [];
      input.value = "";
      button.disabled = false;
      if (title) title.textContent = "연관 키워드";
      refreshFilters(true);
      render();
      announce(message || "키워드를 입력하고 조회해주세요.");
    }
    function syncSession() {
      var next = options.sessionKey();
      if (next !== session) { session = next; reset(next ? "키워드를 입력하고 조회해주세요." : "로그인 후 연관 키워드를 조회할 수 있습니다."); }
      return Boolean(next);
    }
    async function search(seed) {
      syncSession();
      if (typeof seed === "string") input.value = seed;
      var keyword = text(input.value).replace(/\s+/g, " ").slice(0, 60);
      if (!session) { announce("로그인 후 연관 키워드를 조회할 수 있습니다.", true); return; }
      if (!keyword) { announce("키워드를 입력해주세요.", true); input.focus(); return; }
      var currentSession = session;
      var id = ++requestId;
      if (activeRequest) activeRequest.abort();
      var controller = typeof window.AbortController === "function" ? new window.AbortController() : null;
      activeRequest = controller;
      var timer;
      var timeout = new Promise(function (resolve, reject) {
        timer = window.setTimeout(function () {
          if (controller) controller.abort();
          reject(new Error("related_timeout"));
        }, 18000);
      });
      rows = [];
      refreshFilters(true);
      render("연관 키워드를 조회하고 있습니다.");
      button.disabled = true;
      if (title) title.textContent = keyword + " 연관 키워드";
      announce("연관 키워드와 중·소분류를 조회 중입니다.");
      function current() { return id === requestId && options.sessionKey() === currentSession; }
      try {
        var base = options.apiUrl || "/api/client/keyword-research";
        var result = await Promise.race([options.fetch(base + "?mode=related&keyword=" + encodeURIComponent(keyword), { method: "GET", cache: "no-store", signal: controller ? controller.signal : undefined }).then(async function (response) {
          return { response: response, payload: await response.json() };
        }), timeout]);
        var response = result.response;
        var payload = result.payload;
        if (!current()) { syncSession(); return; }
        if (!response.ok || !payload || payload.ok !== true || key(payload.keyword) !== key(keyword) || !Array.isArray(payload.related)) throw new Error("related_unavailable");
        rows = normalizeRows(payload.related, keyword);
        refreshFilters(true);
        render(rows.length ? undefined : "제공된 연관 키워드가 없습니다.");
        var single = rows.filter(function (row) { return row.category.status === "single"; }).length;
        var multiple = rows.filter(function (row) { return row.category.status === "multiple"; }).length;
        var storedCount = rows.filter(function (row) { return isStoredCategory(row.category); }).length;
        announce(rows.length ? rows.length + "개 조회 · 단일 카테고리 " + single + "개 · 복수 카테고리 " + multiple + "개 · 확인 필요 " + (rows.length - single - multiple) + "개" + (storedCount ? " · 저장 순위 표본 기준 " + storedCount + "개 · 추가 상품 조회 없음" : "") : "이 키워드에 제공된 연관어가 없습니다. 다른 키워드로 조회해주세요.");
      } catch (error) {
        if (!current()) { syncSession(); return; }
        rows = [];
        refreshFilters(true);
        render("조회 결과를 불러오지 못했습니다. 다시 조회해주세요.");
        announce(error && (error.name === "AbortError" || error.message === "related_timeout") ? "조회 시간이 초과되었습니다. 잠시 후 다시 조회해주세요." : "연관 키워드를 불러오지 못했습니다. 잠시 후 다시 조회해주세요.", true);
      } finally {
        window.clearTimeout(timer);
        if (current()) { button.disabled = false; activeRequest = null; }
      }
    }
    function submit(event) { event.preventDefault(); search(); }
    function filter() { if (!syncSession()) return; refreshFilters(false); render(); }
    function exportCsv() {
      if (!syncSession()) return;
      var list = visibleRows();
      if (!list.length) return;
      var blob = new Blob([csvText(list)], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var link = element("a");
      link.href = url;
      link.download = "연관키워드-" + new Date().toISOString().slice(0, 10) + ".csv";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    form.addEventListener("submit", submit);
    [middle, small, categoryStatus, sort].forEach(function (node) { node.addEventListener("change", filter); });
    exportButton.addEventListener("click", exportCsv);
    reset();
    return { search: search, syncSession: syncSession, reset: reset };
  }
  function createVerifiedFetch(fetcher, sessionUrl, sessionKey) {
    return async function (url, options) {
      var initial = sessionKey();
      if (!initial) throw new Error("related_session_required");
      function current() { if (sessionKey() !== initial) throw new Error("related_session_changed"); }
      var fetchOptions = { method: "GET", cache: "no-store", credentials: "same-origin", signal: options && options.signal };
      async function identity() {
        current();
        var response = await fetcher(sessionUrl, fetchOptions);
        var payload = await response.json();
        current();
        var session = payload && payload.session;
        if (!response.ok || !payload || payload.ok !== true || !session || ["owner", "team", "client"].indexOf(session.role) < 0 || !text(session.scopeKey)) throw new Error("related_session_required");
        // CSRF 값은 메모리에서 세션 동일성 비교에만 사용하고 화면·저장소·로그에 남기지 않는다.
        return JSON.stringify([session.role, session.scopeKey, session.clientId || "", session.teamId || "", session.csrfToken || ""]);
      }
      var before = await identity();
      current();
      var response = await fetcher(url, fetchOptions);
      var payload = await response.json();
      current();
      var after = await identity();
      current();
      if (before !== after) throw new Error("related_session_changed");
      return { ok: response.ok, status: response.status, json: function () { return Promise.resolve(payload); } };
    };
  }
  function bootstrap() {
    var doc = window.document;
    if (!doc || typeof window.fetch !== "function") return;
    var root = doc.getElementById("mi-admin") || doc.getElementById("mi-clean");
    var host = root && root.querySelector("[data-related-query]");
    if (!host || host.getAttribute("data-related-query-mounted") === "true") return;
    var epoch = 1;
    function sessionKey() { return root.classList.contains("is-authed") && !root.classList.contains("is-locked") ? String(epoch) : ""; }
    var hostname = window.location && window.location.hostname;
    var base = hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8790" : "";
    var controller = mount(host, {
      fetch: createVerifiedFetch(function (url, options) { return window.fetch(url, options); }, base + "/api/session", sessionKey),
      apiUrl: base + "/api/client/keyword-research",
      sessionKey: sessionKey
    });
    if (!controller) return;
    host.setAttribute("data-related-query-mounted", "true");
    if (typeof window.MutationObserver === "function") {
      var observer = new window.MutationObserver(function (records) {
        var now = root.classList.contains("is-authed") + ":" + root.classList.contains("is-locked");
        var changed = records.some(function (record) {
          var previous = " " + String(record.oldValue || "") + " ";
          return (previous.indexOf(" is-authed ") >= 0) + ":" + (previous.indexOf(" is-locked ") >= 0) !== now;
        });
        if (changed) { epoch += 1; controller.syncSession(); }
      });
      observer.observe(root, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    }
    root.addEventListener("click", function (event) {
      var more = event.target && event.target.closest && event.target.closest(".mi-related-more");
      if (!more || !root.contains(more)) return;
      var chip = root.querySelector("[data-keyword-market-chip]");
      var keyword = text(chip && chip.textContent);
      if (keyword && keyword.length <= 60 && ["조회 전", "조회 후 표시", "키워드 조회 전"].indexOf(keyword) < 0) controller.search(keyword);
      else {
        var input = host.querySelector("[data-related-query-input]");
        if (input) input.focus();
      }
    });
  }
  window.MomentRelatedKeywords = { mount: mount, normalizeRows: normalizeRows, filterRows: filterRows, csvText: csvText, createVerifiedFetch: createVerifiedFetch };
  if (window.document) {
    if (window.document.readyState === "loading") window.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    else bootstrap();
  }
})();
