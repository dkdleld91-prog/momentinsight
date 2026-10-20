// 연관어 탐색 전용 상태. 기존 키워드 분석·순위 수집 상태는 읽거나 변경하지 않는다.
(function () {
  "use strict";
  var MAX_ROWS = 50;
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
  var SORT_FIELDS = {
    name: { label: "키워드" },
    volume: { label: "통합 월 검색량", value: "volume" },
    pc: { label: "PC", value: "pcVolume" },
    mobile: { label: "모바일", value: "mobileVolume" },
    clicks: { label: "광고 평균 클릭", value: "clicks" },
    ctr: { label: "광고 클릭률", value: "ctr" }
  };
  function validSort(field) { return Object.prototype.hasOwnProperty.call(SORT_FIELDS, field); }
  function defaultSortDirection(field) { return field === "name" ? "asc" : "desc"; }
  function sortRows(rows, field, direction) {
    field = validSort(field) ? field : "volume";
    var multiplier = direction === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      if (field === "name") return a.keyword.localeCompare(b.keyword, "ko") * multiplier;
      var valueField = SORT_FIELDS[field].value;
      var left = /^</.test(text(a[valueField + "Label"])) ? null : number(a[valueField]);
      var right = /^</.test(text(b[valueField + "Label"])) ? null : number(b[valueField]);
      // Unavailable and suppressed values stay last in either direction; zero is a real value.
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return (left - right) * multiplier;
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
  function workbookData(rows, meta) {
    meta = meta || {};
    function metric(value, label) {
      var shown = text(label);
      var exact = number(value);
      if (shown && (!/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(shown) || Number(shown.replace(/,/g, "")) !== exact)) return shown;
      return exact === null ? shown || "확인 필요" : exact;
    }
    return {
      keyword: text(meta.keyword), queriedAt: text(meta.queriedAt), exportedAt: text(meta.exportedAt),
      competition: text(meta.competition), sortLabel: text(meta.sortLabel),
      mainRows: rows.map(function (row, index) {
        return [index + 1, row.keyword, metric(row.volume, row.volumeLabel), metric(row.pcVolume, row.pcVolumeLabel), metric(row.mobileVolume, row.mobileVolumeLabel), row.competition || "확인 필요", metric(row.clicks), number(row.ctr) === null ? "확인 필요" : number(row.ctr) / 100];
      })
    };
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
    var competition = host.querySelector("[data-related-query-competition]");
    var sort = host.querySelector("[data-related-query-sort]");
    var exportButton = host.querySelector("[data-related-query-export]");
    if (!form || !input || !button || !body || !status || !competition || !sort || !exportButton) return null;
    var rows = [];
    var requestId = 0;
    var session = options.sessionKey();
    var activeRequest = null;
    var copyRequestId = 0;
    var sortDirection = defaultSortDirection(sort.value);
    var queryMeta = null;
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
      if (reset) competition.value = "";
      var values = [];
      rows.forEach(function (row) { if (row.competition && values.indexOf(row.competition) < 0) values.push(row.competition); });
      choices(competition, values, "전체");
    }
    function visibleRows() {
      var list = rows.filter(function (row) { return !competition.value || row.competition === competition.value; });
      return sortRows(list, sort.value, sortDirection);
    }
    function updateSortHeaders() {
      host.querySelectorAll("[data-related-query-sort-key]").forEach(function (control) {
        var field = control.getAttribute("data-related-query-sort-key");
        if (!validSort(field)) return;
        var active = field === sort.value;
        var nextDirection = active ? sortDirection === "asc" ? "desc" : "asc" : defaultSortDirection(field);
        var header = control.closest("th");
        var arrow = control.querySelector("[data-related-query-sort-arrow]");
        if (header) header.setAttribute("aria-sort", active ? sortDirection === "asc" ? "ascending" : "descending" : "none");
        if (arrow) arrow.textContent = active ? sortDirection === "asc" ? "↑" : "↓" : "↕";
        control.setAttribute("aria-label", SORT_FIELDS[field].label + ", 현재 " + (active ? sortDirection === "asc" ? "오름차순" : "내림차순" : "정렬 안 함") + ", 클릭하면 " + (nextDirection === "asc" ? "오름차순" : "내림차순") + " 정렬");
      });
    }
    function categoryCell(category) {
      var node = element("div", undefined, "mi-rq-category");
      var stored = isStoredCategory(category);
      if (category.status === "single") {
        node.appendChild(element("span", category.middle + " > " + category.small));
      }
      else if (category.status === "multiple") {
        var multipleBadge = element("span", "복수 카테고리 · " + category.paths.length + "개", "mi-rq-badge is-multiple");
        if (incomplete(category)) multipleBadge.title = "일부 분류 확인 필요";
        node.appendChild(multipleBadge);
        var details = element("details");
        details.appendChild(element("summary", "카테고리 모두 보기"));
        if (incomplete(category)) details.appendChild(element("p", "일부 분류 확인 필요", "mi-rq-reason"));
        var list = element("ul");
        category.paths.forEach(function (path) { list.appendChild(element("li", path.middle + " > " + path.small)); });
        details.appendChild(list);
        node.appendChild(details);
      } else {
        var unconfirmedDetails = element("details");
        var unconfirmedBadge = element("summary", "확인 필요", "mi-rq-badge is-unconfirmed");
        var disconnected = /not_configured|source_unavailable|source_not_configured|source_retired|provider_not_configured|unsupported/.test(category.reason);
        unconfirmedBadge.title = stored ? categoryReasonLabel(category) : disconnected ? "카테고리 데이터 연결 필요" : "분류 데이터를 확인하지 못했습니다";
        unconfirmedDetails.appendChild(unconfirmedBadge);
        unconfirmedDetails.appendChild(element("p", unconfirmedBadge.title, "mi-rq-reason"));
        node.appendChild(unconfirmedDetails);
        if (category.paths.length) {
          var reference = element("details");
          reference.appendChild(element("summary", "확인된 참고 경로 보기"));
          var referencePaths = element("ul");
          category.paths.forEach(function (path) { referencePaths.appendChild(element("li", path.middle + " > " + path.small)); });
          reference.appendChild(referencePaths);
          node.appendChild(reference);
        }
      }
      return node;
    }
    function render(emptyMessage) {
      var list = visibleRows();
      updateSortHeaders();
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
        [entry.volumeLabel || display(entry.volume), entry.pcVolumeLabel || display(entry.pcVolume), entry.mobileVolumeLabel || display(entry.mobileVolume), entry.competition || "확인 필요", display(entry.clicks, "회"), display(entry.ctr, "%")].forEach(function (value) { row.appendChild(element("td", value)); });
        var actionCell = element("td");
        var actions = element("div", undefined, "mi-rq-actions");
        [["copy", "복사"], ["analyze", "상세 분석 →"]].forEach(function (action) {
          var control = element("button", action[1]);
          control.type = "button";
          control.value = entry.keyword;
          control.setAttribute("data-related-query-" + action[0], "");
          control.setAttribute("aria-label", entry.keyword + " " + action[1].replace(" →", ""));
          actions.appendChild(control);
        });
        actionCell.appendChild(actions);
        row.appendChild(actionCell);
        body.appendChild(row);
      });
      if (count) count.textContent = "전체 " + rows.length + "개 · 표시 " + list.length + "개 · 최대 " + MAX_ROWS + "개";
      exportButton.disabled = !list.length;
    }
    function reset(message) {
      requestId += 1;
      if (activeRequest) activeRequest.abort();
      activeRequest = null;
      copyRequestId += 1;
      if (typeof options.onReset === "function") options.onReset();
      rows = [];
      queryMeta = null;
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
      queryMeta = null;
      refreshFilters(true);
      render("연관 키워드를 조회하고 있습니다.");
      button.disabled = true;
      if (title) title.textContent = keyword + " 연관 키워드";
      announce("연관 키워드의 검색량과 광고 지표를 조회 중입니다.");
      function current() { return id === requestId && options.sessionKey() === currentSession; }
      try {
        var base = options.apiUrl || "/api/client/keyword-research";
        var result = await Promise.race([options.fetch(base + "?mode=related&keyword=" + encodeURIComponent(keyword), { method: "GET", cache: "no-store", signal: controller ? controller.signal : undefined }).then(async function (response) {
          return { response: response, payload: await response.json() };
        }), timeout]);
        var response = result.response;
        var payload = result.payload;
        if (!current()) { syncSession(); return; }
        if (!response.ok || !payload || payload.ok !== true || key(payload.keyword) !== key(keyword) || !Array.isArray(payload.related)) {
          var failure = new Error("related_unavailable");
          failure.status = response.status;
          throw failure;
        }
        rows = normalizeRows(payload.related, keyword);
        queryMeta = { keyword: text(payload.keyword), queriedAt: text(payload.checkedAt) };
        refreshFilters(true);
        render(rows.length ? undefined : "제공된 연관 키워드가 없습니다.");
        announce(rows.length ? rows.length + "개 조회 · 키워드별 복사 또는 상세 분석을 선택하세요." : "이 키워드에 제공된 연관어가 없습니다. 다른 키워드로 조회해주세요.");
      } catch (error) {
        if (!current()) { syncSession(); return; }
        rows = [];
        queryMeta = null;
        refreshFilters(true);
        render("조회 결과를 불러오지 못했습니다. 다시 조회해주세요.");
        var message = error && (error.name === "AbortError" || error.message === "related_timeout") ? "조회 시간이 초과되었습니다. 잠시 후 다시 조회해주세요." : "연관 키워드를 불러오지 못했습니다. 잠시 후 다시 조회해주세요.";
        if (typeof options.errorMessage === "function") {
          var customMessage = options.errorMessage(error);
          if (typeof customMessage === "string" && customMessage.trim()) message = customMessage;
        }
        announce(message, true);
      } finally {
        window.clearTimeout(timer);
        if (current()) { button.disabled = false; activeRequest = null; }
      }
    }
    function submit(event) { event.preventDefault(); search(); }
    function filter() { if (!syncSession()) return; refreshFilters(false); render(); }
    function setSort(field) {
      if (!syncSession() || !validSort(field)) return false;
      sortDirection = field === sort.value ? sortDirection === "asc" ? "desc" : "asc" : defaultSortDirection(field);
      sort.value = field;
      render();
      return true;
    }
    function selectedRow(keyword) {
      return visibleRows().find(function (row) { return row.keyword === keyword; });
    }
    async function copyKeyword(keyword) {
      if (!syncSession()) return false;
      var entry = selectedRow(keyword);
      if (!entry) return false;
      var currentSession = session;
      var currentRequest = requestId;
      var id = ++copyRequestId;
      var timer;
      function current() { return options.sessionKey() === currentSession && requestId === currentRequest && copyRequestId === id; }
      try {
        if (typeof options.copy !== "function") throw new Error("clipboard_unavailable");
        var operation = options.copy(entry.keyword);
        await Promise.race([Promise.resolve(operation), new Promise(function (resolve, reject) { timer = window.setTimeout(function () { reject(new Error("clipboard_timeout")); }, 2000); })]);
        if (!current()) return false;
        announce(entry.keyword + " 키워드를 복사했습니다.");
        return true;
      } catch (error) {
        if (current()) announce("복사 완료를 확인하지 못했습니다. 키워드를 직접 선택해 복사해주세요.", true);
        return false;
      } finally { if (timer !== undefined) window.clearTimeout(timer); }
    }
    function analyzeKeyword(keyword) {
      if (!syncSession()) return false;
      var entry = selectedRow(keyword);
      if (!entry) return false;
      try {
        if (typeof options.analyze !== "function" || options.analyze(entry.keyword, entry.category) !== true) throw new Error("keyword_view_unavailable");
        return true;
      } catch (error) {
        announce("상세 분석 화면으로 이동하지 못했습니다. 기존 키워드 조회 메뉴에서 직접 입력해주세요.", true);
        return false;
      }
    }
    function exportXlsx() {
      if (!syncSession()) return false;
      var list = visibleRows();
      if (!list.length || !queryMeta) return false;
      var url;
      var link;
      try {
        var writer = window.MomentRelatedKeywordXlsx;
        if (!writer || typeof writer.create !== "function") throw new Error("xlsx_unavailable");
        var at = new Date();
        var data = workbookData(list, {
          keyword: queryMeta.keyword, queriedAt: queryMeta.queriedAt, exportedAt: at.toISOString(), competition: competition.value,
          sortLabel: SORT_FIELDS[sort.value].label + " " + (sortDirection === "asc" ? "오름차순" : "내림차순")
        });
        var bytes = writer.create(data);
        if (!bytes || bytes.byteLength < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error("xlsx_invalid");
        var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        url = URL.createObjectURL(blob);
        link = element("a");
        link.href = url;
        var filenameKeyword = queryMeta.keyword.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60);
        link.download = "모먼트인사이트_연관키워드_" + filenameKeyword + "_" + new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) + ".xlsx";
        doc.body.appendChild(link);
        link.click();
        announce("현재 표시된 " + list.length + "개 키워드의 엑셀 다운로드를 요청했습니다.");
        return true;
      } catch (error) {
        announce("엑셀 파일을 만들지 못했습니다. 잠시 후 다시 시도해주세요.", true);
        return false;
      } finally {
        if (link) link.remove();
        if (url) window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }
    }
    form.addEventListener("submit", submit);
    competition.addEventListener("change", filter);
    sort.addEventListener("change", function () {
      sortDirection = defaultSortDirection(sort.value);
      filter();
    });
    host.addEventListener("click", function (event) {
      var control = event.target && event.target.closest && event.target.closest("[data-related-query-sort-key]");
      if (!control || !host.contains(control)) return;
      event.preventDefault();
      setSort(control.getAttribute("data-related-query-sort-key"));
    });
    body.addEventListener("click", function (event) {
      var control = event.target && event.target.closest && event.target.closest("[data-related-query-copy], [data-related-query-analyze]");
      if (!control || !body.contains(control)) return;
      event.preventDefault();
      if (control.hasAttribute("data-related-query-copy")) copyKeyword(control.value);
      else analyzeKeyword(control.value);
    });
    exportButton.addEventListener("click", exportXlsx);
    reset();
    return { search: search, syncSession: syncSession, reset: reset, copyKeyword: copyKeyword, analyzeKeyword: analyzeKeyword, setSort: setSort, exportXlsx: exportXlsx };
  }
  function navigateKeyword(root, keyword, category) {
    var admin = root.id === "mi-admin";
    var input = root.querySelector(admin ? "[data-admin-keyword-input]" : "[data-mi-keyword-input]");
    var link = root.querySelector(admin ? 'a[data-mi-admin-screen="keyword"]' : 'a[data-mi-screen="keyword-tool"]');
    var view = root.querySelector(admin ? "#mi-admin-keyword" : "#mi-keyword-tool");
    var handoff = root.querySelector("[data-related-query-handoff]");
    if (!input || !link || !view || !handoff) return false;
    var previous = input.value;
    input.value = keyword;
    // Do not dispatch input/change: the old app also syncs those events to rank/SEO registration forms.
    try { link.click(); } catch (error) { input.value = previous; throw error; }
    if (!view.classList.contains("is-active")) { input.value = previous; return false; }
    handoff.replaceChildren();
    var label = root.ownerDocument.createElement("strong");
    label.textContent = "연관 키워드에서 선택 · " + keyword;
    var notice = root.ownerDocument.createElement("p");
    notice.textContent = "아직 이 키워드를 조회하지 않았습니다. 아래에는 이전 조회 결과가 남아 있을 수 있습니다. 조회 버튼을 눌러 확인해주세요.";
    handoff.appendChild(label);
    handoff.appendChild(notice);
    if (category.status !== "needs_confirmation" && category.paths.length) {
      var detail = root.ownerDocument.createElement("details");
      var summary = root.ownerDocument.createElement("summary");
      summary.textContent = "저장된 카테고리 참고";
      detail.appendChild(summary);
      var paths = root.ownerDocument.createElement("p");
      paths.textContent = category.paths.map(function (path) { return path.middle + " > " + path.small; }).join(" · ");
      detail.appendChild(paths);
      var evidence = root.ownerDocument.createElement("p");
      evidence.textContent = categoryBasis(category) + " · " + (incomplete(category) ? "일부 분류 확인 필요" : categoryLabel(category)) + " · " + checkedAtLabel(category.checkedAt);
      detail.appendChild(evidence);
      handoff.appendChild(detail);
    }
    handoff.hidden = false;
    input.focus();
    return true;
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
      sessionKey: sessionKey,
      copy: function (keyword) {
        if (!window.navigator || !window.navigator.clipboard || typeof window.navigator.clipboard.writeText !== "function") return Promise.reject(new Error("clipboard_unavailable"));
        return window.navigator.clipboard.writeText(keyword);
      },
      analyze: function (keyword, category) { return navigateKeyword(root, keyword, category); },
      onReset: function () {
        var handoff = root.querySelector("[data-related-query-handoff]");
        if (handoff) { handoff.hidden = true; handoff.replaceChildren(); }
      }
    });
    if (!controller) return;
    host.setAttribute("data-related-query-mounted", "true");
    function clearHandoff() { var node = root.querySelector("[data-related-query-handoff]"); if (node) { node.hidden = true; node.replaceChildren(); } }
    root.addEventListener("input", function (event) {
      if (event.target && event.target.matches && event.target.matches("[data-admin-keyword-input], [data-mi-keyword-input]")) clearHandoff();
    });
    root.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest("[data-admin-keyword-search], [data-mi-keyword-search]")) clearHandoff();
    });
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
  window.MomentRelatedKeywords = { mount: mount, normalizeRows: normalizeRows, filterRows: filterRows, sortRows: sortRows, csvText: csvText, workbookData: workbookData, createVerifiedFetch: createVerifiedFetch, navigateKeyword: navigateKeyword };
  if (window.document) {
    if (window.document.readyState === "loading") window.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    else bootstrap();
  }
})();
