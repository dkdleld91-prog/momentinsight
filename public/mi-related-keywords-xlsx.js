// Small, fixed-schema browser XLSX writer. No network, third-party runtime, or formulas.
(function () {
  "use strict";
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var MAX_ROWS = 50;
  var MAX_TEXT = 32767;
  var MAX_TOTAL_TEXT = 1000000;
  var MAIN_HEADERS = ["번호", "키워드", "통합\n월 검색량", "PC\n월 검색량", "모바일\n월 검색량", "광고\n경쟁도", "광고 평균\n클릭수", "광고\n클릭률"];
  var MAIN_WIDTHS = [6, 27, 16, 12, 13, 13, 17, 15];
  var CRC_TABLE = new Uint32Array(256);
  for (var crcIndex = 0; crcIndex < 256; crcIndex++) {
    var crcValue = crcIndex;
    for (var bitIndex = 0; bitIndex < 8; bitIndex++) crcValue = crcValue & 1 ? 0xedb88320 ^ crcValue >>> 1 : crcValue >>> 1;
    CRC_TABLE[crcIndex] = crcValue >>> 0;
  }

  function invalid(reason) { throw new Error("Invalid XLSX: " + reason); }

  function validText(value) {
    if (typeof value !== "string" || value.length > MAX_TEXT) invalid("text must be a string of at most 32767 characters");
    for (var index = 0; index < value.length; index++) {
      var code = value.codePointAt(index);
      if (code > 0xffff) index++;
      if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
        invalid("text contains a character not representable in XML 1.0");
      }
    }
    return value;
  }

  function xml(value) {
    // SpreadsheetML interprets _xHHHH_; escape the underscore to retain literal text.
    return validText(value).replace(/_x[0-9a-f]{4}_/gi, function (match) { return "_x005F_" + match.slice(1); })
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
      .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  }

  function timestamp(value, optional) {
    if (optional && (value === null || value === "")) return "확인 필요";
    if (typeof value !== "string") invalid("timestamp must be an explicit-zone ISO string");
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) invalid("timestamp must be an explicit-zone ISO string");
    var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    var hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
    var offsetHour = Number(match[10] || 0), offsetMinute = Number(match[11] || 0);
    var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) invalid("invalid ISO timestamp");
    var parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) invalid("invalid ISO timestamp");
    var date = new Date(parsed + 9 * 60 * 60 * 1000);
    function pad(number) { return String(number).padStart(2, "0"); }
    return String(date.getUTCFullYear()).padStart(4, "0") + "." + pad(date.getUTCMonth() + 1) + "." + pad(date.getUTCDate())
      + " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds()) + " KST";
  }

  function validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("expected workbook input");
    var totalText = 0;
    function text(value) {
      validText(value);
      totalText += value.length;
      if (totalText > MAX_TOTAL_TEXT) invalid("workbook text exceeds the bounded export size");
      return value;
    }
    var keyword = text(input.keyword);
    if (!keyword.trim()) invalid("query keyword is empty");
    var competition = text(input.competition);
    var sortLabel = text(input.sortLabel);
    var queriedAt = timestamp(input.queriedAt, true);
    var exportedAt = timestamp(input.exportedAt, false);
    if (!Array.isArray(input.mainRows) || input.mainRows.length < 1 || input.mainRows.length > MAX_ROWS) invalid("expected 1 to 50 rows");
    function matrix(rows, width) {
      // Explicit indexing deliberately rejects sparse arrays, undefined, booleans, and coercion.
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        var row = rows[rowIndex];
        if (!Array.isArray(row) || row.length !== width) invalid("invalid row width");
        for (var columnIndex = 0; columnIndex < width; columnIndex++) {
          var value = row[columnIndex];
          if (value === null) continue;
          if (typeof value === "string") text(value);
          else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid("cells must be null, literal strings, or finite nonnegative numbers");
        }
      }
    }
    matrix(input.mainRows, 8);
    var seen = Object.create(null);
    for (var index = 0; index < input.mainRows.length; index++) {
      var main = input.mainRows[index];
      if (main[0] !== index + 1 || typeof main[1] !== "string" || !main[1].trim()
        || seen[main[1]]) invalid("row numbers or keywords do not match");
      seen[main[1]] = true;
    }
    var context = "기준어: " + keyword + " · 조회: " + queriedAt;
    var details = "내보내기: " + exportedAt + " · 경쟁도: " + (competition || "전체") + " · 정렬: " + sortLabel + " · " + input.mainRows.length + "개";
    validText(context);
    validText(details);
    return { context: context, details: details, mainRows: input.mainRows };
  }

  function column(index) { return String.fromCharCode(65 + index); }

  function cell(reference, value, style) {
    var prefix = '<c r="' + reference + '" s="' + style + '"';
    if (value === null) return prefix + '/>';
    if (typeof value === "number") return prefix + '><v>' + String(value) + '</v></c>';
    return prefix + ' t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
  }

  function row(number, cells, height) { return '<row r="' + number + '" ht="' + (height || 24) + '" customHeight="1">' + cells.join("") + '</row>'; }

  function textWidth(value) {
    var width = 0;
    for (var index = 0; index < value.length; index++) {
      var code = value.codePointAt(index);
      if (code > 0xffff) index++;
      if (code === 0x09) width += 4;
      else if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff)
        || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff)
        || (code >= 0xfe20 && code <= 0xfe2f) || code === 0x200b || code === 0x200d
        || code === 0xfe0e || code === 0xfe0f) continue;
      else if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f)
        || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
        || code >= 0x1f000)) width += 2;
      else width += 1;
    }
    return width;
  }

  function wrappedLines(value, columnWidth) {
    // Excel column units are digit widths. Reserve indent and a 10% font-width margin.
    var capacity = Math.max(1, Math.floor((columnWidth - 3) * 0.9));
    return value.split(/\r\n|\r|\n/).reduce(function (total, paragraph) {
      var lines = 1, used = 0;
      var tokens = paragraph.match(/\S+\s*|\s+/g) || [];
      tokens.forEach(function (token) {
        var width = textWidth(token);
        // Words move intact to the next line; long tokens also break within the cell.
        if (used && used + width > capacity) { lines++; used = 0; }
        if (width <= capacity) used += width;
        else {
          for (var index = 0; index < token.length; index++) {
            var code = token.codePointAt(index);
            var character = String.fromCodePoint(code);
            if (code > 0xffff) index++;
            var units = textWidth(character);
            if (used + units > capacity) { lines++; used = 0; }
            used += units;
          }
        }
      });
      return total + lines;
    }, 0);
  }

  function bodyHeight(values, widths, minimum) {
    var lines = 1;
    values.forEach(function (value, index) {
      if (typeof value === "string" && value.length) lines = Math.max(lines, wrappedLines(value, widths[index]));
    });
    var height = (minimum || 28) - 15 + 15 * lines;
    if (height > 409) invalid("body text exceeds Excel's 409pt row-height limit");
    return height;
  }

  function worksheet(data) {
    var rows = data.mainRows;
    var headers = MAIN_HEADERS;
    var widths = MAIN_WIDTHS;
    var mergedWidth = widths.reduce(function (total, width) { return total + width; }, 0);
    var lastColumn = column(headers.length - 1), end = rows.length + 6;
    var merges = ['A2:' + lastColumn + '2', 'A3:' + lastColumn + '3', 'A4:' + lastColumn + '4'];
    var output = [XML_HEAD, '<worksheet xmlns="' + SHEET_NS + '">', '<dimension ref="A2:' + lastColumn + end + '"/>',
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="2" ySplit="6" topLeftCell="C7" activePane="bottomRight" state="frozen"/>',
      '<selection pane="bottomRight" activeCell="C7" sqref="C7"/></sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="28"/><cols>'];
    widths.forEach(function (width, index) { output.push('<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>'); });
    output.push('</cols><sheetData>', row(2, [cell("A2", "모먼트인사이트 · 연관 키워드", 1)]),
      row(3, [cell("A3", data.context, 2)], bodyHeight([data.context], [mergedWidth], 24)),
      row(4, [cell("A4", data.details, 2)], bodyHeight([data.details], [mergedWidth], 24)));
    output.push(row(5, [cell("A5", "키워드", 7), cell("C5", "월간 검색수", 7), cell("F5", "광고 지표", 7)]));
    merges.push("A5:B5", "C5:E5", "F5:H5");
    output.push(row(6, headers.map(function (header, index) { return cell(column(index) + "6", header, 3); }), 36));
    rows.forEach(function (values, index) {
      output.push(row(index + 7, values.map(function (value, columnIndex) {
        var style = 0;
        if (columnIndex === 0) style = 9;
        else if (columnIndex === 2) style = 8;
        else if (columnIndex === 5) style = 10;
        else if (typeof value === "number") style = [9, 0, 8, 4, 4, 10, 5, 6][columnIndex];
        return cell(column(columnIndex) + (index + 7), value, style);
      }), bodyHeight(values, widths)));
    });
    output.push('</sheetData><autoFilter ref="A6:' + lastColumn + end + '"/><mergeCells count="' + merges.length + '">');
    merges.forEach(function (range) { output.push('<mergeCell ref="' + range + '"/>'); });
    output.push('</mergeCells><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>',
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>');
    return output.join("");
  }

  function styles() {
    function font(size, color, bold) { return '<font>' + (bold ? '<b/>' : '') + '<sz val="' + size + '"/><color rgb="' + color + '"/><name val="Malgun Gothic"/><family val="2"/></font>'; }
    function xf(fontId, fillId, borderId, formatId, align, wrap, indent) {
      return '<xf numFmtId="' + formatId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="' + align + '" vertical="center"' + (wrap ? ' wrapText="1"' : '') + (indent ? ' indent="1"' : '') + '/></xf>';
    }
    return XML_HEAD + '<styleSheet xmlns="' + SHEET_NS + '">'
      + '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="#,##0.0"/><numFmt numFmtId="166" formatCode="0.00%"/></numFmts>'
      + '<fonts count="5">' + font(11, "FF263449", false) + font(15, "FF14283F", true) + font(11, "FFFFFFFF", true) + font(11, "FF687789", false) + font(11, "FF14283F", true) + '</fonts>'
      + '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF14283F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F3F7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF5F8FC"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFE5EAF0"/></bottom><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11">'
      + xf(0, 4, 1, 0, "left", true, true) + xf(1, 0, 0, 0, "left", false) + xf(3, 0, 0, 0, "left", true) + xf(2, 2, 0, 0, "center", true)
      + xf(0, 4, 1, 164, "right", false, true) + xf(0, 4, 1, 165, "right", false, true) + xf(0, 4, 1, 166, "right", false, true) + xf(4, 3, 0, 0, "center", false)
      + xf(4, 5, 1, 164, "right", false, true) + xf(0, 4, 1, 164, "center", false) + xf(0, 4, 1, 0, "center", true)
      + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  }

  function put16(bytes, offset, value) { bytes[offset] = value & 255; bytes[offset + 1] = value >>> 8 & 255; }
  function put32(bytes, offset, value) { put16(bytes, offset, value & 0xffff); put16(bytes, offset + 2, value >>> 16); }

  function zip(parts) {
    var encoder = new TextEncoder(), localSize = 0, centralSize = 0;
    var entries = parts.map(function (part) {
      var name = encoder.encode(part[0]), content = encoder.encode(part[1]);
      var entry = { name: name, content: content, crc: crc32(content), offset: localSize };
      localSize += 30 + name.length + content.length;
      centralSize += 46 + name.length;
      return entry;
    });
    if (localSize + centralSize + 22 > 0xffffffff) invalid("ZIP exceeds the fixed package limit");
    var bytes = new Uint8Array(localSize + centralSize + 22), offset = 0;
    entries.forEach(function (entry) {
      put32(bytes, offset, 0x04034b50); put16(bytes, offset + 4, 20); put16(bytes, offset + 6, 0x0800);
      // Stored method and DOS 1980-01-01 avoid compression dependencies and wall-clock nondeterminism.
      put16(bytes, offset + 8, 0); put16(bytes, offset + 10, 0); put16(bytes, offset + 12, 0x0021);
      put32(bytes, offset + 14, entry.crc); put32(bytes, offset + 18, entry.content.length); put32(bytes, offset + 22, entry.content.length);
      put16(bytes, offset + 26, entry.name.length); put16(bytes, offset + 28, 0);
      bytes.set(entry.name, offset + 30); bytes.set(entry.content, offset + 30 + entry.name.length);
      offset += 30 + entry.name.length + entry.content.length;
    });
    entries.forEach(function (entry) {
      put32(bytes, offset, 0x02014b50); put16(bytes, offset + 4, 20); put16(bytes, offset + 6, 20); put16(bytes, offset + 8, 0x0800);
      put16(bytes, offset + 10, 0); put16(bytes, offset + 12, 0); put16(bytes, offset + 14, 0x0021);
      put32(bytes, offset + 16, entry.crc); put32(bytes, offset + 20, entry.content.length); put32(bytes, offset + 24, entry.content.length);
      put16(bytes, offset + 28, entry.name.length); put32(bytes, offset + 42, entry.offset); bytes.set(entry.name, offset + 46);
      offset += 46 + entry.name.length;
    });
    put32(bytes, offset, 0x06054b50); put16(bytes, offset + 8, entries.length); put16(bytes, offset + 10, entries.length);
    put32(bytes, offset + 12, centralSize); put32(bytes, offset + 16, localSize);
    return bytes;
  }

  function create(input) {
    var data = validate(input);
    return zip([
      ["[Content_Types].xml", XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ["_rels/.rels", XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL_NS + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", XML_HEAD + '<workbook xmlns="' + SHEET_NS + '" xmlns:r="' + REL_NS + '"><bookViews><workbookView/></bookViews><sheets><sheet name="연관 키워드" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL_NS + '/styles" Target="styles.xml"/></Relationships>'],
      ["xl/styles.xml", styles()], ["xl/worksheets/sheet1.xml", worksheet(data)]
    ]);
  }

  window.MomentRelatedKeywordXlsx = Object.freeze({ create: create });
}());
