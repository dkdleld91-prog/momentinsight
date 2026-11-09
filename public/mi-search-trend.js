// 검색어 트렌드 화면(대표 지시 2026-11-09). 네이버 데이터랩 검색어트렌드와 같은 조건으로 주제어를 겹쳐 비교한다.
// 다른 화면의 상태는 읽거나 바꾸지 않는다. 화면 글자는 전부 textContent 로만 넣는다.
(function () {
  "use strict";
  var MIN_DATE = "2016-01-01";
  var MAX_TOPICS = 5;
  var DAY = 86400000;
  var KST = 9 * 3600000;
  var API_PATH = "/api/client/keyword-research?mode=search-trend";
  var UNIT_LABEL = { date: "일간", week: "주간", month: "월간" };
  var DEVICE_LABEL = { "": "전체", mo: "모바일", pc: "PC" };
  var GENDER_LABEL = { "": "전체", f: "여성", m: "남성" };
  var AGE_OPTIONS = [["1", "~12"], ["2", "13~18"], ["3", "19~24"], ["4", "25~29"], ["5", "30~34"], ["6", "35~39"], ["7", "40~44"], ["8", "45~49"], ["9", "50~54"], ["10", "55~59"], ["11", "60~"]];
  var PERIODS = [["all", "전체"], ["1m", "1개월"], ["3m", "3개월"], ["1y", "1년"], ["custom", "직접입력"]];
  var SVG_NS = "http://www.w3.org/2000/svg";

  function text(value) { return String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim(); }
  function ms(date) { return Date.parse(date + "T00:00:00Z"); }
  function isoDate(time) { return new Date(time).toISOString().slice(0, 10); }
  function dotted(date) { return String(date).replace(/-/g, "."); }
  function series(slot) { return "var(--mi-chart-" + (slot + 1) + ")"; }
  function latestDate(nowMs) { return isoDate(nowMs + KST - DAY); }
  function presetStart(period, end) {
    if (period === "all") return MIN_DATE;
    var date = new Date(ms(end));
    var months = period === "1m" ? 1 : period === "3m" ? 3 : period === "1y" ? 12 : 0;
    if (!months) return "";
    var day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - months);
    var last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
    var start = isoDate(date.getTime());
    return start < MIN_DATE ? MIN_DATE : start;
  }
  function splitKeywords(value) {
    var seen = Object.create(null);
    return String(value === null || value === undefined ? "" : value).split(",").map(text).filter(function (keyword) {
      var id = keyword.toLowerCase();
      if (!keyword || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  // 응답 → 그래프·표·엑셀이 함께 쓰는 값. 네이버가 보내지 않은 구간은 null 로 남긴다.
  function buildModel(payload, slots) {
    var known = Object.create(null);
    var list = (payload && Array.isArray(payload.results) ? payload.results : []).map(function (result, index) {
      var points = (Array.isArray(result.data) ? result.data : []).map(function (point) {
        known[point.period] = true;
        return { period: point.period, time: ms(point.period), value: Number(point.ratio) };
      });
      var total = 0;
      var peak = null;
      points.forEach(function (point) {
        total += point.value;
        if (!peak || point.value > peak.value) peak = point;
      });
      var byPeriod = Object.create(null);
      points.forEach(function (point) { byPeriod[point.period] = point.value; });
      return {
        slot: slots && slots[index] !== undefined ? slots[index] : index,
        title: text(result.title),
        keywords: Array.isArray(result.keywords) ? result.keywords.map(text) : [],
        points: points,
        byPeriod: byPeriod,
        average: points.length ? total / points.length : null,
        peak: peak
      };
    });
    var periods = Object.keys(known).sort();
    return { series: list, periods: periods, times: periods.map(ms), conditions: payload && payload.conditions ? payload.conditions : {} };
  }

  // 네이버가 건너뛴 구간은 선을 끊는다. 집계 단위보다 간격이 크면 빠진 것으로 본다.
  function segmentsOf(points, unit) {
    var limit = unit === "date" ? 1.5 * DAY : unit === "week" ? 8 * DAY : 32 * DAY;
    var segments = [];
    var current = [];
    points.forEach(function (point) {
      if (current.length && point.time - current[current.length - 1].time > limit) {
        segments.push(current);
        current = [];
      }
      current.push(point);
    });
    if (current.length) segments.push(current);
    return segments;
  }

  // 화면 폭보다 점이 많으면 모양과 최고점을 지키며 그리는 점만 줄인다(값은 툴팁·표에 그대로 남는다).
  function thinIndices(values, target, keepIndex) {
    var count = values.length;
    var all = [];
    var index;
    if (count <= target || target < 3) {
      for (index = 0; index < count; index += 1) all.push(index);
      return all;
    }
    var picked = [0];
    var bucket = (count - 2) / (target - 2);
    var anchor = 0;
    for (var i = 0; i < target - 2; i += 1) {
      var from = Math.floor(i * bucket) + 1;
      var to = Math.min(Math.floor((i + 1) * bucket) + 1, count - 1);
      var avgFrom = to;
      var avgTo = Math.min(Math.floor((i + 2) * bucket) + 1, count);
      var size = Math.max(1, avgTo - avgFrom);
      var sumX = 0;
      var sumY = 0;
      for (var j = avgFrom; j < avgTo; j += 1) { sumX += j; sumY += values[j]; }
      sumX /= size;
      sumY /= size;
      var best = from;
      var bestArea = -1;
      for (var k = from; k < to; k += 1) {
        var area = Math.abs((anchor - sumX) * (values[k] - values[anchor]) - (anchor - k) * (sumY - values[anchor]));
        if (area > bestArea) { bestArea = area; best = k; }
      }
      picked.push(best);
      anchor = best;
    }
    picked.push(count - 1);
    if (keepIndex >= 0 && keepIndex < count && picked.indexOf(keepIndex) < 0) picked.push(keepIndex);
    return picked.sort(function (a, b) { return a - b; });
  }

  function linePath(points) {
    return "M" + points.map(function (point) { return point[0].toFixed(1) + "," + point[1].toFixed(1); }).join("L");
  }

  // 주간·월간처럼 점이 적을 때는 지점을 지나면서 넘치지 않는 곡선으로 그린다.
  function curvePath(points) {
    var n = points.length;
    if (n < 3) return linePath(points);
    var dx = [];
    var slope = [];
    var tangent = [];
    var i;
    for (i = 0; i < n - 1; i += 1) {
      dx[i] = points[i + 1][0] - points[i][0];
      slope[i] = (points[i + 1][1] - points[i][1]) / dx[i];
    }
    tangent[0] = slope[0];
    tangent[n - 1] = slope[n - 2];
    for (i = 1; i < n - 1; i += 1) {
      tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]);
    }
    var path = "M" + points[0][0].toFixed(1) + "," + points[0][1].toFixed(1);
    for (i = 0; i < n - 1; i += 1) {
      var h = dx[i] / 3;
      path += "C" + (points[i][0] + h).toFixed(1) + "," + (points[i][1] + tangent[i] * h).toFixed(1) + " " + (points[i + 1][0] - h).toFixed(1) + "," + (points[i + 1][1] - tangent[i + 1] * h).toFixed(1) + " " + points[i + 1][0].toFixed(1) + "," + points[i + 1][1].toFixed(1);
    }
    return path;
  }

  function xTicks(periods) {
    var out = [];
    if (!periods.length) return out;
    var span = (ms(periods[periods.length - 1]) - ms(periods[0])) / DAY;
    var step = Math.max(1, Math.round(periods.length / 6));
    periods.forEach(function (period, index) {
      var parts = period.split("-");
      var previous = index ? periods[index - 1].split("-") : null;
      var month = Number(parts[1]);
      if (span > 900) {
        if (previous && previous[0] !== parts[0]) out.push({ index: index, label: parts[0] + "년", major: true });
      } else if (span > 240) {
        if (previous && previous[1] !== parts[1] && (month - 1) % 2 === 0) out.push({ index: index, label: month === 1 ? parts[0] + "년 1월" : month + "월", major: month === 1 });
      } else if (span > 45) {
        if (previous && previous[1] !== parts[1]) out.push({ index: index, label: month === 1 ? parts[0] + "년 1월" : month + "월", major: false });
      } else if (index % step === 0) {
        out.push({ index: index, label: month + "." + Number(parts[2]), major: false });
      }
    });
    return out;
  }

  function nearestIndex(times, time) {
    var low = 0;
    var high = times.length - 1;
    while (high - low > 1) {
      var middle = Math.floor((low + high) / 2);
      if (times[middle] <= time) low = middle; else high = middle;
    }
    return Math.abs(times[low] - time) <= Math.abs(times[high] - time) ? low : high;
  }

  function conditionTexts(conditions) {
    var ages = Array.isArray(conditions.ages) ? conditions.ages : [];
    var ageNames = AGE_OPTIONS.filter(function (age) { return ages.indexOf(age[0]) >= 0; }).map(function (age) { return age[1]; });
    return [
      dotted(conditions.startDate) + " ~ " + dotted(conditions.endDate),
      UNIT_LABEL[conditions.timeUnit] || "",
      "범위 " + (DEVICE_LABEL[conditions.device || ""] || "전체"),
      "성별 " + (GENDER_LABEL[conditions.gender || ""] || "전체"),
      "연령 " + (ageNames.length ? ageNames.join(", ") : "전체")
    ];
  }

  // ── 엑셀 파일(외부 라이브러리 없음) ──
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }());
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  }
  function xmlText(value) {
    return String(value).replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function columnName(index) {
    var name = "";
    for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }
  function zipStore(files) {
    var encoder = new TextEncoder();
    var entries = files.map(function (file) {
      var name = encoder.encode(file[0]);
      var content = encoder.encode(file[1]);
      return { name: name, content: content, crc: crc32(content), offset: 0 };
    });
    var localSize = entries.reduce(function (sum, entry) { return sum + 30 + entry.name.length + entry.content.length; }, 0);
    var centralSize = entries.reduce(function (sum, entry) { return sum + 46 + entry.name.length; }, 0);
    var out = new Uint8Array(localSize + centralSize + 22);
    var view = new DataView(out.buffer);
    var offset = 0;
    entries.forEach(function (entry) {
      entry.offset = offset;
      view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 0x0800, true);
      view.setUint16(offset + 10, 0, true); view.setUint16(offset + 12, 0x0021, true);
      view.setUint32(offset + 14, entry.crc, true); view.setUint32(offset + 18, entry.content.length, true); view.setUint32(offset + 22, entry.content.length, true);
      view.setUint16(offset + 26, entry.name.length, true);
      out.set(entry.name, offset + 30);
      out.set(entry.content, offset + 30 + entry.name.length);
      offset += 30 + entry.name.length + entry.content.length;
    });
    entries.forEach(function (entry) {
      view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x0800, true);
      view.setUint16(offset + 12, 0, true); view.setUint16(offset + 14, 0x0021, true);
      view.setUint32(offset + 16, entry.crc, true); view.setUint32(offset + 20, entry.content.length, true); view.setUint32(offset + 24, entry.content.length, true);
      view.setUint16(offset + 28, entry.name.length, true); view.setUint32(offset + 42, entry.offset, true);
      out.set(entry.name, offset + 46);
      offset += 46 + entry.name.length;
    });
    view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, entries.length, true); view.setUint16(offset + 10, entries.length, true);
    view.setUint32(offset + 12, centralSize, true); view.setUint32(offset + 16, localSize, true);
    return out;
  }
  // 조회 조건을 위에 함께 적는다. 100의 기준이 조건마다 달라서 조건 없는 숫자는 뜻이 없다.
  function workbookRows(model) {
    var rows = [[{ text: "검색어 트렌드", bold: true }], [{ text: "조건: " + conditionTexts(model.conditions).join(", ") }], [{ text: "값은 이번 조회에서 가장 높은 지점을 100으로 놓은 상대 수치입니다. 출처: 네이버 데이터랩." }]];
    model.series.forEach(function (item) { rows.push([{ text: "주제어: " + item.title }, { text: "검색어: " + item.keywords.join(", ") }]); });
    rows.push([]);
    rows.push([{ text: "날짜", bold: true }].concat(model.series.map(function (item) { return { text: item.title, bold: true }; })));
    model.periods.forEach(function (period) {
      rows.push([{ text: dotted(period) }].concat(model.series.map(function (item) {
        var value = item.byPeriod[period];
        return value === undefined ? {} : { number: value };
      })));
    });
    return rows;
  }
  function workbookBytes(model) {
    var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    var main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    var rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    var sheetRows = workbookRows(model).map(function (cells, rowIndex) {
      var body = cells.map(function (cell, columnIndex) {
        var ref = columnName(columnIndex) + (rowIndex + 1);
        if (cell.number !== undefined) return '<c r="' + ref + '"><v>' + cell.number + "</v></c>";
        if (cell.text === undefined) return "";
        return '<c r="' + ref + '" t="inlineStr"' + (cell.bold ? ' s="1"' : "") + '><is><t xml:space="preserve">' + xmlText(cell.text) + "</t></is></c>";
      }).join("");
      return '<row r="' + (rowIndex + 1) + '">' + body + "</row>";
    }).join("");
    var cols = '<cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="' + Math.max(2, model.series.length + 1) + '" width="16" customWidth="1"/></cols>';
    return zipStore([
      ["[Content_Types].xml", head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", head + '<workbook xmlns="' + main + '" xmlns:r="' + rel + '"><sheets><sheet name="검색어 트렌드" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + rel + '/styles" Target="styles.xml"/></Relationships>'],
      ["xl/styles.xml", head + '<styleSheet xmlns="' + main + '"><fonts count="2"><font><sz val="11"/><name val="Malgun Gothic"/></font><font><b/><sz val="11"/><name val="Malgun Gothic"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
      ["xl/worksheets/sheet1.xml", head + '<worksheet xmlns="' + main + '">' + cols + "<sheetData>" + sheetRows + "</sheetData></worksheet>"]
    ]);
  }

  // ── 화면 ──
  function el(tag, className, content) {
    var node = window.document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function svgEl(parent, name, attrs, content) {
    var node = window.document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (content !== undefined) node.textContent = content;
    if (parent) parent.appendChild(node);
    return node;
  }
  function segmentGroup(label, entries, active) {
    var group = el("div", "mi-segment");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    entries.forEach(function (entry) {
      var button = el("button", entry[0] === active ? "is-active" : "", entry[1]);
      button.type = "button";
      button.setAttribute("data-value", entry[0]);
      group.appendChild(button);
    });
    return group;
  }
  function field(label, control, extraClass) {
    var wrap = el("div", "mi-trend-option" + (extraClass ? " " + extraClass : ""));
    wrap.appendChild(el("span", "mi-trend-label", label));
    wrap.appendChild(control);
    return wrap;
  }
  function selectedValue(group) {
    var active = group.querySelector(".is-active");
    return active ? active.getAttribute("data-value") : "";
  }
  function activate(group, button) {
    Array.prototype.forEach.call(group.children, function (child) { child.classList.toggle("is-active", child === button); });
  }

  function mount(host, options) {
    var state = { view: "chart", hidden: Object.create(null), model: null, requestId: 0, controller: null, resizeTimer: 0, lastWidth: 0 };
    var nowMs = options.now || Date.now;
    var defaultEnd = latestDate(nowMs());

    host.textContent = "";
    var form = el("article", "mi-card mi-trend-form");
    var gridHead = el("div", "mi-trend-grid-head");
    gridHead.setAttribute("aria-hidden", "true");
    gridHead.appendChild(el("span"));
    gridHead.appendChild(el("span", "", "주제어"));
    var keywordHead = el("span", "", "포함할 검색어");
    keywordHead.appendChild(el("em", "", "쉼표로 나눠 입력하면 합쳐서 한 선으로 그립니다"));
    gridHead.appendChild(keywordHead);
    form.appendChild(gridHead);

    var topicsRoot = el("div", "mi-trend-topics");
    var topicRows = [];
    for (var slot = 0; slot < MAX_TOPICS; slot += 1) {
      topicRows.push(createTopicRow(slot));
      topicsRoot.appendChild(topicRows[slot].row);
    }
    form.appendChild(topicsRoot);

    var optionsRoot = el("div", "mi-trend-options");
    var periodGroup = segmentGroup("조회 기간", PERIODS, "1y");
    var startInput = dateInput("시작일", presetStart("1y", defaultEnd));
    var endInput = dateInput("종료일", defaultEnd);
    var dates = el("div", "mi-trend-dates");
    dates.appendChild(startInput);
    dates.appendChild(el("span", "", "~"));
    dates.appendChild(endInput);
    var periodLine = el("div", "mi-trend-line");
    periodLine.appendChild(periodGroup);
    periodLine.appendChild(dates);
    optionsRoot.appendChild(field("기간", periodLine));
    var unitGroup = segmentGroup("집계 단위", [["date", "일간"], ["week", "주간"], ["month", "월간"]], "date");
    optionsRoot.appendChild(field("집계", unitGroup));

    var moreButton = el("button", "mi-trend-more");
    moreButton.type = "button";
    moreButton.setAttribute("aria-expanded", "false");
    moreButton.appendChild(el("b", "", "상세 조건"));
    var moreSummary = el("span");
    moreButton.appendChild(moreSummary);
    optionsRoot.appendChild(moreButton);

    var deviceGroup = segmentGroup("범위", [["", "전체"], ["mo", "모바일"], ["pc", "PC"]], "");
    var genderGroup = segmentGroup("성별", [["", "전체"], ["f", "여성"], ["m", "남성"]], "");
    var ageGroup = segmentGroup("연령 선택", [["", "전체"]].concat(AGE_OPTIONS), "");
    optionsRoot.appendChild(field("범위", deviceGroup, "is-advanced"));
    optionsRoot.appendChild(field("성별", genderGroup, "is-advanced"));
    optionsRoot.appendChild(field("연령", ageGroup, "is-advanced is-grow"));
    form.appendChild(optionsRoot);

    var foot = el("div", "mi-trend-foot");
    var status = el("p", "", "");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    var runButton = el("button", "mi-button", "조회");
    runButton.type = "button";
    foot.appendChild(status);
    foot.appendChild(runButton);
    form.appendChild(foot);
    host.appendChild(form);

    var result = el("article", "mi-card mi-trend-result");
    var resultHead = el("div", "mi-trend-result-head");
    var titleWrap = el("div");
    titleWrap.appendChild(el("h2", "", "비교 결과"));
    var conditionsRoot = el("div", "mi-trend-conditions");
    titleWrap.appendChild(conditionsRoot);
    resultHead.appendChild(titleWrap);
    var actions = el("div", "mi-trend-actions");
    var viewGroup = segmentGroup("보기 방식", [["chart", "그래프"], ["table", "표"]], "chart");
    var saveButton = el("button", "mi-button is-ghost", "엑셀로 저장");
    saveButton.type = "button";
    actions.appendChild(viewGroup);
    actions.appendChild(saveButton);
    resultHead.appendChild(actions);
    result.appendChild(resultHead);
    var cards = el("div", "mi-trend-series");
    var chart = el("div", "mi-trend-chart");
    var table = el("div", "mi-trend-table");
    table.hidden = true;
    var empty = el("div", "mi-trend-empty");
    var source = el("p", "mi-trend-source");
    result.appendChild(cards);
    result.appendChild(chart);
    result.appendChild(table);
    result.appendChild(empty);
    result.appendChild(source);
    host.appendChild(result);

    function dateInput(label, value) {
      var input = el("input", "mi-input");
      input.type = "date";
      input.min = MIN_DATE;
      input.max = defaultEnd;
      input.value = value;
      input.setAttribute("aria-label", label);
      return input;
    }
    function createTopicRow(index) {
      var row = el("div", "mi-trend-row is-empty");
      row.style.setProperty("--series", series(index));
      row.appendChild(el("span", "mi-trend-key"));
      function cell(label, placeholder) {
        var wrap = el("div", "mi-trend-input");
        wrap.appendChild(el("span", "mi-trend-input-label", label));
        var input = el("input", "mi-input");
        input.placeholder = placeholder;
        input.maxLength = 1300;
        input.setAttribute("aria-label", "주제어 " + (index + 1) + " " + (label === "포함할 검색어" ? "검색어" : "이름"));
        input.autocomplete = "off";
        input.addEventListener("input", function () { syncRow(row, nameInputOf(row)); markDirty(); });
        var clear = el("button", "mi-trend-clear", "×");
        clear.type = "button";
        clear.setAttribute("aria-label", "지우기");
        clear.addEventListener("click", function () { input.value = ""; syncRow(row, nameInputOf(row)); markDirty(); input.focus(); });
        wrap.appendChild(input);
        wrap.appendChild(clear);
        row.appendChild(wrap);
        return input;
      }
      var name = cell("주제어 " + (index + 1), "주제어 " + (index + 1));
      var keywords = cell("포함할 검색어", "검색어를 쉼표로 나눠 입력");
      return { row: row, name: name, keywords: keywords };
    }
    function nameInputOf(row) { return row.querySelectorAll("input"); }
    function syncRow(row, inputs) {
      var filled = Array.prototype.some.call(inputs, function (input) { return text(input.value); });
      row.classList.toggle("is-empty", !filled);
    }
    function ageValues() {
      return Array.prototype.filter.call(ageGroup.children, function (child) { return child.classList.contains("is-active") && child.getAttribute("data-value"); }).map(function (child) { return child.getAttribute("data-value"); });
    }
    function updateMoreSummary() {
      var ages = Array.prototype.filter.call(ageGroup.children, function (child) { return child.classList.contains("is-active"); }).map(function (child) { return child.textContent; }).join(", ");
      moreSummary.textContent = "범위 " + DEVICE_LABEL[selectedValue(deviceGroup)] + ", 성별 " + GENDER_LABEL[selectedValue(genderGroup)] + ", 연령 " + ages;
    }
    function setStatus(message, tone) {
      status.textContent = message;
      status.className = tone ? "is-" + tone : "";
    }
    function restStatus() { setStatus("2016년 1월 이후 조회할 수 있습니다. 종료일은 어제까지 선택합니다."); }
    function markDirty() {
      updateMoreSummary();
      if (state.model) setStatus("조건이 바뀌었습니다. 조회를 누르면 결과가 새로 나옵니다.");
    }

    periodGroup.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      activate(periodGroup, button);
      var period = button.getAttribute("data-value");
      if (period !== "custom") {
        var end = refreshDateLimits();
        endInput.value = end;
        startInput.value = presetStart(period, end);
      }
      markDirty();
    });
    [startInput, endInput].forEach(function (input) {
      input.addEventListener("change", function () {
        activate(periodGroup, periodGroup.querySelector('[data-value="custom"]'));
        markDirty();
      });
    });
    [unitGroup, deviceGroup, genderGroup].forEach(function (group) {
      group.addEventListener("click", function (event) {
        var button = event.target.closest("button");
        if (!button) return;
        activate(group, button);
        markDirty();
      });
    });
    ageGroup.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      var all = ageGroup.querySelector('[data-value=""]');
      if (button === all) activate(ageGroup, all);
      else {
        button.classList.toggle("is-active");
        all.classList.remove("is-active");
        if (!ageValues().length) all.classList.add("is-active");
      }
      markDirty();
    });
    moreButton.addEventListener("click", function () {
      var open = optionsRoot.classList.toggle("is-open");
      moreButton.setAttribute("aria-expanded", open ? "true" : "false");
    });
    viewGroup.addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      activate(viewGroup, button);
      state.view = button.getAttribute("data-value");
      showBody();
      if (state.view === "chart") draw(false);
    });

    function showBody() {
      var usable = state.model && state.model.periods.length;
      chart.hidden = !usable || state.view !== "chart";
      table.hidden = !usable || state.view !== "table";
      cards.hidden = !usable;
      empty.hidden = Boolean(usable);
      source.hidden = !usable;
      saveButton.disabled = !usable;
      viewGroup.hidden = !usable;
      conditionsRoot.hidden = !state.model;
    }
    function showEmpty(message) { empty.textContent = message; showBody(); }

    function clearResult() {
      state.model = null;
      state.lastWidth = 0;
      state.hidden = Object.create(null);
      conditionsRoot.textContent = "";
      cards.textContent = "";
      chart.textContent = "";
      table.textContent = "";
      source.textContent = "";
      showEmpty("주제어를 입력하고 조회를 누르면 여기에 비교 그래프가 나옵니다.");
    }

    function renderCards() {
      cards.textContent = "";
      state.model.series.forEach(function (item) {
        var hasData = item.points.length > 0;
        var hidden = Boolean(state.hidden[item.slot]);
        var card = el("button", "mi-trend-card");
        card.type = "button";
        card.style.setProperty("--series", series(item.slot));
        card.disabled = !hasData;
        card.setAttribute("aria-pressed", hidden || !hasData ? "false" : "true");
        card.setAttribute("aria-label", item.title + " 선 " + (hidden ? "표시하기" : "숨기기"));
        card.setAttribute("data-slot", String(item.slot));
        card.title = item.keywords.join(", ");
        var name = el("span", "mi-trend-card-name");
        name.appendChild(el("i"));
        name.appendChild(el("b", "", item.title));
        name.appendChild(el("i", "mi-trend-card-check", "✓"));
        card.appendChild(name);
        var value = el("span", "mi-trend-card-value");
        value.appendChild(el("strong", "", hasData ? item.average.toFixed(1) : "-"));
        value.appendChild(el("span", "", hasData ? "기간 평균" : "데이터 없음"));
        card.appendChild(value);
        card.addEventListener("click", function () {
          state.hidden[item.slot] = !state.hidden[item.slot];
          renderCards();
          var again = cards.querySelector('[data-slot="' + item.slot + '"]');
          if (again) again.focus({ preventScroll: true });
          draw(false);
        });
        card.addEventListener("pointerenter", function () { setFocus(item.slot); });
        card.addEventListener("pointerleave", function () { setFocus(-1); });
        cards.appendChild(card);
      });
    }

    function setFocus(slot) {
      chart.classList.toggle("is-focus", slot >= 0 && !state.hidden[slot]);
      Array.prototype.forEach.call(chart.querySelectorAll("[data-series-slot]"), function (node) {
        node.classList.toggle("is-focus", Number(node.getAttribute("data-series-slot")) === slot);
      });
    }

    function renderTable() {
      table.textContent = "";
      var model = state.model;
      var grid = el("table");
      var head = el("thead");
      var headRow = el("tr");
      headRow.appendChild(el("th", "", "날짜"));
      model.series.forEach(function (item) { headRow.appendChild(el("th", "", item.title)); });
      head.appendChild(headRow);
      grid.appendChild(head);
      var body = el("tbody");
      for (var index = model.periods.length - 1; index >= 0; index -= 1) {
        var row = el("tr");
        row.appendChild(el("td", "", dotted(model.periods[index])));
        for (var column = 0; column < model.series.length; column += 1) {
          var value = model.series[column].byPeriod[model.periods[index]];
          row.appendChild(el("td", "", value === undefined ? "-" : value.toFixed(1)));
        }
        body.appendChild(row);
      }
      grid.appendChild(body);
      table.appendChild(grid);
    }

    function draw(animate) {
      var model = state.model;
      if (!model || state.view !== "chart" || !model.periods.length) return;
      var width = chart.clientWidth;
      // 화면이 숨겨져 있으면 그리지 못한다. 다시 보일 때 새 결과로 그리도록 표시해 둔다.
      if (!width) { state.lastWidth = 0; return; }
      state.lastWidth = width;
      var height = width < 560 ? 280 : 400;
      var left = 30;
      var right = 8;
      var top = 38;
      var bottom = 30;
      var unit = model.conditions.timeUnit;
      chart.textContent = "";
      chart.classList.remove("is-focus");
      var svg = svgEl(null, "svg", { viewBox: "0 0 " + width + " " + height, height: height, role: "img", tabindex: "0", "aria-label": "주제어별 검색어 트렌드 그래프. 표 보기에서 값을 확인할 수 있습니다." });
      var firstTime = model.times[0];
      var lastTime = model.times[model.times.length - 1];
      function x(time) { return left + (lastTime > firstTime ? (time - firstTime) / (lastTime - firstTime) : 0.5) * (width - left - right); }
      function y(value) { return top + (1 - value / 100) * (height - top - bottom); }
      [0, 25, 50, 75, 100].forEach(function (tick) {
        svgEl(svg, "line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: tick === 0 ? "mi-trend-baseline" : "mi-trend-gridline" });
        svgEl(svg, "text", { x: left - 8, y: y(tick) + 4, "text-anchor": "end", class: "mi-trend-axis" }, String(tick));
      });
      var minGap = width < 560 ? 62 : 52;
      var lastLabel = -999;
      xTicks(model.periods).forEach(function (tick) {
        var at = x(model.times[tick.index]);
        if (at - lastLabel < minGap || at > width - right - 14) return;
        lastLabel = at;
        if (tick.major) svgEl(svg, "line", { x1: at, x2: at, y1: top, y2: height - bottom, class: "mi-trend-gridline" });
        svgEl(svg, "text", { x: at, y: height - 9, "text-anchor": "middle", class: "mi-trend-axis" }, tick.label);
      });

      var shown = model.series.filter(function (item) { return !state.hidden[item.slot] && item.points.length; });
      var ordered = shown.slice().sort(function (a, b) { return b.average - a.average; });
      var totalPoints = shown.reduce(function (max, item) { return Math.max(max, item.points.length); }, 0);
      var target = Math.max(60, Math.round((width - left - right) / 2.6));
      var dense = totalPoints > target;
      ordered.forEach(function (item) {
        var segments = segmentsOf(item.points, unit);
        var lineD = "";
        var areaD = "";
        segments.forEach(function (segment) {
          if (segment.length === 1) {
            var dot = svgEl(svg, "circle", { cx: x(segment[0].time), cy: y(segment[0].value), r: 2.5, class: "mi-trend-dot", "data-series-slot": item.slot });
            dot.style.setProperty("--series", series(item.slot));
            return;
          }
          var values = segment.map(function (point) { return point.value; });
          var keep = item.peak ? segment.indexOf(item.peak) : -1;
          var budget = Math.max(3, Math.round(target * segment.length / item.points.length));
          var points = thinIndices(values, budget, keep).map(function (index) { return [x(segment[index].time), y(segment[index].value)]; });
          var path = dense ? linePath(points) : curvePath(points);
          lineD += path;
          areaD += path + "L" + points[points.length - 1][0].toFixed(1) + "," + y(0).toFixed(1) + "L" + points[0][0].toFixed(1) + "," + y(0).toFixed(1) + "Z";
        });
        if (!lineD) return;
        var area = svgEl(svg, "path", { d: areaD, class: "mi-trend-area", "data-series-slot": item.slot });
        area.style.setProperty("--series", series(item.slot));
        var attrs = { d: lineD, class: "mi-trend-line-path" + (dense ? " is-dense" : "") + (animate ? " is-drawing" : ""), "data-series-slot": item.slot };
        if (animate) attrs.pathLength = "1";
        var line = svgEl(svg, "path", attrs);
        line.style.setProperty("--series", series(item.slot));
      });

      var top1 = shown.reduce(function (best, item) { return !best || item.peak.value > best.peak.value ? item : best; }, null);
      if (top1) {
        var peakX = x(top1.peak.time);
        var peakY = y(top1.peak.value);
        var peakGroup = svgEl(svg, "g", { class: "mi-trend-peak" });
        var peakDot = svgEl(peakGroup, "circle", { cx: peakX, cy: peakY, r: 4.5 });
        peakDot.style.setProperty("--series", series(top1.slot));
        var nearRight = peakX > width - 100;
        var nearLeft = peakX < left + 90;
        svgEl(peakGroup, "text", { x: nearRight ? peakX + 4 : nearLeft ? peakX - 4 : peakX, y: peakY - 12, "text-anchor": nearRight ? "end" : nearLeft ? "start" : "middle" }, top1.title + " 최고 " + dotted(top1.peak.period));
      }

      var hover = svgEl(svg, "g", { visibility: "hidden" });
      var guide = svgEl(hover, "line", { y1: top, y2: height - bottom, class: "mi-trend-guide" });
      var dots = shown.map(function (item) {
        var dot = svgEl(hover, "circle", { r: 4, class: "mi-trend-hover-dot" });
        dot.style.setProperty("--series", series(item.slot));
        return dot;
      });
      svgEl(svg, "rect", { x: left, y: top, width: width - left - right, height: height - top - bottom, class: "mi-trend-hit" });
      chart.appendChild(svg);
      if (width < 560 && model.periods.length > 400) chart.appendChild(el("p", "mi-trend-hint", "기간이 길면 주간이나 월간으로 볼 때 더 잘 보입니다."));
      var tip = el("div", "mi-trend-tip");
      tip.hidden = true;
      chart.appendChild(tip);

      var cursor = -1;
      function show(index) {
        cursor = index;
        var period = model.periods[index];
        var at = x(model.times[index]);
        hover.setAttribute("visibility", "visible");
        guide.setAttribute("x1", at);
        guide.setAttribute("x2", at);
        shown.forEach(function (item, position) {
          var value = item.byPeriod[period];
          dots[position].setAttribute("visibility", value === undefined ? "hidden" : "inherit");
          dots[position].setAttribute("cx", at);
          if (value !== undefined) dots[position].setAttribute("cy", y(value));
        });
        tip.textContent = "";
        tip.hidden = false;
        tip.appendChild(el("b", "", dotted(period)));
        shown.slice().sort(function (a, b) {
          var left1 = a.byPeriod[period];
          var right1 = b.byPeriod[period];
          return (right1 === undefined ? -1 : right1) - (left1 === undefined ? -1 : left1);
        }).forEach(function (item) {
          var row = el("div");
          var key = el("i");
          key.style.setProperty("--series", series(item.slot));
          var value = item.byPeriod[period];
          row.appendChild(key);
          row.appendChild(el("span", "", item.title));
          row.appendChild(el("strong", "", value === undefined ? "-" : value.toFixed(1)));
          tip.appendChild(row);
        });
        var place = at + 14;
        if (place + tip.offsetWidth > width) place = at - tip.offsetWidth - 14;
        tip.style.left = Math.max(0, place) + "px";
        tip.style.top = top + 4 + "px";
      }
      function hide() { hover.setAttribute("visibility", "hidden"); tip.hidden = true; }
      svg.addEventListener("pointermove", function (event) {
        var box = svg.getBoundingClientRect();
        var ratio = (event.clientX - box.left - left) / Math.max(1, box.width - left - right);
        show(nearestIndex(model.times, firstTime + Math.max(0, Math.min(1, ratio)) * (lastTime - firstTime)));
      });
      svg.addEventListener("pointerleave", hide);
      svg.addEventListener("blur", hide);
      svg.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { hide(); return; }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        var next = cursor < 0 ? model.periods.length - 1 : cursor + (event.key === "ArrowLeft" ? -1 : 1);
        show(Math.max(0, Math.min(model.periods.length - 1, next)));
      });
    }

    function requestBody() {
      var topics = [];
      var slots = [];
      topicRows.forEach(function (row, index) {
        var name = text(row.name.value);
        var keywords = splitKeywords(row.keywords.value);
        if (!name && !keywords.length) return;
        topics.push({ name: name, keywords: keywords });
        slots.push(index);
      });
      return {
        slots: slots,
        body: { topics: topics, startDate: startInput.value, endDate: endInput.value, timeUnit: selectedValue(unitGroup), device: selectedValue(deviceGroup), gender: selectedValue(genderGroup), ages: ageValues() }
      };
    }

    // 페이지를 자정 넘겨 열어 두어도 달력의 마지막 날이 새 어제를 따라가게 한다.
    function refreshDateLimits() {
      var latest = latestDate(nowMs());
      startInput.max = latest;
      endInput.max = latest;
      return latest;
    }
    function setBusy(busy) {
      runButton.disabled = busy;
      runButton.textContent = busy ? "조회 중" : "조회";
    }

    async function run() {
      // 진행 중인 조회는 입력 검사 전에 무효로 한다. 늦게 온 앞 응답이 새 안내를 덮지 않게 한다.
      var id = state.requestId + 1;
      state.requestId = id;
      if (state.controller) state.controller.abort();
      state.controller = null;
      setBusy(false);
      refreshDateLimits();
      var request = requestBody();
      if (!request.body.topics.length) { setStatus("주제어를 1개 이상 입력해 주세요.", "error"); return; }
      if (!request.body.startDate || !request.body.endDate || request.body.startDate > request.body.endDate) { setStatus("기간을 다시 확인해 주세요. 시작일은 종료일보다 앞이어야 합니다.", "error"); return; }
      var controller = typeof window.AbortController === "function" ? new window.AbortController() : null;
      state.controller = controller;
      setBusy(true);
      setStatus("네이버 데이터를 불러오는 중입니다.");
      try {
        var response = await options.post(options.apiUrl, request.body, controller ? controller.signal : undefined);
        if (id !== state.requestId) return;
        if (!response.ok || !response.payload || response.payload.ok !== true) {
          var failure = response.payload && response.payload.message ? response.payload.message : "조회하지 못했습니다. 잠시 뒤 다시 조회해 주세요.";
          setStatus(state.model ? failure + " 아래는 이전 조회 결과입니다." : failure, "error");
          return;
        }
        state.hidden = Object.create(null);
        state.lastWidth = 0;
        state.model = buildModel(response.payload, request.slots);
        conditionsRoot.textContent = "";
        conditionTexts(state.model.conditions).forEach(function (label) { conditionsRoot.appendChild(el("span", "mi-trend-chip", label)); });
        var unit = state.model.conditions.timeUnit;
        source.textContent = "가장 높은 지점을 100으로 놓은 상대 수치입니다. 기간이나 범위를 바꾸면 100의 기준도 달라지므로 다른 조회의 숫자와 직접 비교할 수 없습니다." + (unit === "date" ? "" : " 첫 구간과 마지막 구간은 일부 날짜만 포함될 수 있습니다.") + " 출처: 네이버 데이터랩.";
        if (!state.model.periods.length) {
          cards.textContent = "";
          chart.textContent = "";
          table.textContent = "";
          showEmpty("이 조건에 해당하는 데이터가 없습니다. 기간이나 검색어를 바꿔 다시 조회해 주세요.");
          setStatus("이 조건에 해당하는 데이터가 없습니다.", "error");
          return;
        }
        var missing = state.model.series.filter(function (item) { return !item.points.length; }).map(function (item) { return item.title; });
        setStatus(missing.length ? "데이터가 없는 주제어가 있습니다: " + missing.join(", ") : "조회를 마쳤습니다.", missing.length ? "error" : "");
        renderCards();
        renderTable();
        showBody();
        draw(true);
        var box = result.getBoundingClientRect();
        if (box.top > window.innerHeight * 0.7 && typeof result.scrollIntoView === "function") {
          var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          result.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        }
      } catch (error) {
        if (id !== state.requestId || (error && error.name === "AbortError")) return;
        var expired = error && /session/.test(String(error.message));
        var message = expired ? "로그인 상태를 확인하지 못했습니다. 다시 로그인한 뒤 조회해 주세요." : "조회하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 조회해 주세요.";
        setStatus(state.model ? message + " 아래는 이전 조회 결과입니다." : message, "error");
      } finally {
        if (id === state.requestId) { setBusy(false); state.controller = null; }
      }
    }
    runButton.addEventListener("click", run);
    topicsRoot.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.isComposing && event.target && event.target.tagName === "INPUT") { event.preventDefault(); run(); }
    });

    saveButton.addEventListener("click", function () {
      if (!state.model || !state.model.periods.length) return;
      try {
        var blob = new window.Blob([workbookBytes(state.model)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        var url = window.URL.createObjectURL(blob);
        var link = el("a");
        link.href = url;
        link.download = "검색어트렌드_" + state.model.conditions.startDate.replace(/-/g, "") + "-" + state.model.conditions.endDate.replace(/-/g, "") + ".xlsx";
        window.document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { window.URL.revokeObjectURL(url); }, 1000);
        setStatus("엑셀 파일을 저장했습니다.");
      } catch (error) {
        setStatus("엑셀 파일을 만들지 못했습니다. 다시 눌러 주세요.", "error");
      }
    });

    function reset() {
      state.requestId += 1;
      if (state.controller) state.controller.abort();
      state.controller = null;
      setBusy(false);
      topicRows.forEach(function (row) {
        row.name.value = "";
        row.keywords.value = "";
        row.row.classList.add("is-empty");
      });
      var end = refreshDateLimits();
      endInput.value = end;
      startInput.value = presetStart("1y", end);
      activate(periodGroup, periodGroup.querySelector('[data-value="1y"]'));
      activate(unitGroup, unitGroup.querySelector('[data-value="date"]'));
      activate(deviceGroup, deviceGroup.querySelector('[data-value=""]'));
      activate(genderGroup, genderGroup.querySelector('[data-value=""]'));
      activate(ageGroup, ageGroup.querySelector('[data-value=""]'));
      optionsRoot.classList.remove("is-open");
      moreButton.setAttribute("aria-expanded", "false");
      updateMoreSummary();
      activate(viewGroup, viewGroup.querySelector('[data-value="chart"]'));
      state.view = "chart";
      clearResult();
      restStatus();
    }

    if (typeof window.ResizeObserver === "function") {
      new window.ResizeObserver(function () {
        window.clearTimeout(state.resizeTimer);
        state.resizeTimer = window.setTimeout(function () {
          if (chart.clientWidth && chart.clientWidth !== state.lastWidth) draw(false);
        }, 120);
      }).observe(result);
    }
    reset();
    return { reset: reset, run: run };
  }

  // 세션을 확인해 CSRF 값을 받은 뒤 보낸다. 값은 메모리에서만 쓰고 저장·표시하지 않는다.
  function createPost(fetcher, sessionUrl, sessionKey) {
    return async function (url, body, signal) {
      var initial = sessionKey();
      if (!initial) throw new Error("session_required");
      var sessionResponse = await fetcher(sessionUrl, { method: "GET", cache: "no-store", credentials: "same-origin", signal: signal });
      var sessionPayload = await sessionResponse.json();
      if (sessionKey() !== initial) throw new Error("session_changed");
      var session = sessionPayload && sessionPayload.session;
      if (!sessionResponse.ok || !session || ["owner", "team", "client"].indexOf(session.role) < 0) throw new Error("session_required");
      var response = await fetcher(url, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal: signal,
        headers: { "content-type": "application/json", "x-mi-csrf": String(session.csrfToken || "") },
        body: JSON.stringify(body)
      });
      var payload = await response.json().catch(function () { return null; });
      if (sessionKey() !== initial) throw new Error("session_changed");
      return { ok: response.ok, status: response.status, payload: payload };
    };
  }

  // 같은 브라우저에서 코드만 바꿔 다른 광고주로 들어가도 로그인 표시는 그대로다. 세션 값으로 계정을 구분한다.
  function createIdentity(fetcher, sessionUrl) {
    return async function () {
      var response = await fetcher(sessionUrl, { method: "GET", cache: "no-store", credentials: "same-origin" });
      var payload = await response.json();
      var session = payload && payload.session;
      if (!response.ok || !session || !session.role) return "";
      return JSON.stringify([session.role, session.scopeKey || "", session.clientId || "", session.teamId || ""]);
    };
  }

  function bootstrap() {
    var doc = window.document;
    if (!doc || typeof window.fetch !== "function") return;
    var root = doc.getElementById("mi-admin") || doc.getElementById("mi-clean");
    var host = root && root.querySelector("[data-search-trend]");
    if (!host || host.getAttribute("data-search-trend-mounted") === "true") return;
    var epoch = 1;
    function sessionKey() { return root.classList.contains("is-authed") && !root.classList.contains("is-locked") ? String(epoch) : ""; }
    var hostname = window.location && window.location.hostname;
    var base = hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8790" : "";
    var controller = mount(host, {
      post: createPost(function (url, options) { return window.fetch(url, options); }, base + "/api/session", sessionKey),
      apiUrl: base + API_PATH
    });
    host.setAttribute("data-search-trend-mounted", "true");
    var identityOf = createIdentity(function (url, options) { return window.fetch(url, options); }, base + "/api/session");
    var knownIdentity = "";
    var identitySeq = 0;
    function checkIdentity() {
      if (!sessionKey()) return;
      var seq = identitySeq + 1;
      identitySeq = seq;
      identityOf().then(function (identity) {
        if (seq !== identitySeq || !identity) return;
        if (knownIdentity && identity !== knownIdentity) { epoch += 1; controller.reset(); }
        knownIdentity = identity;
      }).catch(function () { /* 확인 실패는 다음 기회에 다시 본다 */ });
    }
    window.addEventListener("mi:rank-auth-ready", checkIdentity);
    var view = host.closest(".mi-view");
    if (view && typeof window.MutationObserver === "function") {
      new window.MutationObserver(function () { if (view.classList.contains("is-active")) checkIdentity(); }).observe(view, { attributes: true, attributeFilter: ["class"] });
    }
    checkIdentity();
    // 로그아웃·계정 전환 때 입력과 결과를 비운다. 다음 사람이 앞 계정의 조회를 보면 안 된다.
    if (typeof window.MutationObserver === "function") {
      new window.MutationObserver(function (records) {
        var now = root.classList.contains("is-authed") + ":" + root.classList.contains("is-locked");
        var changed = records.some(function (record) {
          var previous = " " + String(record.oldValue || "") + " ";
          return (previous.indexOf(" is-authed ") >= 0) + ":" + (previous.indexOf(" is-locked ") >= 0) !== now;
        });
        if (changed) { epoch += 1; knownIdentity = ""; controller.reset(); checkIdentity(); }
      }).observe(root, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    }
  }

  window.MomentSearchTrend = {
    mount: mount,
    buildModel: buildModel,
    segmentsOf: segmentsOf,
    thinIndices: thinIndices,
    xTicks: xTicks,
    presetStart: presetStart,
    latestDate: latestDate,
    splitKeywords: splitKeywords,
    conditionTexts: conditionTexts,
    workbookRows: workbookRows,
    workbookBytes: workbookBytes
  };
  if (window.document) {
    if (window.document.readyState === "loading") window.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    else bootstrap();
  }
}());
