/*!
 * 모먼트 인사이트 · 개인 캘린더 공유 컴포넌트 (classic script, no modules)
 *
 * 설계 근거: docs/drafts/personal-calendar-rollout-design.md §6.1 (D5).
 *   · public/ 은 통째로 dist/ 로 복사되고 script-src 'self' 라 CSP 해시가 필요 없다.
 *     인라인에 넣으면 캘린더를 고칠 때마다 vercel.json 해시를 갱신해야 한다.
 *   · 마크업까지 이 파일이 그린다. 그래야 페이지가 늘어도 마크업 드리프트가 없다.
 *   · fetch 는 절대 스스로 하지 않는다. 페이지가 자기 miFetch 를 주입한다
 *     (인증 계약 · CSRF 토큰이 페이지에 남아야 check-production-auth 가 검사한다).
 *   · 호출 대상은 언제나 /api/my/* 다. /api/owner/* 는 대표실 전용이라 여기서 부르지 않는다.
 *
 * 아래 표(색 팔레트 · 상태/유형 라벨 · 요일 코드 · 이메일 형식 · 구글 로그인 안내문)는
 * src/pages/admin.html 업무 운영 화면에서 그대로 옮겨 적은 것이다. 두 벌이 어긋나지
 * 않도록 scripts/personal-calendar-ui.test.mjs 가 admin.html 과 서버 표를 읽어 대조한다.
 */
(function () {
  "use strict";

  var VERSION = "cal-v1-20260826";

  // 구글 일정 색 11개. 16진값·한국어 이름·순서는 src/server/google-calendar-client.mjs 의
  // EVENT_COLOR_PALETTE / EVENT_COLOR_DISPLAY_ORDER 와 admin.html 의 workEventColors 를
  // 그대로 옮겨 적은 것이다.
  var EVENT_COLORS = [
    { id: "11", hex: "#d50000", name: "토마토" },
    { id: "4", hex: "#e67c73", name: "플라밍고" },
    { id: "6", hex: "#f4511e", name: "탠저린" },
    { id: "5", hex: "#f6bf26", name: "바나나" },
    { id: "2", hex: "#33b679", name: "세이지" },
    { id: "10", hex: "#0b8043", name: "바질" },
    { id: "7", hex: "#039be5", name: "피콕" },
    { id: "9", hex: "#3f51b5", name: "블루베리" },
    { id: "1", hex: "#7986cb", name: "라벤더" },
    { id: "3", hex: "#8e24aa", name: "포도" },
    { id: "8", hex: "#616161", name: "흑연" }
  ];

  var STATUS_LABELS = {
    planned: "예정",
    in_progress: "진행 중",
    done: "완료",
    paused: "보류",
    needs_check: "확인 필요"
  };

  var TYPE_LABELS = {
    ad_setup: "광고 세팅",
    content_upload: "콘텐츠 업로드",
    distribution: "배포",
    review: "리뷰 작업",
    shooting: "촬영",
    promotion: "프로모션",
    report_due: "보고서",
    meeting: "미팅",
    creative: "소재 제작",
    keyword: "키워드 작업"
  };

  var RECURRENCE_DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  var RECURRENCE_DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
  var RECURRENCE_ORDINAL_NAMES = ["첫 번째", "두 번째", "세 번째", "네 번째", "다섯 번째"];
  var ATTENDEE_LIMIT = 50;
  var EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;.]+(?:\.[^\s@,;.]+)+$/;

  // admin.html googleLoginNotice 와 같은 문구를 쓴다. 문구가 갈리면 같은 실패를
  // 화면마다 다르게 설명하게 된다.
  var LOGIN_NOTICES = {
    unlinked: "연결되지 않은 구글 계정입니다. 먼저 기존 코드로 로그인 후 연결해주세요.",
    "not-ready": "이 계정은 아직 구글 로그인 대상이 아닙니다.",
    cancelled: "구글 로그인이 취소되었습니다.",
    busy: "요청이 많아 잠시 후 다시 시도해주세요.",
    "already-linked": "이 구글 계정은 이미 다른 계정에 연결되어 있습니다.",
    inactive: "이 계정은 현재 사용이 중지되어 있습니다. 관리자에게 문의해주세요."
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 색상은 서버 값을 그대로 style 에 넣지 않는다. 6자리 HEX 만 통과시킨다.
  function gcalColor(value) {
    var color = String(value == null ? "" : value).trim();
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "";
  }

  // 표에 없는 값은 전부 기본값("캘린더 색")으로 되돌린다.
  function eventColorId(value) {
    var id = String(value == null ? "" : value).trim();
    for (var index = 0; index < EVENT_COLORS.length; index += 1) {
      if (EVENT_COLORS[index].id === id) return id;
    }
    return "";
  }

  // 칠하는 순서: 일정에 지정된 색 → 그 일정이 속한 캘린더 색 → 중립 기본값.
  function itemColor(item) {
    return gcalColor(item && item.eventColor) || gcalColor(item && item.calendarColor);
  }

  function itemTextColor(item) {
    if (gcalColor(item && item.eventColor)) return gcalColor(item && item.eventTextColor) || "#ffffff";
    return gcalColor(item && item.calendarTextColor) || "#ffffff";
  }

  function statusLabel(value) {
    return STATUS_LABELS[value] || "예정";
  }

  function typeLabel(value) {
    return TYPE_LABELS[value] || "업무";
  }

  function dateKey(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return "";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function dateFromKey(key) {
    var parts = String(key || "").split("-").map(Number);
    return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  }

  function timeInput(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return "";
    var pad = function (number) { return String(number).padStart(2, "0"); };
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function timeLabel(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ko-KR", {
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function moveDateLabel(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function shiftDateTime(value, targetDateKey) {
    var source = new Date(value);
    var target = dateFromKey(targetDateKey);
    if (isNaN(source.getTime()) || isNaN(target.getTime())) return "";
    target.setHours(source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
    return target.toISOString();
  }

  function parseRecurrence(rules) {
    var list = Array.isArray(rules) ? rules : [];
    var line = "";
    for (var index = 0; index < list.length; index += 1) {
      if (/^RRULE:/i.test(String(list[index] || ""))) {
        line = String(list[index]);
        break;
      }
    }
    if (!line) return null;
    var parts = {};
    line.replace(/^RRULE:/i, "").split(";").forEach(function (chunk) {
      var pair = String(chunk || "").split("=");
      if (pair.length === 2 && pair[0]) parts[pair[0].toUpperCase()] = pair[1];
    });
    return parts.FREQ ? parts : null;
  }

  function syncAgeLabel(value) {
    if (!value) return "동기화 기록 없음";
    var stamp = Date.parse(value);
    if (!isFinite(stamp)) return "동기화 기록 없음";
    var elapsed = Date.now() - stamp;
    if (elapsed < 0) elapsed = 0;
    if (elapsed < 60000) return "마지막 동기화 방금 전";
    if (elapsed < 3600000) return "마지막 동기화 " + Math.floor(elapsed / 60000) + "분 전";
    return "마지막 동기화 " + Math.floor(elapsed / 3600000) + "시간 전";
  }

  function loginNotice(code) {
    return Object.prototype.hasOwnProperty.call(LOGIN_NOTICES, code) ? LOGIN_NOTICES[code] : "";
  }

  function calendarNotice(code) {
    if (!code) return "";
    if (code === "connected") return "구글 캘린더가 연결되었습니다.";
    if (code === "no-refresh-token") return "권한 화면에서 다시 시도해주세요(동의 필요).";
    return "연결에 실패했습니다: " + code;
  }

  // ── 실장 비서 ────────────────────────────────────────────
  // 대표실 owner-assistant(src/pages/admin.html)의 상호작용을 개인 공간으로 옮겨 적었다.
  // 아래 표·정규식은 admin.html 및 src/server/handlers/owner-tool-api.mjs 와 한 벌이어야
  // 하므로 scripts/personal-calendar-ui.test.mjs 가 두 원본을 읽어 대조한다.
  //
  // 일부러 옮기지 않은 것 — 개인 공간에는 계정 경계를 넘는 개념이 없어야 하기 때문이다.
  //   · 광고주 스코프 전환(parseOwnerAssistantScopeCommand · switchOwnerAssistantScope ·
  //     loadOwnerAssistantClients): 다른 계정 일정으로 갈아타는 기능이라 격리 보장 자체와 충돌한다.
  //   · 굿모닝 자동 브리핑(maybeRunOwnerAssistantGoodMorning 과 그 localStorage 플래그): v1 범위 밖.
  //   · 일정 초안 생성(assistant-draft): 대표실 전용 도구 경로에만 있어 여기서는 부를 수 없다.
  //   · 비서실 조직 애니메이션(mi-assistant-office · agents · runOfficeScene): 운영 시각화라 개인 화면에 없다.
  //   · 운영 데이터를 읽는 그 어떤 것도 없다.
  var ASSISTANT_BRIEFING_INTENT = /브리핑|(?:일정|업무)(?:들)?\s*(?:을|를|이|은)?\s*(?:좀|한\s*번|다시|간단히|짧게)?\s*(?:알려|읽어|들려|말해|정리해)/u;

  // 개인 빌드에는 서버 초안 파서가 없다. 완료 명령 해석은 브라우저에서 한다.
  // 정규식은 owner-tool-api.mjs 의 ASSISTANT_COMPLETION_PATTERN 을 그대로 옮겨 적은 것이다.
  var ASSISTANT_COMPLETION_PATTERN = /^(.+?)(?:\s*(?:일정|업무))?(?:\s*(?:은|는|을|를))?\s*완료(?:로|\s*처리)?(?:\s*(?:해\s*줘|해\s*주세요|해줘|해주세요|처리해\s*줘|처리해\s*주세요|해))?\s*[.!?]?$/u;

  // 호출어("실장"). 최종 인식 문장에서만 명령을 떼어 낸다.
  var ASSISTANT_WAKE_PATTERN = /(?:^|[\s,，.!?])실장(?:님|아)?(?:[\s,，.!?]+(.*)|$)/u;
  var ASSISTANT_WAKE_INTERIM_PATTERN = /(?:^|[\s,，.!?])실장(?:님|아)?(?:[\s,，.!?]|$)/u;

  var ASSISTANT_RANGE_LABELS = { today: "오늘", tomorrow: "내일", day_after: "모레", this_week: "이번 주", next_week: "다음 주", upcoming: "다가오는" };
  var ASSISTANT_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function assistantBriefingIntent(prompt) {
    return ASSISTANT_BRIEFING_INTENT.test(String(prompt || ""));
  }

  function parseAssistantBriefingRange(text) {
    var text2 = String(text || "");
    if (/다음\s*주/u.test(text2)) return "next_week";
    if (/이번\s*주/u.test(text2)) return "this_week";
    if (/모레/u.test(text2)) return "day_after";
    if (/내일/u.test(text2)) return "tomorrow";
    if (/다가오는|앞으로|향후/u.test(text2)) return "upcoming";
    return "today";
  }

  function parseAssistantCompletion(segment) {
    var text = String(segment == null ? "" : segment).trim();
    if (!text || text.indexOf("완료") === -1) return "";
    var match = text.match(ASSISTANT_COMPLETION_PATTERN);
    var query = match ? String(match[1] || "").replace(/\s+/gu, " ").trim() : "";
    if (!query || query.indexOf("완료") !== -1) return "";
    return query.slice(0, 120);
  }

  // 대표실은 workDateKey 를 썼다. 여기서는 이 파일의 dateKey 를 그대로 쓴다.
  function assistantRangeWindow(rangeKey, now) {
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var end = new Date(start);
    if (rangeKey === "tomorrow") { start.setDate(start.getDate() + 1); end = new Date(start); }
    else if (rangeKey === "day_after") { start.setDate(start.getDate() + 2); end = new Date(start); }
    else if (rangeKey === "this_week") { end.setDate(start.getDate() + (6 - ((start.getDay() + 6) % 7))); }
    else if (rangeKey === "next_week") { start.setDate(start.getDate() + (7 - ((start.getDay() + 6) % 7))); end = new Date(start); end.setDate(start.getDate() + 6); }
    else if (rangeKey === "upcoming") { start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 7); }
    return { startKey: dateKey(start), endKey: dateKey(end) };
  }

  function assistantSpokenWhen(item) {
    var date = new Date(item.startsAt);
    if (isNaN(date.getTime())) return "";
    var label = (date.getMonth() + 1) + "월 " + date.getDate() + "일 " + ASSISTANT_WEEKDAYS[date.getDay()] + "요일";
    if (!item.isAllDay) {
      var hours = date.getHours();
      var minutes = date.getMinutes();
      label += " " + (hours < 12 ? "오전 " + (hours === 0 ? 12 : hours) : "오후 " + (hours === 12 ? 12 : hours - 12)) + "시";
      if (minutes) label += " " + minutes + "분";
    }
    return label;
  }

  // 브리핑 문장은 언제나 화면에 이미 있는 행에서 만든다. 새 조회를 하지 않는다.
  function buildAssistantBriefingSpeech(rangeKey, sourceItems) {
    var label = ASSISTANT_RANGE_LABELS[rangeKey] || "오늘";
    var range = assistantRangeWindow(rangeKey, new Date());
    var list = (Array.isArray(sourceItems) ? sourceItems : []).filter(function (item) {
      if (!item || item.status === "done") return false;
      var key = dateKey(item.startsAt);
      return Boolean(key) && key >= range.startKey && key <= range.endKey;
    }).sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); }).slice(0, 8);
    if (!list.length) return { label: label, text: label + " 일정이 없습니다." };
    var lines = list.map(function (item) { return assistantSpokenWhen(item) + " " + (item.title || "제목 없는 업무"); });
    return { label: label, text: label + " 일정은 " + lines.join(", ") + "입니다." };
  }

  // 상시 대기 토글은 계정마다 따로 기억한다. 공용 키로 떨어지면 한 브라우저에서
  // 번갈아 로그인한 두 계정이 서로의 토글을 물려받는다 — 그 자체가 격리 구멍이다.
  function assistantStandbyKey(accountTag) {
    var tag = String(accountTag == null ? "" : accountTag).trim();
    return tag ? "mi-personal-assistant-standby:" + tag : "";
  }

  // 개인 캘린더는 언제나 /api/my/* 를 부른다. 로컬 개발에서만 dev 서버 포트로 간다.
  function apiOrigin() {
    var host = window.location && window.location.hostname;
    if (host && host !== "127.0.0.1" && host !== "localhost") return window.location.origin;
    return "http://127.0.0.1:8790";
  }

  function markupHtml() {
    return [
      '<div class="mi-cal-shell">',
      '<header class="mi-cal-head">',
      '<div class="mi-cal-head-copy">',
      '<span class="mi-cal-kicker">MY CALENDAR</span>',
      '<h1>내 캘린더</h1>',
      '<p>나만 보는 일정 공간입니다. 구글 캘린더를 연결하면 양방향으로 동기화됩니다.</p>',
      '</div>',
      '<div class="mi-cal-head-actions">',
      '<button class="mi-cal-drawer" type="button" data-cal-rail-drawer aria-expanded="false" aria-controls="mi-cal-rail" hidden>캘린더</button>',
      '<button class="mi-cal-button" type="button" data-cal-today>오늘</button>',
      '<button class="mi-cal-button is-primary" type="button" data-cal-create>일정 추가</button>',
      '</div>',
      '</header>',

      '<section class="mi-cal-banner" data-cal-glogin-banner hidden aria-label="구글 로그인 연결">',
      '<div class="mi-cal-banner-copy"><strong>구글 로그인</strong><span data-cal-glogin-status>연결 상태를 확인하는 중입니다.</span></div>',
      '<div class="mi-cal-banner-actions">',
      '<span class="mi-cal-badge" data-cal-glogin-badge hidden>연결됨</span>',
      '<button class="mi-cal-button" type="button" data-cal-glogin-link hidden>구글 계정 연결</button>',
      '<button class="mi-cal-button" type="button" data-cal-glogin-unlink hidden>연결 해제</button>',
      '</div>',
      '</section>',

      '<section class="mi-cal-banner" data-cal-gcal-banner hidden aria-label="구글 캘린더 연동">',
      '<div class="mi-cal-banner-copy"><strong>구글 캘린더</strong><span data-cal-gcal-status>연동 상태를 확인하는 중입니다.</span>',
      '<small data-cal-gcal-last hidden></small></div>',
      '<div class="mi-cal-banner-actions">',
      '<span class="mi-cal-badge" data-cal-gcal-badge hidden>연결됨</span>',
      '<button class="mi-cal-button" type="button" data-cal-gcal-sync hidden>지금 동기화</button>',
      '<button class="mi-cal-button is-primary" type="button" data-cal-gcal-connect hidden>구글 캘린더 연결</button>',
      '<button class="mi-cal-button" type="button" data-cal-gcal-disconnect hidden>연동 해제</button>',
      '</div>',
      '</section>',

      '<section class="mi-cal-assistant" data-cal-assistant aria-label="실장 비서">',
      '<div class="mi-cal-assistant-head">',
      '<div class="mi-cal-assistant-head-copy"><span class="mi-cal-kicker">Assistant</span><h2>실장 비서</h2>',
      '<p>내 일정만 보고 브리핑하고 완료 처리합니다. 다른 계정의 일정은 보지 않습니다.</p></div>',
      '<span class="mi-cal-badge">내 일정 전용</span>',
      '</div>',
      '<div class="mi-cal-assistant-briefing" data-cal-assistant-briefing>',
      '<div class="mi-cal-assistant-metrics" role="group" aria-label="오늘 일정 요약">',
      '<div class="mi-cal-assistant-metric"><span>오늘</span><strong data-cal-assistant-metric="today">0</strong></div>',
      '<div class="mi-cal-assistant-metric"><span>지연</span><strong data-cal-assistant-metric="overdue">0</strong></div>',
      '<div class="mi-cal-assistant-metric"><span>확인 필요</span><strong data-cal-assistant-metric="needs_check">0</strong></div>',
      '<div class="mi-cal-assistant-metric"><span>다가오는</span><strong data-cal-assistant-metric="next">0</strong></div>',
      '</div>',
      '<div class="mi-cal-assistant-agenda" data-cal-assistant-agenda></div>',
      '</div>',
      '<div class="mi-cal-assistant-voice">',
      '<button class="mi-cal-assistant-voice-button" type="button" data-cal-assistant-mic aria-label="음성으로 입력하기"><span aria-hidden="true">🎤</span><span>말하기</span></button>',
      '<button class="mi-cal-assistant-voice-button" type="button" data-cal-assistant-wake aria-pressed="false" aria-label="실장 상시 호출 켜고 끄기" disabled><span aria-hidden="true">🎙</span><span>상시 호출</span></button>',
      '<button class="mi-cal-assistant-voice-button" type="button" data-cal-assistant-read aria-label="브리핑 소리로 듣기"><span aria-hidden="true">🔊</span><span>브리핑 읽기</span></button>',
      '<span class="mi-cal-assistant-voice-status" data-cal-assistant-voice-status aria-live="polite">‘실장’이라고 부른 뒤 명령을 말하거나, 아래 입력창에 그대로 적어주세요.</span>',
      '</div>',
      '<div class="mi-cal-assistant-compose">',
      '<textarea class="mi-cal-input mi-cal-assistant-input" data-cal-assistant-input maxlength="2000" rows="2" aria-label="실장에게 보낼 명령" placeholder="예: 다음 주 일정 알려줘 · 광고주 미팅 완료로 해줘"></textarea>',
      '<button class="mi-cal-button is-primary" type="button" data-cal-assistant-send>보내기</button>',
      '</div>',
      '<div class="mi-cal-assistant-status" data-cal-assistant-status aria-live="polite">브리핑과 완료 처리는 내 일정에서 바로 하고, 자유 대화만 실장 AI로 전달합니다.</div>',
      '<div class="mi-cal-assistant-results" data-cal-assistant-results><div class="mi-cal-assistant-empty">실장에게 오늘 일정을 물어보세요.</div></div>',
      '</section>',

      '<div class="mi-cal-summary" aria-label="내 일정 필터">',
      '<button class="mi-cal-summary-button" type="button" data-cal-summary-filter="today" aria-pressed="false"><span>오늘 일정</span><strong data-cal-summary-today>0</strong><small>오늘 처리할 일정</small></button>',
      '<button class="mi-cal-summary-button" type="button" data-cal-summary-filter="overdue" aria-pressed="false"><span>지연 일정</span><strong data-cal-summary-overdue>0</strong><small>기한이 지난 미완료 일정</small></button>',
      '<button class="mi-cal-summary-button" type="button" data-cal-summary-filter="needs_check" aria-pressed="false"><span>확인 필요</span><strong data-cal-summary-check>0</strong><small>검토가 필요한 일정</small></button>',
      '</div>',

      '<div class="mi-cal-body" data-cal-body>',
      '<div class="mi-cal-side">',
      '<aside class="mi-cal-rail" id="mi-cal-rail" data-cal-rail hidden aria-label="캘린더 목록">',
      '<div class="mi-cal-rail-head">',
      '<div><span class="mi-cal-kicker">Calendars</span><h2>캘린더</h2></div>',
      '<button class="mi-cal-rail-refresh" type="button" data-cal-rail-refresh aria-label="구글 캘린더 목록 새로고침">새로고침</button>',
      '</div>',
      '<div class="mi-cal-rail-list" data-cal-rail-list></div>',
      '<p class="mi-cal-rail-note" data-cal-rail-note hidden></p>',
      '<div class="mi-cal-panel" data-cal-acl-panel hidden>',
      '<strong data-cal-acl-title>참가자 관리</strong>',
      '<div class="mi-cal-rules" data-cal-acl-rules aria-live="polite"></div>',
      '<label><span>참가자 이메일</span><input class="mi-cal-input" type="text" data-cal-acl-email maxlength="320" placeholder="name@example.com" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>',
      '<label><span>권한</span><select class="mi-cal-select" data-cal-acl-role><option value="writer">편집 가능</option><option value="reader">보기만</option></select></label>',
      '<div class="mi-cal-panel-actions"><button type="button" data-cal-acl-close>닫기</button><button type="button" class="is-primary" data-cal-acl-add>추가</button></div>',
      '</div>',
      '<button class="mi-cal-rail-new" type="button" data-cal-rail-new aria-expanded="false" aria-controls="mi-cal-new-form" hidden>＋ 새 캘린더 만들기</button>',
      '<div class="mi-cal-panel" id="mi-cal-new-form" data-cal-new-form hidden>',
      '<label><span>이름</span><input class="mi-cal-input" type="text" data-cal-new-name maxlength="120" placeholder="새 캘린더 이름" /></label>',
      '<div class="mi-cal-chips" data-cal-invite-chips aria-live="polite"></div>',
      '<label><span>참가자 이메일</span><input class="mi-cal-input" type="text" data-cal-invite-input maxlength="320" placeholder="이메일 입력 후 Enter" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>',
      '<label><span>권한</span><select class="mi-cal-select" data-cal-invite-role><option value="writer">편집 가능</option><option value="reader">보기만</option></select></label>',
      '<div class="mi-cal-panel-actions"><button type="button" data-cal-new-cancel>취소</button><button type="button" class="is-primary" data-cal-create-calendar>만들기</button></div>',
      '</div>',
      '</aside>',

      '<aside class="mi-cal-agenda-card">',
      '<div class="mi-cal-agenda-head">',
      '<div><span class="mi-cal-kicker">Agenda</span><h2 data-cal-agenda-title>가까운 일정</h2></div>',
      '<div class="mi-cal-agenda-tools"><button class="mi-cal-filter-clear" type="button" data-cal-filter-clear hidden>전체</button><span class="mi-cal-badge" data-cal-count>0개</span></div>',
      '</div>',
      '<div class="mi-cal-agenda" data-cal-agenda></div>',
      '</aside>',
      '</div>',

      '<div class="mi-cal-layout">',
      '<article class="mi-cal-calendar-card">',
      '<div class="mi-cal-calendar-head">',
      '<div class="mi-cal-month-nav">',
      '<button class="mi-cal-icon-button" type="button" data-cal-month-prev aria-label="이전 달">‹</button>',
      '<button class="mi-cal-month-trigger" type="button" data-cal-month-picker-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="mi-cal-month-picker"><span data-cal-month-label>이번 달</span><small aria-hidden="true">⌄</small></button>',
      '<button class="mi-cal-icon-button" type="button" data-cal-month-next aria-label="다음 달">›</button>',
      '<div class="mi-cal-month-picker" id="mi-cal-month-picker" data-cal-month-picker role="dialog" aria-label="이동할 월 선택" hidden>',
      '<div class="mi-cal-picker-head">',
      '<button class="mi-cal-icon-button" type="button" data-cal-picker-year-prev aria-label="이전 연도">‹</button>',
      '<strong data-cal-month-picker-year aria-live="polite"></strong>',
      '<button class="mi-cal-icon-button" type="button" data-cal-picker-year-next aria-label="다음 연도">›</button>',
      '</div>',
      '<div class="mi-cal-month-grid" data-cal-month-grid></div>',
      '<button class="mi-cal-picker-cancel" type="button" data-cal-picker-cancel>취소</button>',
      '</div>',
      '</div>',
      '<div class="mi-cal-calendar-tools"><span class="mi-cal-drag-note">일정을 길게 눌러 날짜 이동</span><span class="mi-cal-badge">월간 캘린더</span></div>',
      '</div>',
      '<div class="mi-cal-weekdays" aria-hidden="true"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>',
      '<div class="mi-cal-calendar" data-cal-calendar aria-label="월간 개인 일정"></div>',
      '</article>',
      '</div>',
      '</div>',

      '<div class="mi-cal-status" data-cal-status>내 일정을 불러올 준비가 되었습니다.</div>',

      '<div class="mi-cal-modal" data-cal-modal hidden>',
      '<div class="mi-cal-dialog mi-cal-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="mi-cal-dialog-title">',
      '<div class="mi-cal-dialog-head">',
      '<div class="mi-cal-dialog-title"><span class="mi-cal-dialog-eyebrow">MY SCHEDULE</span><h2 id="mi-cal-dialog-title" data-cal-dialog-title>개인 일정 등록</h2><p>필요한 정보만 입력하면 내 캘린더와 가까운 일정에 함께 반영됩니다.</p></div>',
      '<button class="mi-cal-icon-button" type="button" data-cal-close aria-label="닫기">×</button>',
      '</div>',
      '<form data-cal-form>',
      '<div class="mi-cal-form">',
      '<input type="hidden" data-cal-id />',
      '<input type="hidden" data-cal-updated-at />',
      '<div class="mi-cal-title-field"><input class="mi-cal-input mi-cal-title-input" data-cal-title maxlength="120" required placeholder="제목 추가" aria-label="일정 제목" /></div>',

      '<div class="mi-cal-kind">',
      '<div class="mi-cal-kind-tabs" role="tablist" aria-label="등록 유형">',
      '<button class="mi-cal-kind-tab is-active" type="button" role="tab" aria-selected="true" data-cal-kind-tab="event">일정</button>',
      '<button class="mi-cal-kind-tab" type="button" role="tab" aria-selected="false" aria-disabled="true" disabled data-cal-kind-tab="task" title="다음 단계: 구글 할 일 연동 후">할 일</button>',
      '</div>',
      '<small class="mi-cal-kind-note" data-cal-task-note>다음 단계: 구글 할 일 연동 후</small>',
      '</div>',

      '<div class="mi-cal-when" data-cal-when>',
      '<div class="mi-cal-form-grid mi-cal-when-row">',
      '<label class="mi-cal-field"><span data-cal-start-label>시작 날짜</span><input class="mi-cal-input" type="date" data-cal-start required /></label>',
      '<label class="mi-cal-field" data-cal-start-time-field hidden><span>시작 시간</span><input class="mi-cal-input" type="time" data-cal-start-time /></label>',
      '<label class="mi-cal-field"><span data-cal-end-label>종료 날짜</span><input class="mi-cal-input" type="date" data-cal-end /></label>',
      '<label class="mi-cal-field" data-cal-end-time-field hidden><span>종료 시간</span><input class="mi-cal-input" type="time" data-cal-end-time /></label>',
      '</div>',
      '<div class="mi-cal-when-actions">',
      '<button class="mi-cal-link-button mi-cal-time-toggle" type="button" data-cal-time-toggle aria-expanded="false">시간 추가</button>',
      '<input class="mi-cal-hidden-state" type="checkbox" data-cal-all-day checked hidden aria-hidden="true" tabindex="-1" />',
      '</div>',
      '</div>',

      '<label class="mi-cal-field is-full" data-cal-google-only data-cal-recurrence-field hidden><span>반복</span>',
      '<select class="mi-cal-select" data-cal-recurrence-preset>',
      '<option value="none">반복 안함</option>',
      '<option value="daily">매일</option>',
      '<option value="weekly" data-cal-recurrence-option="weekly">매주</option>',
      '<option value="monthly_day" data-cal-recurrence-option="monthly_day">매월</option>',
      '<option value="monthly_nth" data-cal-recurrence-option="monthly_nth">매월 n번째 요일</option>',
      '<option value="yearly">매년</option>',
      '<option value="weekday">주중 매일(월~금)</option>',
      '<option value="custom">맞춤…</option>',
      '</select></label>',

      '<div class="mi-cal-modal" data-cal-recurrence-modal hidden>',
      '<div class="mi-cal-dialog mi-cal-recurrence-dialog" role="dialog" aria-modal="true" aria-labelledby="mi-cal-recurrence-title">',
      '<div class="mi-cal-dialog-head"><div class="mi-cal-dialog-title"><span class="mi-cal-dialog-eyebrow">CUSTOM RECURRENCE</span><h2 id="mi-cal-recurrence-title">맞춤 반복</h2></div>',
      '<button class="mi-cal-icon-button" type="button" data-cal-recurrence-cancel aria-label="닫기">×</button></div>',
      '<div class="mi-cal-repeat-fields" data-cal-google-only data-cal-recurrence-custom aria-live="polite" hidden>',
      '<div class="mi-cal-recurrence-every">',
      '<label class="mi-cal-field"><span>반복 주기</span><input class="mi-cal-input" type="number" min="1" max="366" step="1" value="1" data-cal-recurrence-interval /></label>',
      '<label class="mi-cal-field"><span>단위</span><select class="mi-cal-select" data-cal-recurrence-unit><option value="DAILY">일</option><option value="WEEKLY" selected>주</option><option value="MONTHLY">개월</option><option value="YEARLY">년</option></select></label>',
      '</div>',
      '<div class="mi-cal-weekday-picker" data-cal-recurrence-days role="group" aria-label="반복 요일" hidden>',
      RECURRENCE_DAY_CODES.map(function (code, index) {
        return '<label class="mi-cal-weekday"><input type="checkbox" data-cal-recurrence-day="' + code + '" /><i>' + RECURRENCE_DAY_NAMES[index] + '</i></label>';
      }).join(""),
      '</div>',
      '<label class="mi-cal-field" data-cal-recurrence-monthly-field hidden><span>매월 기준</span>',
      '<select class="mi-cal-select" data-cal-recurrence-monthly-mode>',
      '<option value="bymonthday" data-cal-recurrence-monthly-option="bymonthday">매월 N일</option>',
      '<option value="byday" data-cal-recurrence-monthly-option="byday">매월 N번째 X요일</option>',
      '</select></label>',
      '<div class="mi-cal-recurrence-ends" role="radiogroup" aria-label="반복 종료">',
      '<span class="mi-cal-recurrence-ends-title">종료</span>',
      '<div class="mi-cal-recurrence-end-row"><label><input type="radio" name="mi-cal-recurrence-end-choice" value="never" data-cal-recurrence-end-choice checked /><span>없음</span></label></div>',
      '<div class="mi-cal-recurrence-end-row"><label><input type="radio" name="mi-cal-recurrence-end-choice" value="until" data-cal-recurrence-end-choice /><span>날짜</span></label>',
      '<label class="mi-cal-field" data-cal-recurrence-until-field hidden><span>반복 종료일 · 포함</span><input class="mi-cal-input" type="date" data-cal-recurrence-until /></label></div>',
      '<div class="mi-cal-recurrence-end-row"><label><input type="radio" name="mi-cal-recurrence-end-choice" value="count" data-cal-recurrence-end-choice /><span>다음 N회 반복</span></label>',
      '<label class="mi-cal-field" data-cal-recurrence-count-field hidden><span>반복 횟수</span><input class="mi-cal-input" type="number" min="1" max="730" step="1" value="10" data-cal-recurrence-count /></label></div>',
      '</div>',
      '<label class="mi-cal-field mi-cal-hidden-state"><span>반복 종료</span><select class="mi-cal-select" data-cal-recurrence-end><option value="never">없음</option><option value="until">날짜</option><option value="count">횟수</option></select></label>',
      '</div>',
      '<div class="mi-cal-dialog-actions"><span class="mi-cal-drag-note">반복 규칙은 완료를 눌러야 반영됩니다.</span>',
      '<div><button class="mi-cal-link-button" type="button" data-cal-recurrence-cancel>취소</button><button class="mi-cal-link-button is-primary" type="button" data-cal-recurrence-done>완료</button></div></div>',
      '</div>',
      '</div>',

      '<div class="mi-cal-repeat-fields" data-cal-google-only data-cal-recurrence-scope-wrap hidden>',
      '<p class="mi-cal-repeat-note" data-cal-recurrence-summary>반복 일정입니다.</p>',
      '<p class="mi-cal-repeat-note">저장하거나 삭제할 때 이 일정만 바꿀지 모든 일정을 바꿀지 물어봅니다.</p>',
      '</div>',

      '<div class="mi-cal-disclosure" data-cal-google-only hidden>',
      '<button class="mi-cal-disclosure-row" type="button" data-cal-expand="attendees" aria-expanded="false" aria-controls="mi-cal-attendees"><i aria-hidden="true">＋</i><span>참석자 추가</span></button>',
      '<div class="mi-cal-disclosure-body" id="mi-cal-attendees" data-cal-panel="attendees" hidden>',
      '<div class="mi-cal-chips" data-cal-attendee-chips aria-live="polite"></div>',
      '<input class="mi-cal-input" type="text" data-cal-attendee-input maxlength="320" placeholder="이메일 입력 후 Enter" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="참석자 이메일" />',
      '<p class="mi-cal-repeat-note is-warn" data-cal-attendee-error role="alert" hidden></p>',
      '<label class="mi-cal-toggle"><span><strong>초대 메일 보내기</strong><small>참석자에게 구글 초대 메일을 보냅니다.</small></span>',
      '<span class="mi-cal-switch"><input type="checkbox" data-cal-send-updates checked /><i aria-hidden="true"></i></span></label>',
      '</div>',
      '</div>',

      '<label class="mi-cal-toggle" data-cal-google-only data-cal-conference-wrap hidden>',
      '<span><strong>Google Meet 화상 회의 추가</strong><small>저장할 때 회의 링크를 만듭니다.</small></span>',
      '<span class="mi-cal-switch"><input type="checkbox" data-cal-conference /><i aria-hidden="true"></i></span></label>',
      '<p class="mi-cal-conference-link" data-cal-conference-link hidden><a href="https://meet.google.com/" target="_blank" rel="noopener" data-cal-conference-url>Google Meet 회의 참여</a></p>',

      '<div class="mi-cal-disclosure" data-cal-google-only hidden>',
      '<button class="mi-cal-disclosure-row" type="button" data-cal-expand="location" aria-expanded="false" aria-controls="mi-cal-location"><i aria-hidden="true">＋</i><span>위치 추가</span></button>',
      '<div class="mi-cal-disclosure-body" id="mi-cal-location" data-cal-panel="location" hidden>',
      '<input class="mi-cal-input" data-cal-location maxlength="500" placeholder="장소 또는 주소" aria-label="위치" />',
      '</div></div>',

      '<div class="mi-cal-disclosure" data-cal-google-only hidden>',
      '<button class="mi-cal-disclosure-row" type="button" data-cal-expand="description" aria-expanded="false" aria-controls="mi-cal-description"><i aria-hidden="true">＋</i><span>설명 추가</span></button>',
      '<div class="mi-cal-disclosure-body" id="mi-cal-description" data-cal-panel="description" hidden>',
      '<textarea class="mi-cal-textarea" data-cal-description maxlength="4000" placeholder="참석자와 공유할 설명" aria-label="설명"></textarea>',
      '</div></div>',

      '<label class="mi-cal-field is-full" data-cal-google-only data-cal-google-calendar-field hidden><span>캘린더</span>',
      '<span class="mi-cal-pick"><select class="mi-cal-select" data-cal-google-calendar></select><i class="mi-cal-dot" data-cal-google-calendar-dot aria-hidden="true"></i></span></label>',

      '<div class="mi-cal-field is-full" data-cal-google-only data-cal-swatch-field hidden><span>색</span>',
      '<div class="mi-cal-swatches" role="group" aria-label="일정 색" data-cal-swatches></div></div>',

      '<p class="mi-cal-repeat-note mi-cal-readonly-note" data-cal-readonly hidden></p>',

      '<label class="mi-cal-field is-full"><span>상태</span>',
      '<select class="mi-cal-select" data-cal-state required>',
      '<option value="planned">예정</option>',
      '<option value="in_progress">진행 중</option>',
      '<option value="done">완료</option>',
      '<option value="paused">보류</option>',
      '<option value="needs_check">확인 필요</option>',
      '</select></label>',

      '<details class="mi-cal-advanced" data-cal-advanced>',
      '<summary>상세 설정 · 필요할 때만 입력</summary>',
      '<div class="mi-cal-form-grid mi-cal-advanced-grid">',
      '<label class="mi-cal-field"><span>일정 유형</span><select class="mi-cal-select" data-cal-type required>',
      Object.keys(TYPE_LABELS).map(function (key) {
        return '<option value="' + key + '">' + escapeHtml(TYPE_LABELS[key]) + '</option>';
      }).join(""),
      '</select></label>',
      '<label class="mi-cal-field"><span>담당자</span><input class="mi-cal-input" data-cal-assignee maxlength="60" placeholder="담당자명" /></label>',
      '<label class="mi-cal-field"><span>우선순위</span><select class="mi-cal-select" data-cal-priority><option value="high">높음</option><option value="medium" selected>보통</option><option value="low">낮음</option></select></label>',
      '<label class="mi-cal-field is-full"><span>내부 메모 · 나만 보기</span><textarea class="mi-cal-textarea" data-cal-internal maxlength="4000" placeholder="나만 확인할 실행 기준과 메모"></textarea></label>',
      '</div></details>',

      '</div>',
      '<div class="mi-cal-status mi-cal-dialog-status" data-cal-dialog-status role="status" aria-live="polite" hidden></div>',
      '<div class="mi-cal-dialog-actions">',
      '<button class="mi-cal-link-button is-danger" type="button" data-cal-delete hidden>삭제</button>',
      '<div><button class="mi-cal-link-button" type="button" data-cal-close>취소</button><button class="mi-cal-link-button is-primary" type="submit" data-cal-save>저장</button></div>',
      '</div>',
      '</form>',
      '</div>',
      '</div>',

      '<div class="mi-cal-modal" data-cal-move-modal hidden>',
      '<div class="mi-cal-dialog mi-cal-move-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mi-cal-move-title" aria-describedby="mi-cal-move-description">',
      '<div class="mi-cal-dialog-head"><div><span class="mi-cal-kicker">Schedule change</span><h2 id="mi-cal-move-title">일정을 변경할까요?</h2></div>',
      '<button class="mi-cal-icon-button" type="button" data-cal-move-cancel aria-label="닫기">×</button></div>',
      '<div class="mi-cal-move-body">',
      '<p id="mi-cal-move-description"><strong data-cal-move-item>선택 일정</strong>의 날짜를 아래와 같이 변경합니다.</p>',
      '<div class="mi-cal-move-dates" aria-label="일정 변경 전후">',
      '<div class="mi-cal-move-date"><span>기존 일정</span><strong data-cal-move-from>-</strong></div>',
      '<span class="mi-cal-move-arrow" aria-hidden="true">→</span>',
      '<div class="mi-cal-move-date"><span>변경 일정</span><strong data-cal-move-to>-</strong></div>',
      '</div></div>',
      '<div class="mi-cal-dialog-actions"><span class="mi-cal-drag-note">확인 후에만 저장됩니다.</span>',
      '<div><button class="mi-cal-link-button" type="button" data-cal-move-cancel>취소</button><button class="mi-cal-link-button is-primary" type="button" data-cal-move-confirm>일정 변경</button></div></div>',
      '</div></div>',

      '<div class="mi-cal-modal" data-cal-scope-modal hidden>',
      '<div class="mi-cal-dialog mi-cal-move-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mi-cal-scope-title" aria-describedby="mi-cal-scope-description">',
      '<div class="mi-cal-dialog-head"><div><span class="mi-cal-kicker">Recurring event</span><h2 id="mi-cal-scope-title" data-cal-scope-title>반복 일정 수정</h2></div>',
      '<button class="mi-cal-icon-button" type="button" data-cal-scope-cancel aria-label="닫기">×</button></div>',
      '<div class="mi-cal-move-body">',
      '<p id="mi-cal-scope-description" data-cal-scope-description>반복되는 일정입니다. 어디까지 적용할까요?</p>',
      '<div class="mi-cal-scope-choices" role="radiogroup" aria-label="반복 일정 적용 범위">',
      '<label class="mi-cal-scope-choice"><input type="radio" name="mi-cal-recurrence-scope" value="instance" data-cal-recurrence-scope checked /><span>이 일정만</span></label>',
      '<label class="mi-cal-scope-choice"><input type="radio" name="mi-cal-recurrence-scope" value="all" data-cal-recurrence-scope /><span>모든 일정</span></label>',
      '</div></div>',
      '<div class="mi-cal-dialog-actions"><span class="mi-cal-drag-note">확인을 눌러야 반영됩니다.</span>',
      '<div><button class="mi-cal-link-button" type="button" data-cal-scope-cancel>취소</button><button class="mi-cal-link-button is-primary" type="button" data-cal-scope-confirm>확인</button></div></div>',
      '</div></div>',

      '</div>'
    ].join("");
  }

  function mount(node, options) {
    if (!node || typeof node.querySelector !== "function") throw new Error("mount 대상 노드가 필요합니다.");
    var config = options || {};
    var apiBase = String(config.apiBase || "/api/my");
    var role = String(config.role || "");
    var doFetch = typeof config.fetch === "function" ? config.fetch : null;
    if (!doFetch) throw new Error("페이지의 fetch 구현을 주입해야 합니다.");

    var destroyed = false;
    var items = [];
    var googleCalendars = [];
    var calendarCatalog = [];
    var canManageCalendars = role !== "client";
    var requestGeneration = 0;
    var monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    var monthPickerYear = monthCursor.getFullYear();
    var draggingId = "";
    var pointerDrag = null;
    var pointerTimer = 0;
    var movePending = null;
    var ignoreClickUntil = 0;
    var activeFilter = "";
    var agendaDateKey = "";
    var dialogReturnFocus = null;
    var railCollapsed = { own: false, other: false };
    var railBusy = false;
    var inviteDraft = [];
    var aclId = "";
    var aclRules = [];
    var attendeeDraft = [];
    var eventColorDraft = "";
    var recurrenceSnapshotBeforeEdit = null;
    var dialogRecurringInstance = false;
    var scopeMode = "";
    var gcalState = { configured: false, storageReady: true, connected: false };
    var gcalSyncing = false;
    var gcalPendingNotice = "";
    var gloginPendingNotice = "";
    var syncInFlight = false;
    var lastAutoSyncAt = 0;
    var windowListeners = [];
    var assistantChatHistory = [];
    var assistantAccountTag = "";
    var assistantChatReady = false;
    var assistantBriefingRange = "today";
    var assistantSpeechOwned = false;
    var assistantVoice = null;

    node.innerHTML = markupHtml();

    function on(target, type, handler, options2) {
      target.addEventListener(type, handler, options2);
      windowListeners.push([target, type, handler, options2]);
    }

    function el(selector) {
      return node.querySelector(selector);
    }

    function value(selector) {
      var found = el(selector);
      return found ? found.value : "";
    }

    function setValue(selector, next) {
      var found = el(selector);
      if (found) found.value = next == null ? "" : next;
    }

    function apiUrl(suffix) {
      return apiOrigin() + apiBase + suffix;
    }

    async function readPayload(response, fallbackMessage) {
      var text = await response.text().catch(function () { return ""; });
      var payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (error) {
        var preview = text ? String(text).replace(/\s+/g, " ").slice(0, 90) : "응답 없음";
        return { ok: false, message: fallbackMessage + " HTTP " + response.status + " / JSON 아님: " + preview };
      }
      if (!payload) payload = { ok: false, message: fallbackMessage + " HTTP " + response.status };
      if (!response.ok && payload.ok !== false) payload.ok = false;
      return payload;
    }

    // ── 상태줄 ──────────────────────────────────────────────
    function setDialogStatus(message, state) {
      var dialogNode = el("[data-cal-dialog-status]");
      if (!dialogNode) return;
      dialogNode.textContent = message || "";
      dialogNode.hidden = !message;
      dialogNode.classList.toggle("is-ok", Boolean(message) && state === "ok");
      dialogNode.classList.toggle("is-warn", Boolean(message) && state === "warn");
    }

    function setStatus(message, state) {
      var modal = el("[data-cal-modal]");
      if (modal && !modal.hidden) setDialogStatus(message, state);
      var status = el("[data-cal-status]");
      if (!status) return;
      status.textContent = message || "";
      status.classList.toggle("is-ok", state === "ok");
      status.classList.toggle("is-warn", state === "warn");
    }

    function setRailNote(message) {
      var note = el("[data-cal-rail-note]");
      if (!note) return;
      var text = String(message || "").trim();
      note.textContent = text;
      note.hidden = !text;
    }

    // ── 데이터 헬퍼 ──────────────────────────────────────────
    function googleConnected() {
      return googleCalendars.length > 0;
    }

    function catalogEntry(id) {
      var key = String(id || "");
      if (!key) return null;
      for (var index = 0; index < calendarCatalog.length; index += 1) {
        var entry = calendarCatalog[index] || {};
        if (String(entry.id || "") === key) return entry;
      }
      return null;
    }

    function calendarVisible(item) {
      if (!item) return true;
      var entry = catalogEntry(item.googleCalendarId);
      if (!entry) return true;
      return entry.visible !== false;
    }

    function canEdit(item) {
      return Boolean(item) && item.readOnly !== true;
    }

    function needsAction(item) {
      return item && (item.status === "planned" || item.status === "in_progress" || item.status === "needs_check");
    }

    function matchesFilter(item, filter) {
      if (!filter) return true;
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      if (filter === "today") return needsAction(item) && dateKey(item.startsAt) === dateKey(today);
      if (filter === "overdue") return needsAction(item) && new Date(item.startsAt).getTime() < today.getTime();
      if (filter === "needs_check") return item.status === "needs_check";
      return true;
    }

    function visibleItems() {
      return items.filter(function (item) { return calendarVisible(item); });
    }

    function filteredItems() {
      return items.filter(function (item) { return matchesFilter(item, activeFilter) && calendarVisible(item); });
    }

    function itemPayload(item, overrides) {
      var next = Object.assign({}, item || {}, overrides || {});
      var base = {
        id: next.id || "",
        title: next.title || "",
        scheduleType: next.scheduleType || "ad_setup",
        status: next.status || "planned",
        priority: next.priority || "medium",
        startsAt: next.startsAt || "",
        endsAt: next.endsAt || "",
        assigneeName: next.assigneeName || "",
        internalNote: next.internalNote || "",
        isAllDay: Boolean(next.isAllDay),
        calendarId: "",
        expectedUpdatedAt: next.updatedAt || ""
      };
      if (googleConnected()) {
        base.allDay = Boolean(next.isAllDay);
        if (next.isRecurringInstance) base.recurrenceScope = "instance";
      }
      return base;
    }

    // ── 요청 ────────────────────────────────────────────────
    async function requestWorkItems(method, body, query) {
      var queryString = query && query.toString ? query.toString() : "";
      var response = await doFetch(apiUrl("/work-items") + (queryString ? "?" + queryString : ""), {
        method: method,
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 20000
      });
      var payload = await readPayload(response, "내 캘린더 응답을 확인할 수 없습니다.");
      if (!response.ok || !payload || payload.ok === false) {
        var failure = new Error(payload && payload.message ? payload.message : "내 캘린더 요청에 실패했습니다.");
        failure.status = response.status;
        failure.code = payload && payload.code ? String(payload.code) : "";
        throw failure;
      }
      return payload;
    }

    function calendarRequest(body, fallbackMessage, timeoutMs) {
      return doFetch(apiUrl("/google-calendar"), {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: Number(timeoutMs || 30000)
      }).then(async function (response) {
        var payload = await readPayload(response, fallbackMessage);
        if (!response.ok || !payload || payload.ok !== true) throw new Error(payload && payload.message ? payload.message : fallbackMessage);
        return payload;
      });
    }

    function itemsQuery() {
      var fromDate = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
      fromDate.setDate(1 - fromDate.getDay());
      var toDate = new Date(fromDate);
      toDate.setDate(toDate.getDate() + 41);
      var params = new URLSearchParams();
      params.set("from", dateKey(fromDate));
      params.set("to", dateKey(toDate));
      params.set("limit", "300");
      return params;
    }

    async function loadItems() {
      if (destroyed) return false;
      var generation = ++requestGeneration;
      setStatus("내 일정을 불러오는 중입니다.", "");
      try {
        var payload = await requestWorkItems("GET", null, itemsQuery());
        if (destroyed || generation !== requestGeneration) return false;
        items = Array.isArray(payload.items) ? payload.items : [];
        googleCalendars = Array.isArray(payload.googleCalendars) ? payload.googleCalendars : [];
        calendarCatalog = Array.isArray(payload.googleCalendarCatalog) ? payload.googleCalendarCatalog : [];
        syncGoogleMode();
        renderAll();
        if (payload.truncated) {
          setStatus("이 달의 일정이 많아 최대 300개만 표시합니다. 기간을 이동해 확인해주세요.", "warn");
        } else {
          setStatus(items.length ? "저장된 일정 " + items.length + "개를 불러왔습니다." : "등록된 일정이 없습니다. 첫 일정을 추가해보세요.", "ok");
        }
        return true;
      } catch (error) {
        if (destroyed || generation !== requestGeneration) return false;
        items = [];
        renderAll();
        setStatus(error.message || "내 일정을 불러오지 못했습니다.", "warn");
        return false;
      }
    }

    // ── 렌더 ────────────────────────────────────────────────
    function renderSummary() {
      var summaryItems = visibleItems();
      var todayNode = el("[data-cal-summary-today]");
      var overdueNode = el("[data-cal-summary-overdue]");
      var checkNode = el("[data-cal-summary-check]");
      if (todayNode) todayNode.textContent = String(summaryItems.filter(function (item) { return matchesFilter(item, "today"); }).length);
      if (overdueNode) overdueNode.textContent = String(summaryItems.filter(function (item) { return matchesFilter(item, "overdue"); }).length);
      if (checkNode) checkNode.textContent = String(summaryItems.filter(function (item) { return matchesFilter(item, "needs_check"); }).length);
      node.querySelectorAll("[data-cal-summary-filter]").forEach(function (button) {
        var active = button.getAttribute("data-cal-summary-filter") === activeFilter;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    function renderMonthPicker() {
      var grid = el("[data-cal-month-grid]");
      var year = el("[data-cal-month-picker-year]");
      if (!grid || !year) return;
      year.textContent = monthPickerYear + "년";
      var html = [];
      for (var month = 0; month < 12; month += 1) {
        var selected = monthPickerYear === monthCursor.getFullYear() && month === monthCursor.getMonth();
        html.push('<button class="mi-cal-month-choice" type="button" data-cal-picker-month="' + month + '"' +
          (selected ? ' aria-current="date"' : "") + ">" + (month + 1) + "월</button>");
      }
      grid.innerHTML = html.join("");
    }

    function openMonthPicker() {
      var picker = el("[data-cal-month-picker]");
      var trigger = el("[data-cal-month-picker-trigger]");
      if (!picker || !trigger) return;
      monthPickerYear = monthCursor.getFullYear();
      renderMonthPicker();
      picker.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(function () {
        var selected = picker.querySelector('[data-cal-picker-month][aria-current="date"]');
        var first = picker.querySelector("[data-cal-picker-month]");
        if (selected || first) (selected || first).focus();
      });
    }

    function closeMonthPicker(restoreFocus) {
      var picker = el("[data-cal-month-picker]");
      var trigger = el("[data-cal-month-picker-trigger]");
      if (picker) picker.hidden = true;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && trigger) trigger.focus();
    }

    function renderCalendar() {
      var calendar = el("[data-cal-calendar]");
      var label = el("[data-cal-month-label]");
      if (!calendar) return;
      if (label) label.textContent = monthCursor.getFullYear() + "년 " + (monthCursor.getMonth() + 1) + "월";
      var gridStart = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1 - monthCursor.getDay());
      var today = dateKey(new Date());
      var pool = filteredItems();
      var html = [];
      for (var index = 0; index < 42; index += 1) {
        var date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
        var key = dateKey(date);
        var inMonth = date.getMonth() === monthCursor.getMonth();
        var dayItems = pool.filter(function (item) { return dateKey(item.startsAt) === key; })
          .sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); });
        html.push('<div class="mi-cal-day' + (inMonth ? "" : " is-muted") + (key === today ? " is-today" : "") +
          '" data-cal-drop-date="' + key + '" data-cal-cell-date="' + key + '">' +
          '<div class="mi-cal-day-head"><button type="button" data-cal-date="' + key + '" aria-label="' + key + ' 일정 추가">' +
          date.getDate() + "</button>" + (dayItems.length ? '<span class="mi-cal-chip-count">' + dayItems.length + "</span>" : "") + "</div>" +
          '<div class="mi-cal-day-items">' + dayItems.slice(0, 3).map(function (item) {
            var editable = canEdit(item);
            var chipColor = itemColor(item);
            var chipText = itemTextColor(item);
            var chipAllDay = item.isAllDay === false ? "false" : "true";
            var chipStyle = (chipColor ? ' data-gcal="1" style="--mi-cal-color:' + chipColor + '"' : "");
            if (chipColor) chipStyle = chipStyle.slice(0, -1) + ";--mi-cal-text:" + chipText + '"';
            return '<button type="button" class="mi-cal-day-item" draggable="' + (editable ? "true" : "false") + '" data-cal-edit="' + escapeHtml(item.id) +
              '"' + (editable ? ' data-cal-drag-id="' + escapeHtml(item.id) + '"' : "") + chipStyle +
              ' data-allday="' + chipAllDay + '" data-status="' + escapeHtml(item.status) + '">' +
              (chipColor && chipAllDay === "false" ? '<i class="mi-cal-day-dot" aria-hidden="true"></i>' : "") +
              escapeHtml(item.title) + "</button>";
          }).join("") + (dayItems.length > 3 ? '<button type="button" class="mi-cal-date-overflow" data-cal-date-overflow="' + key +
            '" aria-label="' + key + ' 나머지 일정 보기">+' + (dayItems.length - 3) + "</button>" : "") +
          "</div></div>");
      }
      calendar.innerHTML = html.join("");
    }

    function googleChip(item) {
      if (!item || item.googleSource !== "google") return "";
      var chip = '<em class="mi-cal-tag">구글</em>';
      var link = String(item.googleHtmlLink || "");
      if (!/^https:\/\//i.test(link)) return chip;
      return '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener" data-cal-google-link title="구글 캘린더에서 열기">' + chip + "</a>";
    }

    function agendaMetaLine(item) {
      if (!item) return "";
      var parts = [];
      var location = String(item.location || "").trim();
      var attendees = Array.isArray(item.attendees) ? item.attendees.length : 0;
      var calendarName = String(item.calendarName || "").trim();
      var recurrenceSummary = String(item.recurrenceSummary || "").trim();
      if (location) parts.push(location);
      if (attendees) parts.push("참석자 " + attendees + "명");
      if (item.conferenceUri) parts.push("Meet");
      if (calendarName) parts.push(calendarName);
      if (recurrenceSummary) parts.push(recurrenceSummary);
      if (item.readOnly) parts.push("읽기 전용");
      if (!parts.length) return "";
      return '<small class="mi-cal-agenda-meta">' + escapeHtml(parts.join(" · ")) + "</small>";
    }

    function renderAgendaGroup(title, groupItems) {
      var content = groupItems.length ? groupItems.map(function (item) {
        var done = item.status === "done";
        var editable = canEdit(item);
        var rowColor = itemColor(item);
        var rowStyle = (rowColor ? ' data-gcal="1" style="--mi-cal-color:' + rowColor + '"' : "");
        return '<div class="mi-cal-agenda-item" data-priority="' + escapeHtml(item.priority || "medium") +
          '" data-status="' + escapeHtml(item.status) + '"' + rowStyle +
          '><i aria-hidden="true"></i><button type="button" class="mi-cal-agenda-edit" data-cal-edit="' +
          escapeHtml(item.id) + '"><strong>' + escapeHtml(item.title) + "</strong><span>" + escapeHtml(timeLabel(item.startsAt)) + " · " +
          escapeHtml(statusLabel(item.status)) + "</span>" + agendaMetaLine(item) + '</button><span class="mi-cal-badges"><em class="mi-cal-tag">' +
          escapeHtml(typeLabel(item.scheduleType)) + "</em>" + googleChip(item) + '</span><button type="button" class="mi-cal-quick-done" data-cal-quick-done="' +
          escapeHtml(item.id) + '" data-status="' + escapeHtml(item.status) + '" aria-label="' +
          (done ? escapeHtml(item.title) + " 완료 해제" : escapeHtml(item.title) + " 완료 처리") + '" title="' +
          (done ? "완료 해제" : "완료 처리") + '" aria-pressed="' + (done ? "true" : "false") + '"' + (editable ? "" : " disabled") + ">✓</button></div>";
      }).join("") : '<div class="mi-cal-agenda-empty">등록된 일정이 없습니다.</div>';
      return '<section class="mi-cal-agenda-group"><strong>' + escapeHtml(title) +
        '</strong><div class="mi-cal-agenda-row">' + content + "</div></section>";
    }

    function renderAgenda() {
      var agenda = el("[data-cal-agenda]");
      var count = el("[data-cal-count]");
      var title = el("[data-cal-agenda-title]");
      var clear = el("[data-cal-filter-clear]");
      if (!agenda) return;
      var todayDate = new Date();
      todayDate.setHours(0, 0, 0, 0);
      var tomorrowDate = new Date(todayDate);
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      var todayKey = dateKey(todayDate);
      var tomorrowKey = dateKey(tomorrowDate);
      var sorted = filteredItems().sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); });
      var filterLabels = { today: "오늘 일정", overdue: "지연 일정", needs_check: "확인 필요" };
      if (agendaDateKey) {
        var dateItems = sorted.filter(function (item) { return dateKey(item.startsAt) === agendaDateKey; });
        var dateTitle = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(dateFromKey(agendaDateKey));
        agenda.innerHTML = renderAgendaGroup(dateTitle, dateItems);
        if (title) title.textContent = dateTitle + " 일정";
        if (clear) clear.hidden = false;
        if (count) count.textContent = dateItems.length + "개";
        return;
      }
      if (activeFilter) {
        var filterTitle = filterLabels[activeFilter] || "선택 일정";
        agenda.innerHTML = renderAgendaGroup(filterTitle, sorted);
        if (title) title.textContent = filterTitle;
        if (clear) clear.hidden = false;
        if (count) count.textContent = sorted.length + "개";
        return;
      }
      // 달력 옆 띠는 TODAY·TOMORROW 두 묶음만 쌓는다. 그 뒤 일정은 달력에서 본다.
      agenda.innerHTML = renderAgendaGroup("TODAY", sorted.filter(function (item) { return dateKey(item.startsAt) === todayKey; })) +
        renderAgendaGroup("TOMORROW", sorted.filter(function (item) { return dateKey(item.startsAt) === tomorrowKey; }));
      if (title) title.textContent = "가까운 일정";
      if (clear) clear.hidden = true;
      if (count) count.textContent = sorted.length + "개";
    }

    function railGroupHtml(groupKey, title, entries) {
      if (!entries.length) return "";
      var collapsed = railCollapsed[groupKey] === true;
      var rows = entries.map(function (entry) {
        var id = String((entry && entry.id) || "");
        var name = String((entry && entry.name) || "").trim() || id;
        var color = gcalColor(entry && entry.color) || "var(--mi-cal-accent)";
        var checked = !entry || entry.visible !== false;
        // 참가자 관리는 내가 소유한 캘린더에서만 연다. 기본 캘린더는 구글이 ACL 변경을 막는다.
        var manageable = canManageCalendars && Boolean(entry && String(entry.accessRole || "") === "owner" && entry.primary !== true);
        return '<div class="mi-cal-rail-row">' +
          '<button type="button" class="mi-cal-rail-item" role="checkbox" aria-checked="' + (checked ? "true" : "false") +
          '" data-cal-rail-toggle="' + escapeHtml(id) + '" title="' + escapeHtml(name) + '" style="--mi-cal-color:' + color + '">' +
          '<span class="mi-cal-rail-box" aria-hidden="true"></span>' +
          '<span class="mi-cal-rail-name">' + escapeHtml(name) + "</span>" +
          (entry && entry.writable === false ? '<span class="mi-cal-rail-tag">읽기 전용</span>' : "") +
          "</button>" +
          (manageable ? '<button type="button" class="mi-cal-rail-acl" data-cal-acl="' + escapeHtml(id) +
            '" title="' + escapeHtml(name) + ' 참가자 관리" aria-label="' + escapeHtml(name) + ' 참가자 관리">＋</button>' : "") +
          "</div>";
      }).join("");
      return '<div class="mi-cal-rail-section' + (collapsed ? " is-collapsed" : "") + '">' +
        '<button type="button" class="mi-cal-rail-group" data-cal-rail-group="' + escapeHtml(groupKey) +
        '" aria-expanded="' + (collapsed ? "false" : "true") + '"><span class="mi-cal-rail-chevron" aria-hidden="true">⌄</span>' +
        escapeHtml(title) + '</button><div class="mi-cal-rail-rows">' + rows + "</div></div>";
    }

    function renderRail() {
      var body = el("[data-cal-body]");
      var rail = el("[data-cal-rail]");
      var list = el("[data-cal-rail-list]");
      var drawer = el("[data-cal-rail-drawer]");
      var newButton = el("[data-cal-rail-new]");
      if (!rail || !list) return;
      var entries = Array.isArray(calendarCatalog) ? calendarCatalog : [];
      if (!entries.length) {
        list.innerHTML = "";
        rail.hidden = true;
        closeAclPanel();
        if (drawer) {
          drawer.hidden = true;
          drawer.setAttribute("aria-expanded", "false");
        }
        if (body) {
          body.classList.remove("has-rail");
          body.classList.remove("is-rail-open");
        }
        return;
      }
      var own = entries.filter(function (entry) { return !entry || entry.group !== "other"; })
        .sort(function (a, b) { return (b && b.primary === true ? 1 : 0) - (a && a.primary === true ? 1 : 0); });
      var other = entries.filter(function (entry) { return entry && entry.group === "other"; });
      list.innerHTML = railGroupHtml("own", "내 캘린더", own) + railGroupHtml("other", "다른 캘린더", other);
      rail.hidden = false;
      if (drawer) drawer.hidden = false;
      if (body) body.classList.add("has-rail");
      // 캘린더 만들기·참가자 초대는 서버 정책(owner·team)과 같은 조건으로만 보인다.
      if (newButton) newButton.hidden = !canManageCalendars;
      if (!canManageCalendars) setNewCalendarForm(false);
      if (aclId && !catalogEntry(aclId)) closeAclPanel();
      syncRailBusy();
    }

    function syncRailBusy() {
      var rail = el("[data-cal-rail]");
      if (!rail) return;
      rail.querySelectorAll("button, input, select").forEach(function (control) {
        if (control.hasAttribute("data-cal-rail-refresh")) return;
        control.disabled = railBusy;
      });
    }

    function renderAll() {
      renderRail();
      renderSummary();
      renderCalendar();
      renderAgenda();
      // 브리핑은 일정이 다시 로드될 때마다 같이 갱신된다. 별도 조회가 없으므로
      // 화면에 보이는 행과 브리핑이 어긋날 자리가 없다.
      renderAssistantBriefing();
    }

    // ── 캘린더 만들기 · 참가자 ────────────────────────────────
    function renderInviteChips() {
      var wrap = el("[data-cal-invite-chips]");
      if (!wrap) return;
      wrap.innerHTML = inviteDraft.map(function (email) {
        return '<span class="mi-cal-chip"><span>' + escapeHtml(email) + "</span>" +
          '<button class="mi-cal-chip-remove" type="button" data-cal-invite-remove="' + escapeHtml(email) +
          '" aria-label="' + escapeHtml(email) + ' 참가자 삭제">×</button></span>';
      }).join("");
    }

    function commitInvite(raw) {
      var text = String(raw || "").trim().replace(/[,;]+$/, "").trim();
      if (!text) return true;
      if (!EMAIL_PATTERN.test(text)) {
        setRailNote("이메일 형식이 올바르지 않습니다: " + text);
        return false;
      }
      var email = text.toLowerCase();
      if (inviteDraft.indexOf(email) === -1) inviteDraft.push(email);
      setRailNote("");
      renderInviteChips();
      return true;
    }

    function commitInviteInput() {
      var input = el("[data-cal-invite-input]");
      if (!input) return true;
      var chunks = String(input.value || "").split(/[,;\s]+/).filter(Boolean);
      var ok = true;
      for (var index = 0; index < chunks.length; index += 1) {
        if (!commitInvite(chunks[index])) ok = false;
      }
      if (ok) input.value = "";
      return ok;
    }

    function setNewCalendarForm(open) {
      var panel = el("[data-cal-new-form]");
      var button = el("[data-cal-rail-new]");
      if (!panel) return;
      panel.hidden = !open;
      if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        closeAclPanel();
        var name = el("[data-cal-new-name]");
        if (name) name.focus();
        return;
      }
      inviteDraft = [];
      setValue("[data-cal-new-name]", "");
      setValue("[data-cal-invite-input]", "");
      renderInviteChips();
    }

    function renderAclRules() {
      var wrap = el("[data-cal-acl-rules]");
      if (!wrap) return;
      var rules = Array.isArray(aclRules) ? aclRules : [];
      if (!rules.length) {
        wrap.innerHTML = '<div class="mi-cal-rule"><span>추가된 참가자가 없습니다.</span></div>';
        return;
      }
      wrap.innerHTML = rules.map(function (rule) {
        var email = String((rule && rule.email) || "").trim() || String((rule && rule.scopeType) || "");
        var roleLabel = String((rule && rule.role) || "") === "reader" ? "보기만" : "편집 가능";
        return '<div class="mi-cal-rule"><span>' + escapeHtml(email) + "</span><small>" + escapeHtml(roleLabel) +
          '</small><button type="button" data-cal-acl-remove="' + escapeHtml(String((rule && rule.id) || "")) +
          '" aria-label="' + escapeHtml(email) + ' 참가자 삭제">삭제</button></div>';
      }).join("");
    }

    function closeAclPanel() {
      var panel = el("[data-cal-acl-panel]");
      aclId = "";
      aclRules = [];
      if (panel) panel.hidden = true;
    }

    async function createCalendarFromForm() {
      if (!canManageCalendars || railBusy) return;
      if (!commitInviteInput()) return;
      var summary = String(value("[data-cal-new-name]") || "").trim();
      if (!summary) {
        setRailNote("캘린더 이름을 입력해주세요.");
        return;
      }
      var inviteRole = value("[data-cal-invite-role]") === "reader" ? "reader" : "writer";
      var invites = inviteDraft.map(function (email) { return { email: email, role: inviteRole }; });
      railBusy = true;
      syncRailBusy();
      setRailNote("");
      setStatus("새 캘린더를 만드는 중입니다.", "");
      try {
        var payload = await calendarRequest({ action: "calendar-create", summary: summary, invites: invites }, "새 캘린더를 만들지 못했습니다.");
        if (destroyed) return;
        if (Array.isArray(payload.calendars)) calendarCatalog = payload.calendars;
        railBusy = false;
        setNewCalendarForm(false);
        renderAll();
        await loadItems();
        var failed = Array.isArray(payload.failedInvites) ? payload.failedInvites : [];
        if (failed.length) {
          setRailNote("초대하지 못한 참가자: " + failed.map(function (entry) {
            return String((entry && entry.email) || entry || "");
          }).filter(Boolean).join(", "));
        }
        setStatus(summary + " 캘린더를 만들었습니다.", "ok");
      } catch (error) {
        railBusy = false;
        syncRailBusy();
        setRailNote(error.message || "새 캘린더를 만들지 못했습니다.");
        setStatus(error.message || "새 캘린더를 만들지 못했습니다.", "warn");
      }
    }

    async function requestCalendarAcl(op, aclOptions) {
      var id = String((aclOptions && aclOptions.calendarId) || aclId || "");
      if (!id || !canManageCalendars || railBusy) return;
      var body = { action: "calendar-acl", calendarId: id, op: op };
      if (aclOptions && aclOptions.email) body.email = aclOptions.email;
      if (aclOptions && aclOptions.role) body.role = aclOptions.role;
      if (aclOptions && aclOptions.ruleId) body.ruleId = aclOptions.ruleId;
      railBusy = true;
      syncRailBusy();
      try {
        var payload = await calendarRequest(body, "참가자 목록을 처리하지 못했습니다.");
        if (destroyed) return;
        aclId = id;
        aclRules = Array.isArray(payload.rules) ? payload.rules : [];
        railBusy = false;
        var panel = el("[data-cal-acl-panel]");
        var title = el("[data-cal-acl-title]");
        var entry = catalogEntry(id);
        if (title) title.textContent = (String((entry && entry.name) || "").trim() || id) + " · 참가자 관리";
        if (panel) panel.hidden = false;
        renderAclRules();
        syncRailBusy();
        if (op !== "list") setRailNote("");
      } catch (error) {
        railBusy = false;
        syncRailBusy();
        setRailNote(error.message || "참가자 목록을 처리하지 못했습니다.");
      }
    }

    function addAclEmail() {
      var email = String(value("[data-cal-acl-email]") || "").trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email)) {
        setRailNote("이메일 형식이 올바르지 않습니다: " + (email || "(빈 값)"));
        return;
      }
      var aclRole = value("[data-cal-acl-role]") === "reader" ? "reader" : "writer";
      setValue("[data-cal-acl-email]", "");
      requestCalendarAcl("insert", { email: email, role: aclRole });
    }

    async function toggleCalendarVisibility(calendarId) {
      var id = String(calendarId || "");
      if (!id || railBusy) return;
      var entry = catalogEntry(id);
      if (!entry) return;
      var label = String(entry.name || "").trim() || id;
      var nextVisible = entry.visible === false;
      var previousCatalog = calendarCatalog;
      railBusy = true;
      // 서버 응답 전에 먼저 화면에서 지운다. 실패하면 아래에서 되돌린다.
      calendarCatalog = calendarCatalog.map(function (candidate) {
        if (!candidate || String(candidate.id || "") !== id) return candidate;
        return Object.assign({}, candidate, { visible: nextVisible });
      });
      renderAll();
      try {
        var payload = await calendarRequest({ action: "calendar-visibility", calendarId: id, visible: nextVisible }, "캘린더 표시 설정을 저장하지 못했습니다.", 20000);
        if (destroyed) return;
        if (Array.isArray(payload.calendars)) calendarCatalog = payload.calendars;
        setRailNote("");
        railBusy = false;
        renderAll();
        // 다시 켠 캘린더의 일정은 서버가 목록에서 빼고 있었으므로 반드시 다시 읽는다.
        await loadItems();
        setStatus(nextVisible ? label + " 캘린더를 표시합니다." : label + " 캘린더를 숨겼습니다.", "ok");
      } catch (error) {
        calendarCatalog = previousCatalog;
        railBusy = false;
        renderAll();
        setRailNote(error.message || "캘린더 설정을 저장하지 못했습니다.");
        setStatus(error.message || "캘린더 표시 설정을 저장하지 못했습니다.", "warn");
      }
    }

    async function refreshCalendarCatalog(button) {
      if (railBusy) return;
      railBusy = true;
      if (button) button.disabled = true;
      setStatus("구글 캘린더 목록을 새로 읽는 중입니다.", "");
      try {
        var payload = await calendarRequest({ action: "calendar-refresh" }, "구글 캘린더 목록을 새로 읽지 못했습니다.");
        if (destroyed) return;
        calendarCatalog = Array.isArray(payload.calendars) ? payload.calendars : [];
        railBusy = false;
        if (button) button.disabled = false;
        renderAll();
        await loadItems();
        setStatus("구글 캘린더 " + calendarCatalog.length + "개를 불러왔습니다.", "ok");
      } catch (error) {
        railBusy = false;
        if (button) button.disabled = false;
        syncRailBusy();
        setStatus(error.message || "구글 캘린더 목록을 새로 읽지 못했습니다.", "warn");
      }
    }

    // ── 구글 배너 ────────────────────────────────────────────
    function consumeNoticeParams() {
      try {
        var pageUrl = new URL(window.location.href);
        var gcalCode = pageUrl.searchParams.get("gcal");
        var gloginCode = pageUrl.searchParams.get("glogin");
        if (!gcalCode && !gloginCode) return;
        if (gcalCode) gcalPendingNotice = calendarNotice(gcalCode);
        if (gloginCode && gloginCode !== "success") {
          gloginPendingNotice = gloginCode === "linked"
            ? "구글 계정이 연결되었습니다. 다음부터 구글로 로그인할 수 있습니다."
            : (loginNotice(gloginCode) || "구글 로그인 처리 실패: " + gloginCode);
        }
        pageUrl.searchParams.delete("gcal");
        pageUrl.searchParams.delete("glogin");
        var cleanQuery = pageUrl.searchParams.toString();
        window.history.replaceState(null, "", pageUrl.pathname + (cleanQuery ? "?" + cleanQuery : "") + pageUrl.hash);
      } catch (error) {}
    }

    function renderCalendarBanner(payload) {
      if (payload) gcalState = payload;
      var state = gcalState || {};
      var banner = el("[data-cal-gcal-banner]");
      var statusCopy = el("[data-cal-gcal-status]");
      var connectButton = el("[data-cal-gcal-connect]");
      var disconnectButton = el("[data-cal-gcal-disconnect]");
      var badge = el("[data-cal-gcal-badge]");
      var syncButton = el("[data-cal-gcal-sync]");
      var lastSyncCopy = el("[data-cal-gcal-last]");
      if (!banner || !statusCopy || !connectButton || !disconnectButton) return;
      var notice = payload ? gcalPendingNotice : "";
      if (payload) gcalPendingNotice = "";
      if (typeof state.canManageCalendars === "boolean") canManageCalendars = state.canManageCalendars;
      if (badge) badge.hidden = true;
      if (lastSyncCopy) {
        lastSyncCopy.hidden = true;
        lastSyncCopy.textContent = "";
      }
      if (syncButton) {
        syncButton.hidden = true;
        syncButton.disabled = false;
        syncButton.textContent = "지금 동기화";
      }
      connectButton.disabled = false;
      connectButton.textContent = "구글 캘린더 연결";
      disconnectButton.disabled = false;
      statusCopy.classList.remove("is-linked");
      if (state.storageReady === false) {
        statusCopy.textContent = "준비 1단계 남음 — 관리자 데이터베이스 적용 후 활성화됩니다.";
        connectButton.hidden = true;
        disconnectButton.hidden = true;
      } else if (!state.configured) {
        statusCopy.textContent = "구글 연동 환경변수가 아직 설정되지 않았습니다.";
        connectButton.hidden = true;
        disconnectButton.hidden = true;
      } else if (state.connected) {
        connectButton.hidden = true;
        disconnectButton.hidden = false;
        if (gcalSyncing) {
          statusCopy.textContent = "동기화 중…";
          connectButton.disabled = true;
          disconnectButton.disabled = true;
          if (syncButton) {
            syncButton.hidden = false;
            syncButton.disabled = true;
          }
        } else if (state.syncStatus === "needs_reconnect") {
          statusCopy.textContent = "구글 연결이 만료되었습니다. 다시 연결해주세요.";
          connectButton.hidden = false;
          connectButton.textContent = "다시 연결";
        } else if (state.syncStatus === "error") {
          statusCopy.textContent = "동기화에 실패했습니다 · " + (state.syncError || "알 수 없는 이유");
          if (syncButton) {
            syncButton.hidden = false;
            syncButton.textContent = "다시 시도";
          }
        } else {
          statusCopy.classList.add("is-linked");
          statusCopy.textContent = (notice ? notice + " " : "") + "연결됨 · " + (state.googleEmail || "구글 계정");
          if (badge) badge.hidden = false;
          if (syncButton) syncButton.hidden = false;
        }
        if (lastSyncCopy && !gcalSyncing) {
          lastSyncCopy.textContent = syncAgeLabel(state.lastSyncAt);
          lastSyncCopy.hidden = false;
        }
      } else {
        statusCopy.textContent = notice || "구글 캘린더에 연결하면 일정이 양방향으로 동기화됩니다.";
        connectButton.hidden = false;
        disconnectButton.hidden = true;
      }
      banner.hidden = false;
    }

    async function refreshCalendarBanner() {
      var response = await doFetch(apiUrl("/google-calendar"), { method: "GET", cache: "no-store" });
      var payload = await readPayload(response, "구글 캘린더 연동 상태를 확인할 수 없습니다.");
      if (destroyed) return;
      if (!response.ok || !payload.ok) throw new Error(payload.message || "구글 캘린더 연동 상태를 확인할 수 없습니다.");
      renderCalendarBanner(payload);
    }

    function applySyncOutcome(result) {
      if (!result) {
        renderCalendarBanner(null);
        return;
      }
      if (result.throttled !== true) {
        if (result.needsReconnect === true) {
          gcalState.syncStatus = "needs_reconnect";
          gcalState.syncError = null;
        } else if (result.error) {
          gcalState.syncStatus = "error";
          gcalState.syncError = String(result.error);
        } else {
          gcalState.syncStatus = "ok";
          gcalState.syncError = null;
        }
      }
      if (result.lastSyncAt) gcalState.lastSyncAt = result.lastSyncAt;
      renderCalendarBanner(null);
    }

    async function maybeSync(trigger) {
      var mode = trigger === "manual" ? "manual" : "auto";
      if (destroyed || syncInFlight) return;
      if (mode === "auto" && lastAutoSyncAt && Date.now() - lastAutoSyncAt < 60000) return;
      syncInFlight = true;
      lastAutoSyncAt = Date.now();
      gcalSyncing = true;
      renderCalendarBanner(null);
      var outcome = null;
      try {
        var response = await doFetch(apiUrl("/google-calendar"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "sync", trigger: mode }),
          timeoutMs: 60000
        });
        var payload = await readPayload(response, "구글 캘린더 동기화 결과를 확인할 수 없습니다.");
        if (!response.ok || payload.ok !== true) throw new Error(payload.message || "구글 캘린더 동기화에 실패했습니다.");
        outcome = payload;
      } catch (error) {
        outcome = { ok: false, error: error.message || "구글 캘린더 동기화에 실패했습니다." };
      }
      syncInFlight = false;
      gcalSyncing = false;
      if (destroyed) return;
      applySyncOutcome(outcome);
      // changed 는 inbound 만 센다. push 만 일어난 동기화도 행의 google_* 기록을 써서
      // updated_at 을 올리므로, 다시 읽지 않으면 화면이 낡은 updated_at 을 들게 된다.
      var touchedRows = Number(outcome.changed) > 0 || Number(outcome.pushed) > 0;
      if (outcome.ok === true && outcome.throttled !== true && touchedRows) await loadItems();
    }

    function renderLoginBanner(payload) {
      var banner = el("[data-cal-glogin-banner]");
      var statusCopy = el("[data-cal-glogin-status]");
      var linkButton = el("[data-cal-glogin-link]");
      var unlinkButton = el("[data-cal-glogin-unlink]");
      var badge = el("[data-cal-glogin-badge]");
      if (!banner || !statusCopy || !linkButton || !unlinkButton) return;
      var notice = gloginPendingNotice;
      gloginPendingNotice = "";
      if (badge) badge.hidden = true;
      if (payload.storageReady === false) {
        statusCopy.textContent = "준비 1단계 남음 — 관리자 데이터베이스 적용 후 활성화됩니다.";
        linkButton.hidden = true;
        unlinkButton.hidden = true;
      } else if (!payload.configured) {
        statusCopy.textContent = "관리자 환경변수 설정 대기 중(GOOGLE_OAUTH_CLIENT_ID/SECRET)";
        linkButton.hidden = true;
        unlinkButton.hidden = true;
      } else if (payload.linked) {
        statusCopy.textContent = (notice ? notice + " " : "") + (payload.googleEmail || "구글 계정");
        statusCopy.classList.add("is-linked");
        if (badge) badge.hidden = false;
        linkButton.hidden = true;
        unlinkButton.hidden = false;
      } else {
        statusCopy.classList.remove("is-linked");
        statusCopy.textContent = notice || "연결하면 접속 코드 대신 구글 계정으로 로그인할 수 있습니다.";
        linkButton.hidden = false;
        unlinkButton.hidden = true;
      }
      banner.hidden = false;
    }

    async function refreshLoginBanner() {
      var response = await doFetch(apiUrl("/google-login"), { method: "GET", cache: "no-store" });
      var payload = await readPayload(response, "구글 로그인 연결 상태를 확인할 수 없습니다.");
      if (destroyed) return;
      if (!response.ok || !payload.ok) throw new Error(payload.message || "구글 로그인 연결 상태를 확인할 수 없습니다.");
      renderLoginBanner(payload);
    }

    async function startCalendarAuth(button) {
      if (destroyed || button.disabled) return;
      var statusCopy = el("[data-cal-gcal-status]");
      button.disabled = true;
      if (statusCopy) statusCopy.textContent = "구글 인증 화면으로 이동을 준비하는 중입니다.";
      try {
        var response = await doFetch(apiUrl("/google-calendar"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "auth-url" })
        });
        var payload = await readPayload(response, "구글 인증 주소를 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload.ok || !payload.url) throw new Error(payload.message || "구글 인증 주소를 만들지 못했습니다.");
        window.location.href = payload.url;
        return;
      } catch (error) {
        if (!destroyed && statusCopy) statusCopy.textContent = error.message || "구글 인증 주소를 만들지 못했습니다.";
      } finally {
        button.disabled = false;
      }
    }

    async function disconnectCalendar(button) {
      if (destroyed || button.disabled) return;
      if (!window.confirm("구글 캘린더 연동을 해제할까요? 이미 등록된 구글 일정은 남아 있습니다.")) return;
      var statusCopy = el("[data-cal-gcal-status]");
      button.disabled = true;
      if (statusCopy) statusCopy.textContent = "구글 캘린더 연동을 해제하는 중입니다.";
      try {
        var response = await doFetch(apiUrl("/google-calendar"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "disconnect" })
        });
        var payload = await readPayload(response, "구글 연동 해제 결과를 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload.ok) throw new Error(payload.message || "구글 연동 해제에 실패했습니다.");
        gcalPendingNotice = payload.message || "구글 캘린더 연동을 해제했습니다.";
        await refreshCalendarBanner();
        await loadItems();
      } catch (error) {
        if (!destroyed && statusCopy) statusCopy.textContent = error.message || "구글 연동 해제에 실패했습니다.";
      } finally {
        button.disabled = false;
      }
    }

    async function startLoginLink(button) {
      if (destroyed || button.disabled) return;
      var statusCopy = el("[data-cal-glogin-status]");
      button.disabled = true;
      if (statusCopy) statusCopy.textContent = "구글 인증 화면으로 이동을 준비하는 중입니다.";
      try {
        var response = await doFetch(apiUrl("/google-login"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "link-url" })
        });
        var payload = await readPayload(response, "구글 인증 주소를 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload.ok || !payload.url) throw new Error(payload.message || "구글 인증 주소를 만들지 못했습니다.");
        window.location.href = payload.url;
        return;
      } catch (error) {
        if (!destroyed && statusCopy) statusCopy.textContent = error.message || "구글 인증 주소를 만들지 못했습니다.";
      } finally {
        button.disabled = false;
      }
    }

    async function unlinkLogin(button) {
      if (destroyed || button.disabled) return;
      if (!window.confirm("구글 로그인 연결을 해제할까요? 기존 코드 로그인은 그대로 사용할 수 있습니다.")) return;
      var statusCopy = el("[data-cal-glogin-status]");
      button.disabled = true;
      if (statusCopy) statusCopy.textContent = "구글 로그인 연결을 해제하는 중입니다.";
      try {
        var response = await doFetch(apiUrl("/google-login"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unlink" })
        });
        var payload = await readPayload(response, "구글 로그인 해제 결과를 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload.ok) throw new Error(payload.message || "구글 로그인 연결 해제에 실패했습니다.");
        gloginPendingNotice = payload.message || "구글 로그인 연결을 해제했습니다.";
        await refreshLoginBanner();
      } catch (error) {
        if (!destroyed && statusCopy) statusCopy.textContent = error.message || "구글 로그인 연결 해제에 실패했습니다.";
      } finally {
        button.disabled = false;
      }
    }

    // ── 다이얼로그 ───────────────────────────────────────────
    function syncStartLabel() {
      var label = el("[data-cal-start-label]");
      var endLabel = el("[data-cal-end-label]");
      if (label) label.textContent = "시작 날짜";
      if (endLabel) endLabel.textContent = "종료 날짜";
    }

    function syncTimeFields() {
      var toggle = el("[data-cal-all-day]");
      var button = el("[data-cal-time-toggle]");
      var startField = el("[data-cal-start-time-field]");
      var endField = el("[data-cal-end-time-field]");
      var startTime = el("[data-cal-start-time]");
      var endTime = el("[data-cal-end-time]");
      if (!toggle || !button || !startField || !endField) return;
      var timed = !toggle.checked;
      startField.hidden = !timed;
      endField.hidden = !timed;
      button.textContent = timed ? "종일" : "시간 추가";
      button.setAttribute("aria-expanded", timed ? "true" : "false");
      if (timed) {
        if (startTime && !startTime.value) startTime.value = "09:00";
        if (endTime && !endTime.value) endTime.value = "10:00";
      }
      syncStartLabel();
    }

    function recurrenceStartDate() {
      var raw = String(value("[data-cal-start]") || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      var date = dateFromKey(raw);
      return isNaN(date.getTime()) ? null : date;
    }

    function recurrenceUntilStamp(raw) {
      var text = String(raw || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
      return text.replace(/-/g, "") + "T145959Z";
    }

    function syncRecurrenceLabels() {
      var date = recurrenceStartDate();
      var weekly = el('[data-cal-recurrence-option="weekly"]');
      var monthlyDay = el('[data-cal-recurrence-option="monthly_day"]');
      var monthlyNth = el('[data-cal-recurrence-option="monthly_nth"]');
      if (!date) {
        if (weekly) weekly.textContent = "매주";
        if (monthlyDay) monthlyDay.textContent = "매월";
        if (monthlyNth) monthlyNth.textContent = "매월 n번째 요일";
        return;
      }
      var dayName = RECURRENCE_DAY_NAMES[date.getDay()];
      var ordinal = RECURRENCE_ORDINAL_NAMES[Math.floor((date.getDate() - 1) / 7)] || "마지막";
      if (weekly) weekly.textContent = "매주 " + dayName + "요일";
      if (monthlyDay) monthlyDay.textContent = "매월 " + date.getDate() + "일";
      if (monthlyNth) monthlyNth.textContent = "매월 " + ordinal + " " + dayName + "요일";
      var customByDate = el('[data-cal-recurrence-monthly-option="bymonthday"]');
      var customByDay = el('[data-cal-recurrence-monthly-option="byday"]');
      if (customByDate) customByDate.textContent = "매월 " + date.getDate() + "일";
      if (customByDay) customByDay.textContent = "매월 " + ordinal + " " + dayName + "요일";
    }

    function syncRecurrenceFields() {
      var preset = value("[data-cal-recurrence-preset]") || "none";
      var custom = el("[data-cal-recurrence-custom]");
      var days = el("[data-cal-recurrence-days]");
      var untilField = el("[data-cal-recurrence-until-field]");
      var countField = el("[data-cal-recurrence-count-field]");
      var monthlyField = el("[data-cal-recurrence-monthly-field]");
      var unit = value("[data-cal-recurrence-unit]") || "WEEKLY";
      var endMode = value("[data-cal-recurrence-end]") || "never";
      var isCustom = preset === "custom" && googleConnected() && !dialogRecurringInstance;
      if (custom) custom.hidden = !isCustom;
      if (days) days.hidden = !isCustom || unit !== "WEEKLY";
      if (monthlyField) monthlyField.hidden = !isCustom || unit !== "MONTHLY";
      if (untilField) untilField.hidden = !isCustom || endMode !== "until";
      if (countField) countField.hidden = !isCustom || endMode !== "count";
      node.querySelectorAll("[data-cal-recurrence-end-choice]").forEach(function (radio) {
        radio.checked = radio.value === endMode;
      });
      syncRecurrenceLabels();
    }

    function recurrenceSnapshot() {
      var days = [];
      node.querySelectorAll("[data-cal-recurrence-day]").forEach(function (box) {
        if (box.checked) days.push(box.getAttribute("data-cal-recurrence-day"));
      });
      return {
        preset: value("[data-cal-recurrence-preset]"),
        interval: value("[data-cal-recurrence-interval]"),
        unit: value("[data-cal-recurrence-unit]"),
        monthly: value("[data-cal-recurrence-monthly-mode]"),
        end: value("[data-cal-recurrence-end]"),
        until: value("[data-cal-recurrence-until]"),
        count: value("[data-cal-recurrence-count]"),
        days: days
      };
    }

    function restoreRecurrenceSnapshot(snapshot) {
      if (!snapshot) return;
      setValue("[data-cal-recurrence-preset]", snapshot.preset);
      setValue("[data-cal-recurrence-interval]", snapshot.interval);
      setValue("[data-cal-recurrence-unit]", snapshot.unit);
      setValue("[data-cal-recurrence-monthly-mode]", snapshot.monthly);
      setValue("[data-cal-recurrence-end]", snapshot.end);
      setValue("[data-cal-recurrence-until]", snapshot.until);
      setValue("[data-cal-recurrence-count]", snapshot.count);
      node.querySelectorAll("[data-cal-recurrence-day]").forEach(function (box) {
        box.checked = snapshot.days.indexOf(box.getAttribute("data-cal-recurrence-day")) !== -1;
      });
      syncRecurrenceFields();
    }

    function openRecurrenceModal() {
      var modal = el("[data-cal-recurrence-modal]");
      if (!modal) return;
      recurrenceSnapshotBeforeEdit = recurrenceSnapshot();
      syncRecurrenceFields();
      modal.hidden = false;
      window.requestAnimationFrame(function () {
        var interval = el("[data-cal-recurrence-interval]");
        if (interval) interval.focus();
      });
    }

    function closeRecurrenceModal(revert) {
      var modal = el("[data-cal-recurrence-modal]");
      if (!modal || modal.hidden) return;
      modal.hidden = true;
      if (revert) restoreRecurrenceSnapshot(recurrenceSnapshotBeforeEdit);
      recurrenceSnapshotBeforeEdit = null;
      syncRecurrenceFields();
      var preset = el("[data-cal-recurrence-preset]");
      if (preset) preset.focus();
    }

    function recurrenceRule() {
      var preset = value("[data-cal-recurrence-preset]") || "none";
      var date = recurrenceStartDate();
      if (!preset || preset === "none" || !date) return "";
      var day = RECURRENCE_DAY_CODES[date.getDay()];
      if (preset === "daily") return "RRULE:FREQ=DAILY";
      if (preset === "weekly") return "RRULE:FREQ=WEEKLY;BYDAY=" + day;
      if (preset === "monthly_day") return "RRULE:FREQ=MONTHLY;BYMONTHDAY=" + date.getDate();
      if (preset === "monthly_nth") return "RRULE:FREQ=MONTHLY;BYDAY=" + (Math.floor((date.getDate() - 1) / 7) + 1) + day;
      if (preset === "yearly") return "RRULE:FREQ=YEARLY";
      if (preset === "weekday") return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
      if (preset !== "custom") return "";
      var unit = value("[data-cal-recurrence-unit]") || "WEEKLY";
      var interval = Math.max(1, Math.min(366, Math.floor(Number(value("[data-cal-recurrence-interval]")) || 1)));
      var rule = "RRULE:FREQ=" + unit;
      if (unit === "WEEKLY") {
        var picked = [];
        node.querySelectorAll("[data-cal-recurrence-day]").forEach(function (box) {
          if (box.checked) picked.push(box.getAttribute("data-cal-recurrence-day"));
        });
        if (!picked.length) picked.push(day);
        rule += ";BYDAY=" + picked.join(",");
      }
      if (unit === "MONTHLY") {
        var monthlyMode = value("[data-cal-recurrence-monthly-mode]") || "bymonthday";
        if (monthlyMode === "byday") rule += ";BYDAY=" + (Math.floor((date.getDate() - 1) / 7) + 1) + day;
        else rule += ";BYMONTHDAY=" + date.getDate();
      }
      if (interval > 1) rule += ";INTERVAL=" + interval;
      var endMode = value("[data-cal-recurrence-end]") || "never";
      if (endMode === "until") {
        var stamp = recurrenceUntilStamp(value("[data-cal-recurrence-until]"));
        if (stamp) rule += ";UNTIL=" + stamp;
      } else if (endMode === "count") {
        var count = Math.max(1, Math.min(730, Math.floor(Number(value("[data-cal-recurrence-count]")) || 1)));
        rule += ";COUNT=" + count;
      }
      return rule;
    }

    function recurrenceRules() {
      var rule = recurrenceRule();
      return rule ? [rule] : [];
    }

    function applyRecurrence(item) {
      var select = el("[data-cal-recurrence-preset]");
      if (!select) return;
      select.value = "none";
      node.querySelectorAll("[data-cal-recurrence-day]").forEach(function (box) { box.checked = false; });
      var parts = parseRecurrence(item && item.recurrence);
      if (!parts) {
        syncRecurrenceFields();
        return;
      }
      var freq = String(parts.FREQ || "").toUpperCase();
      var interval = Math.floor(Number(parts.INTERVAL || 1)) || 1;
      var byDay = String(parts.BYDAY || "").toUpperCase();
      var plain = interval === 1 && !parts.UNTIL && !parts.COUNT;
      if (plain && freq === "DAILY" && !byDay) select.value = "daily";
      else if (plain && freq === "WEEKLY" && byDay === "MO,TU,WE,TH,FR") select.value = "weekday";
      else if (plain && freq === "WEEKLY" && /^[A-Z]{2}$/.test(byDay)) select.value = "weekly";
      else if (plain && freq === "MONTHLY" && parts.BYMONTHDAY) select.value = "monthly_day";
      else if (plain && freq === "MONTHLY" && /^-?\d[A-Z]{2}$/.test(byDay)) select.value = "monthly_nth";
      else if (plain && freq === "YEARLY") select.value = "yearly";
      else {
        select.value = "custom";
        setValue("[data-cal-recurrence-unit]", freq || "WEEKLY");
        setValue("[data-cal-recurrence-monthly-mode]", freq === "MONTHLY" && /^-?\d[A-Z]{2}$/.test(byDay) ? "byday" : "bymonthday");
        setValue("[data-cal-recurrence-interval]", String(interval));
        byDay.split(",").forEach(function (code) {
          var box = el('[data-cal-recurrence-day="' + String(code || "").replace(/[^A-Z]/g, "") + '"]');
          if (box) box.checked = true;
        });
        if (parts.UNTIL) {
          setValue("[data-cal-recurrence-end]", "until");
          var stamp = String(parts.UNTIL).replace(/[^0-9]/g, "").slice(0, 8);
          if (stamp.length === 8) setValue("[data-cal-recurrence-until]", stamp.slice(0, 4) + "-" + stamp.slice(4, 6) + "-" + stamp.slice(6, 8));
        } else if (parts.COUNT) {
          setValue("[data-cal-recurrence-end]", "count");
          setValue("[data-cal-recurrence-count]", String(Math.floor(Number(parts.COUNT)) || 1));
        } else {
          setValue("[data-cal-recurrence-end]", "never");
        }
      }
      syncRecurrenceFields();
    }

    function renderAttendeeChips() {
      var wrap = el("[data-cal-attendee-chips]");
      if (!wrap) return;
      wrap.innerHTML = attendeeDraft.map(function (email) {
        return '<span class="mi-cal-chip"><span>' + escapeHtml(email) + "</span>" +
          '<button class="mi-cal-chip-remove" type="button" data-cal-attendee-remove="' + escapeHtml(email) +
          '" aria-label="' + escapeHtml(email) + ' 참석자 삭제">×</button></span>';
      }).join("");
    }

    function setAttendeeError(message) {
      var found = el("[data-cal-attendee-error]");
      if (!found) return;
      found.textContent = message || "";
      found.hidden = !message;
    }

    function commitAttendee(raw) {
      var text = String(raw || "").trim().replace(/[,;]+$/, "").trim();
      if (!text) return true;
      if (!EMAIL_PATTERN.test(text)) {
        setAttendeeError("이메일 형식이 올바르지 않습니다: " + text);
        return false;
      }
      var email = text.toLowerCase();
      if (attendeeDraft.indexOf(email) !== -1) {
        setAttendeeError("");
        return true;
      }
      if (attendeeDraft.length >= ATTENDEE_LIMIT) {
        setAttendeeError("참석자는 최대 " + ATTENDEE_LIMIT + "명까지 추가할 수 있습니다.");
        return false;
      }
      attendeeDraft.push(email);
      setAttendeeError("");
      renderAttendeeChips();
      return true;
    }

    function commitAttendeeInput() {
      var input = el("[data-cal-attendee-input]");
      if (!input) return true;
      var chunks = String(input.value || "").split(/[,;\s]+/).filter(Boolean);
      var ok = true;
      for (var index = 0; index < chunks.length; index += 1) {
        if (!commitAttendee(chunks[index])) ok = false;
      }
      if (ok) input.value = "";
      return ok;
    }

    function setDisclosure(name, expanded) {
      var button = el('[data-cal-expand="' + name + '"]');
      var panel = el('[data-cal-panel="' + name + '"]');
      if (!button || !panel) return;
      panel.hidden = !expanded;
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    function defaultGoogleCalendarId() {
      var fallback = "";
      for (var index = 0; index < googleCalendars.length; index += 1) {
        var calendar = googleCalendars[index] || {};
        if (calendar.dedicated) return String(calendar.id || "");
        if (!fallback && calendar.primary) fallback = String(calendar.id || "");
      }
      if (fallback) return fallback;
      return googleCalendars.length ? String(googleCalendars[0].id || "") : "";
    }

    function renderGoogleCalendarOptions(selectedId) {
      var field = el("[data-cal-google-calendar-field]");
      var select = el("[data-cal-google-calendar]");
      if (!field || !select) return;
      if (!googleConnected()) {
        select.innerHTML = "";
        field.hidden = true;
        return;
      }
      var html = [];
      for (var index = 0; index < googleCalendars.length; index += 1) {
        var calendar = googleCalendars[index] || {};
        var id = String(calendar.id || "");
        var name = String(calendar.name || "").trim() || id;
        html.push('<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + "</option>");
      }
      select.innerHTML = html.join("");
      field.hidden = false;
      var target = String(selectedId || "");
      if (!target || !select.querySelector('[value="' + target.replace(/"/g, "") + '"]')) target = defaultGoogleCalendarId();
      select.value = target;
      syncGoogleCalendarDot();
    }

    function dialogCalendarColor() {
      var id = String(value("[data-cal-google-calendar]") || "");
      var entry = catalogEntry(id);
      var color = gcalColor(entry && entry.color);
      if (color) return color;
      for (var index = 0; index < googleCalendars.length; index += 1) {
        var calendar = googleCalendars[index] || {};
        if (String(calendar.id || "") === id) return gcalColor(calendar.color);
      }
      return "";
    }

    function syncGoogleCalendarDot() {
      var dot = el("[data-cal-google-calendar-dot]");
      if (!dot) return;
      var color = dialogCalendarColor();
      dot.style.setProperty("--mi-cal-color", color || "var(--mi-cal-accent)");
      renderEventColorSwatches();
    }

    // 구글 일정 창의 색 줄. 맨 앞은 "캘린더 색"(colorId 를 보내지 않는 기본값)이고,
    // 그 뒤로 구글 한국어 UI 순서대로 11개 동그란 스와치가 온다. 인라인 핸들러 없이
    // data-cal-swatch 위임 핸들러가 선택을 받는다(CSP script-src-attr 'none').
    function renderEventColorSwatches() {
      var wrap = el("[data-cal-swatches]");
      if (!wrap) return;
      var defaultColor = dialogCalendarColor();
      var html = ['<button type="button" class="mi-cal-swatch is-default" data-cal-swatch="" aria-pressed="' +
        (eventColorDraft ? "false" : "true") + '" aria-label="캘린더 색" title="캘린더 색"' +
        (defaultColor ? ' style="--mi-cal-color:' + defaultColor + '"' : "") +
        '><span class="mi-cal-swatch-check" aria-hidden="true">✓</span></button>'];
      for (var index = 0; index < EVENT_COLORS.length; index += 1) {
        var swatch = EVENT_COLORS[index];
        var selected = eventColorDraft === swatch.id;
        html.push('<button type="button" class="mi-cal-swatch" data-cal-swatch="' + swatch.id +
          '" aria-pressed="' + (selected ? "true" : "false") + '" aria-label="' + escapeHtml(swatch.name) +
          '" title="' + escapeHtml(swatch.name) + '" style="--mi-cal-color:' + swatch.hex +
          '"><span class="mi-cal-swatch-check" aria-hidden="true">✓</span></button>');
      }
      wrap.innerHTML = html.join("");
    }

    function syncGoogleMode() {
      var connected = googleConnected();
      node.querySelectorAll("[data-cal-google-only]").forEach(function (found) {
        found.hidden = !connected;
      });
      var scopeWrap = el("[data-cal-recurrence-scope-wrap]");
      if (scopeWrap) scopeWrap.hidden = !connected || !dialogRecurringInstance;
      var recurrenceField = el("[data-cal-recurrence-field]");
      if (recurrenceField) recurrenceField.hidden = !connected || dialogRecurringInstance;
      renderGoogleCalendarOptions(value("[data-cal-google-calendar]"));
      syncRecurrenceFields();
    }

    function openDialog(item, key) {
      var modal = el("[data-cal-modal]");
      var form = el("[data-cal-form]");
      if (!modal || !form) return;
      dialogReturnFocus = document.activeElement;
      setDialogStatus("", "");
      dialogRecurringInstance = Boolean(item && item.isRecurringInstance);
      attendeeDraft = [];
      recurrenceSnapshotBeforeEdit = null;
      var recurrenceModal = el("[data-cal-recurrence-modal]");
      if (recurrenceModal) recurrenceModal.hidden = true;
      closeScopeModal();
      form.reset();
      var start = key ? dateFromKey(key) : new Date();
      if (!key) start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
      else start.setHours(9, 0, 0, 0);
      var end = new Date(start);
      end.setHours(end.getHours() + 1);
      var itemStart = item && item.startsAt ? new Date(item.startsAt) : null;
      var itemEnd = item && item.endsAt ? new Date(item.endsAt) : null;
      if (itemStart && isNaN(itemStart.getTime())) itemStart = null;
      if (itemEnd && isNaN(itemEnd.getTime())) itemEnd = null;
      // 기본값은 언제나 종일이다(구글 웹 UI 와 같다).
      var allDay = item ? Boolean(item.isAllDay) : true;
      setValue("[data-cal-id]", (item && item.id) || "");
      setValue("[data-cal-updated-at]", (item && item.updatedAt) || "");
      setValue("[data-cal-title]", (item && item.title) || "");
      setValue("[data-cal-type]", (item && item.scheduleType) || "ad_setup");
      setValue("[data-cal-state]", (item && item.status) || "planned");
      setValue("[data-cal-priority]", (item && item.priority) || "medium");
      setValue("[data-cal-start]", dateKey(itemStart || start));
      setValue("[data-cal-end]", dateKey(itemEnd || itemStart || end));
      setValue("[data-cal-start-time]", allDay ? "" : timeInput(itemStart || start));
      setValue("[data-cal-end-time]", allDay ? "" : timeInput(itemEnd || end));
      setValue("[data-cal-assignee]", (item && item.assigneeName) || "");
      setValue("[data-cal-internal]", (item && item.internalNote) || "");
      setValue("[data-cal-location]", (item && item.location) || "");
      setValue("[data-cal-description]", (item && item.description) || "");
      var allDayToggle = el("[data-cal-all-day]");
      if (allDayToggle) allDayToggle.checked = allDay;
      var attendees = item && Array.isArray(item.attendees) ? item.attendees : [];
      for (var attendeeIndex = 0; attendeeIndex < attendees.length && attendeeDraft.length < ATTENDEE_LIMIT; attendeeIndex += 1) {
        var entry = attendees[attendeeIndex];
        var email = String((entry && entry.email) || entry || "").trim().toLowerCase();
        if (email && attendeeDraft.indexOf(email) === -1) attendeeDraft.push(email);
      }
      renderAttendeeChips();
      setAttendeeError("");
      // 색은 캘린더 목록보다 먼저 정해야 스와치가 처음 그려질 때 선택 상태가 맞는다.
      eventColorDraft = eventColorId(item && item.colorId);
      syncGoogleMode();
      renderGoogleCalendarOptions((item && item.googleCalendarId) || "");
      if (dialogRecurringInstance) {
        var summary = el("[data-cal-recurrence-summary]");
        if (summary) summary.textContent = String((item && item.recurrenceSummary) || "").trim() || "반복 일정입니다.";
        var scopeInstance = el('[data-cal-recurrence-scope][value="instance"]');
        if (scopeInstance) scopeInstance.checked = true;
      } else {
        applyRecurrence(item);
      }
      var conferenceUri = item && /^https:\/\//i.test(String(item.conferenceUri || "")) ? String(item.conferenceUri) : "";
      var conferenceWrap = el("[data-cal-conference-wrap]");
      var conferenceLink = el("[data-cal-conference-link]");
      var conferenceUrl = el("[data-cal-conference-url]");
      if (conferenceUrl && conferenceUri) conferenceUrl.href = conferenceUri;
      if (conferenceLink) conferenceLink.hidden = !conferenceUri;
      if (conferenceWrap) conferenceWrap.hidden = !googleConnected() || Boolean(conferenceUri);
      setDisclosure("attendees", attendeeDraft.length > 0);
      setDisclosure("location", Boolean(item && String(item.location || "").trim()));
      setDisclosure("description", Boolean(item && String(item.description || "").trim()));
      var title = el("[data-cal-dialog-title]");
      var remove = el("[data-cal-delete]");
      var advanced = el("[data-cal-advanced]");
      if (title) title.textContent = item ? "일정 수정" : "개인 일정 등록";
      if (remove) remove.hidden = !item;
      if (advanced) advanced.open = Boolean(item && (item.assigneeName || item.internalNote || (item.priority && item.priority !== "medium")));
      syncStartLabel();
      syncTimeFields();
      var calendarNote = el("[data-cal-readonly]");
      var calendarLabel = String((item && item.calendarName) || "").trim();
      var calendarReadOnly = Boolean(item && item.readOnly === true);
      if (calendarNote) {
        var noteParts = [];
        if (calendarLabel) noteParts.push("캘린더 · " + calendarLabel);
        if (calendarReadOnly) noteParts.push("읽기 전용 캘린더의 일정이라 모먼트 인사이트에서는 수정하거나 삭제할 수 없습니다.");
        calendarNote.textContent = noteParts.join(" ");
        calendarNote.hidden = noteParts.length === 0;
      }
      var readOnly = Boolean(item && (!canEdit(item) || calendarReadOnly));
      form.querySelectorAll("input, select, textarea").forEach(function (control) { control.disabled = readOnly; });
      // 스와치는 button 이라 위 셀렉터에 걸리지 않는다. 읽기 전용에서는 따로 잠근다.
      node.querySelectorAll("[data-cal-swatch]").forEach(function (control) { control.disabled = readOnly; });
      var save = el("[data-cal-save]");
      if (save) {
        save.hidden = readOnly;
        save.disabled = readOnly;
      }
      if (remove) {
        remove.hidden = !item || readOnly;
        remove.disabled = readOnly;
      }
      if (title && readOnly) title.textContent = "일정 보기";
      modal.hidden = false;
      window.requestAnimationFrame(function () {
        var titleInput = el("[data-cal-title]");
        if (titleInput) titleInput.focus();
      });
    }

    function closeDialog() {
      var modal = el("[data-cal-modal]");
      if (modal) modal.hidden = true;
      setDialogStatus("", "");
      closeRecurrenceModal(false);
      closeScopeModal();
      if (dialogReturnFocus && dialogReturnFocus.focus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus();
      dialogReturnFocus = null;
    }

    // 구글과 같은 순서다 — 반복 일정의 저장·삭제는 그 순간에 "이 일정만 /
    // 모든 일정" 을 묻고, 확인을 누르기 전에는 아무것도 보내지 않는다.
    function openScopeModal(mode) {
      var modal = el("[data-cal-scope-modal]");
      if (!modal) return false;
      scopeMode = mode === "delete" ? "delete" : "save";
      var title = el("[data-cal-scope-title]");
      var description = el("[data-cal-scope-description]");
      if (title) title.textContent = scopeMode === "delete" ? "반복 일정 삭제" : "반복 일정 수정";
      if (description) {
        description.textContent = scopeMode === "delete"
          ? "반복되는 일정입니다. 어디까지 삭제할까요?"
          : "반복되는 일정입니다. 어디까지 적용할까요?";
      }
      // 기본값은 언제나 "이 일정만" 이다.
      var instance = el('[data-cal-recurrence-scope][value="instance"]');
      if (instance) instance.checked = true;
      modal.hidden = false;
      window.requestAnimationFrame(function () {
        var confirmButton = el("[data-cal-scope-confirm]");
        if (confirmButton) confirmButton.focus();
      });
      return true;
    }

    function closeScopeModal() {
      var modal = el("[data-cal-scope-modal]");
      if (modal) modal.hidden = true;
      scopeMode = "";
    }

    function scopeValue() {
      var choice = el("[data-cal-recurrence-scope]:checked");
      return choice && choice.value === "all" ? "all" : "instance";
    }

    function formPayload() {
      var allDayToggle = el("[data-cal-all-day]");
      var sendUpdatesToggle = el("[data-cal-send-updates]");
      var conferenceToggle = el("[data-cal-conference]");
      var scopeChoice = el("[data-cal-recurrence-scope]:checked");
      var id = value("[data-cal-id]");
      var allDay = Boolean(allDayToggle && allDayToggle.checked);
      var startDate = String(value("[data-cal-start]") || "").slice(0, 10);
      var endDate = String(value("[data-cal-end]") || "").slice(0, 10) || startDate;
      var startTime = String(value("[data-cal-start-time]") || "").slice(0, 5) || "09:00";
      var endTime = String(value("[data-cal-end-time]") || "").slice(0, 5) || "10:00";
      var payload = {
        id: id,
        title: value("[data-cal-title]"),
        scheduleType: value("[data-cal-type]"),
        status: value("[data-cal-state]"),
        priority: value("[data-cal-priority]"),
        startsAt: startDate ? (allDay ? startDate : startDate + "T" + startTime) : "",
        endsAt: endDate ? (allDay ? endDate : endDate + "T" + endTime) : "",
        assigneeName: value("[data-cal-assignee]"),
        internalNote: value("[data-cal-internal]"),
        calendarId: "",
        expectedUpdatedAt: value("[data-cal-updated-at]"),
        isAllDay: allDay
      };
      if (googleConnected()) {
        payload.allDay = allDay;
        if (!dialogRecurringInstance) payload.recurrence = recurrenceRules();
        payload.attendees = attendeeDraft.map(function (email) { return { email: email }; });
        payload.sendUpdates = sendUpdatesToggle && sendUpdatesToggle.checked ? "all" : "none";
        payload.conference = Boolean(conferenceToggle && conferenceToggle.checked);
        payload.location = value("[data-cal-location]");
        payload.description = value("[data-cal-description]");
        payload.googleCalendarId = value("[data-cal-google-calendar]");
        // 빈 문자열이면 서버가 일정 색을 지우고 캘린더 색을 그대로 쓴다.
        payload.colorId = eventColorDraft;
        if (id && dialogRecurringInstance) payload.recurrenceScope = scopeChoice && scopeChoice.value === "all" ? "all" : "instance";
      }
      return payload;
    }

    async function submitForm() {
      var payload = formPayload();
      var save = el("[data-cal-save]");
      if (save) save.disabled = true;
      setStatus(payload.id ? "일정을 수정하는 중입니다." : "일정을 저장하는 중입니다.", "");
      try {
        await requestWorkItems(payload.id ? "PATCH" : "POST", payload);
        closeDialog();
        await loadItems();
      } catch (error) {
        // 구글 쓰기 실패(502)는 다이얼로그를 닫지도, 목록을 다시 불러오지도 않고 재시도할 수 있게 남긴다.
        var googleWriteFailed = Boolean(error && (error.status === 502 || error.code === "google_write_failed" || error.code === "needs_reconnect"));
        setStatus(error.message || "일정을 저장하지 못했습니다.", "warn");
        if (googleWriteFailed && save) save.focus();
      } finally {
        if (save) save.disabled = false;
      }
    }

    async function performDelete() {
      var id = value("[data-cal-id]");
      var expectedUpdatedAt = value("[data-cal-updated-at]");
      if (!id) return;
      var remove = el("[data-cal-delete]");
      if (remove) remove.disabled = true;
      try {
        var body = { id: id, expectedUpdatedAt: expectedUpdatedAt };
        if (dialogRecurringInstance) body.recurrenceScope = scopeValue();
        await requestWorkItems("DELETE", body);
        closeDialog();
        await loadItems();
      } catch (error) {
        setStatus(error.message || "일정을 삭제하지 못했습니다.", "warn");
        if (remove) {
          remove.disabled = false;
          remove.focus();
        }
      } finally {
        if (remove) remove.disabled = false;
      }
    }

    async function toggleCompletion(itemId, button) {
      var item = items.find(function (candidate) { return candidate.id === itemId; });
      if (!item) return;
      var nextStatus = item.status === "done" ? "planned" : "done";
      if (button) button.disabled = true;
      setStatus(nextStatus === "done" ? "일정을 완료 처리하는 중입니다." : "일정 완료를 해제하는 중입니다.", "");
      try {
        await requestWorkItems("PATCH", itemPayload(item, { status: nextStatus }));
        await loadItems();
        setStatus(nextStatus === "done" ? "일정을 완료 처리했습니다." : "일정 완료를 해제하고 예정 상태로 되돌렸습니다.", "ok");
      } catch (error) {
        setStatus(error.message || "완료 상태 변경을 저장하지 못했습니다.", "warn");
        if (button) button.disabled = false;
      }
    }

    // ── 날짜 드래그 이동 ─────────────────────────────────────
    function clearDragState() {
      window.clearTimeout(pointerTimer);
      pointerTimer = 0;
      draggingId = "";
      pointerDrag = null;
      node.querySelectorAll(".mi-cal-day.is-drop-target").forEach(function (day) { day.classList.remove("is-drop-target"); });
      node.querySelectorAll(".mi-cal-day-item.is-dragging").forEach(function (item) { item.classList.remove("is-dragging"); });
    }

    function setDropTarget(day) {
      node.querySelectorAll(".mi-cal-day.is-drop-target").forEach(function (candidate) {
        candidate.classList.toggle("is-drop-target", candidate === day);
      });
    }

    function closeMoveDialog(restore, message) {
      var pending = movePending;
      if (restore && pending) {
        var item = items.find(function (candidate) { return candidate.id === pending.itemId; });
        if (item) {
          item.startsAt = pending.originalStart;
          item.endsAt = pending.originalEnd;
        }
      }
      movePending = null;
      var modal = el("[data-cal-move-modal]");
      if (modal) modal.hidden = true;
      if (restore) renderAll();
      if (message) setStatus(message, "");
    }

    function openMoveConfirmation(itemId, targetDateKey) {
      var item = items.find(function (candidate) { return candidate.id === itemId; });
      if (!item || !targetDateKey || dateKey(item.startsAt) === targetDateKey) return;
      if (movePending) closeMoveDialog(true, "");
      var nextStart = shiftDateTime(item.startsAt, targetDateKey);
      if (!nextStart) return;
      var originalStartTime = new Date(item.startsAt).getTime();
      var nextStartTime = new Date(nextStart).getTime();
      var nextEnd = item.endsAt
        ? new Date(new Date(item.endsAt).getTime() + (nextStartTime - originalStartTime)).toISOString()
        : "";
      movePending = {
        itemId: item.id,
        originalStart: item.startsAt,
        originalEnd: item.endsAt || "",
        nextStart: nextStart,
        nextEnd: nextEnd
      };
      item.startsAt = nextStart;
      item.endsAt = nextEnd;
      renderAll();
      var modal = el("[data-cal-move-modal]");
      var itemNode = el("[data-cal-move-item]");
      var fromNode = el("[data-cal-move-from]");
      var toNode = el("[data-cal-move-to]");
      if (itemNode) itemNode.textContent = item.title;
      if (fromNode) fromNode.textContent = moveDateLabel(movePending.originalStart);
      if (toNode) toNode.textContent = moveDateLabel(movePending.nextStart);
      if (modal) modal.hidden = false;
      setStatus("변경할 날짜를 확인해주세요.", "");
      window.requestAnimationFrame(function () {
        var confirmButton = el("[data-cal-move-confirm]");
        if (confirmButton) confirmButton.focus();
      });
    }

    async function confirmMove() {
      if (!movePending) return;
      var pending = Object.assign({}, movePending);
      var item = items.find(function (candidate) { return candidate.id === pending.itemId; });
      var confirmButton = el("[data-cal-move-confirm]");
      if (!item) {
        closeMoveDialog(true, "이동할 일정을 다시 확인해주세요.");
        return;
      }
      if (confirmButton) confirmButton.disabled = true;
      setStatus("변경한 일정을 저장하는 중입니다.", "");
      try {
        await requestWorkItems("PATCH", itemPayload(item));
        closeMoveDialog(false, "");
        await loadItems();
      } catch (error) {
        movePending = pending;
        closeMoveDialog(true, "");
        setStatus(error.message || "일정 변경을 저장하지 못해 원래 날짜로 되돌렸습니다.", "warn");
      } finally {
        if (confirmButton) confirmButton.disabled = false;
      }
    }

    function dropDayFromPoint(clientX, clientY) {
      var found = document.elementFromPoint(clientX, clientY);
      return found && found.closest ? found.closest("[data-cal-drop-date]") : null;
    }

    // ── 이벤트 배선 (인라인 핸들러 없음) ─────────────────────
    var calendarNode = el("[data-cal-calendar]");
    if (calendarNode) {
      on(calendarNode, "dragstart", function (event) {
        var item = event.target.closest("[data-cal-drag-id]");
        if (!item) return;
        draggingId = item.getAttribute("data-cal-drag-id") || "";
        item.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", draggingId);
        }
      });
      on(calendarNode, "dragover", function (event) {
        if (!draggingId) return;
        var day = event.target.closest("[data-cal-drop-date]");
        if (!day) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        setDropTarget(day);
      });
      on(calendarNode, "drop", function (event) {
        if (!draggingId) return;
        var day = event.target.closest("[data-cal-drop-date]");
        if (!day) return;
        event.preventDefault();
        var itemId = draggingId;
        var targetDate = day.getAttribute("data-cal-drop-date") || "";
        ignoreClickUntil = Date.now() + 500;
        clearDragState();
        openMoveConfirmation(itemId, targetDate);
      });
      on(calendarNode, "dragend", function () { clearDragState(); });
      on(calendarNode, "pointerdown", function (event) {
        if (event.pointerType === "mouse") return;
        var item = event.target.closest("[data-cal-drag-id]");
        if (!item) return;
        window.clearTimeout(pointerTimer);
        pointerDrag = {
          itemId: item.getAttribute("data-cal-drag-id") || "",
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          targetDate: ""
        };
        pointerTimer = window.setTimeout(function () {
          if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
          pointerDrag.active = true;
          draggingId = pointerDrag.itemId;
          item.classList.add("is-dragging");
          var day = dropDayFromPoint(event.clientX, event.clientY);
          if (day) {
            pointerDrag.targetDate = day.getAttribute("data-cal-drop-date") || "";
            setDropTarget(day);
          }
        }, 320);
      });
    }

    on(window, "pointermove", function (event) {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      if (!pointerDrag.active) {
        var moved = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
        if (moved > 8) {
          window.clearTimeout(pointerTimer);
          pointerTimer = 0;
          pointerDrag = null;
        }
        return;
      }
      event.preventDefault();
      var day = dropDayFromPoint(event.clientX, event.clientY);
      if (!day) return;
      pointerDrag.targetDate = day.getAttribute("data-cal-drop-date") || "";
      setDropTarget(day);
    }, { passive: false });

    on(window, "pointerup", function (event) {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      var drag = Object.assign({}, pointerDrag);
      window.clearTimeout(pointerTimer);
      pointerTimer = 0;
      if (!drag.active) {
        pointerDrag = null;
        return;
      }
      event.preventDefault();
      ignoreClickUntil = Date.now() + 500;
      clearDragState();
      if (drag.targetDate) openMoveConfirmation(drag.itemId, drag.targetDate);
    });

    on(window, "pointercancel", function (event) {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      clearDragState();
    });

    on(node, "click", function (event) {
      if (event.target.closest("[data-cal-google-link]")) {
        event.stopPropagation();
        return;
      }
      var gloginLink = event.target.closest("[data-cal-glogin-link]");
      if (gloginLink) { startLoginLink(gloginLink); return; }
      var gloginUnlink = event.target.closest("[data-cal-glogin-unlink]");
      if (gloginUnlink) { unlinkLogin(gloginUnlink); return; }
      var gcalConnect = event.target.closest("[data-cal-gcal-connect]");
      if (gcalConnect) { startCalendarAuth(gcalConnect); return; }
      var gcalDisconnect = event.target.closest("[data-cal-gcal-disconnect]");
      if (gcalDisconnect) { disconnectCalendar(gcalDisconnect); return; }
      var gcalSync = event.target.closest("[data-cal-gcal-sync]");
      if (gcalSync) {
        if (!gcalSync.disabled) maybeSync("manual").catch(function () {});
        return;
      }
      var railToggle = event.target.closest("[data-cal-rail-toggle]");
      if (railToggle) { toggleCalendarVisibility(railToggle.getAttribute("data-cal-rail-toggle") || ""); return; }
      var railGroup = event.target.closest("[data-cal-rail-group]");
      if (railGroup) {
        var groupKey = railGroup.getAttribute("data-cal-rail-group") || "";
        var collapse = railGroup.getAttribute("aria-expanded") === "true";
        railCollapsed[groupKey] = collapse;
        railGroup.setAttribute("aria-expanded", collapse ? "false" : "true");
        var section = railGroup.closest(".mi-cal-rail-section");
        if (section) section.classList.toggle("is-collapsed", collapse);
        return;
      }
      var railRefresh = event.target.closest("[data-cal-rail-refresh]");
      if (railRefresh) { refreshCalendarCatalog(railRefresh); return; }
      var railDrawer = event.target.closest("[data-cal-rail-drawer]");
      if (railDrawer) {
        var body = el("[data-cal-body]");
        var open = body ? body.classList.toggle("is-rail-open") : false;
        railDrawer.setAttribute("aria-expanded", open ? "true" : "false");
        return;
      }
      var aclOpen = event.target.closest("[data-cal-acl]");
      if (aclOpen) {
        var aclTarget = aclOpen.getAttribute("data-cal-acl") || "";
        if (aclId === aclTarget) closeAclPanel();
        else requestCalendarAcl("list", { calendarId: aclTarget });
        return;
      }
      var aclRemove = event.target.closest("[data-cal-acl-remove]");
      if (aclRemove) { requestCalendarAcl("delete", { ruleId: aclRemove.getAttribute("data-cal-acl-remove") || "" }); return; }
      var aclAdd = event.target.closest("[data-cal-acl-add]");
      if (aclAdd) { addAclEmail(); return; }
      var aclClose = event.target.closest("[data-cal-acl-close]");
      if (aclClose) { closeAclPanel(); return; }
      var railNew = event.target.closest("[data-cal-rail-new]");
      if (railNew) {
        var newPanel = el("[data-cal-new-form]");
        setNewCalendarForm(Boolean(newPanel && newPanel.hidden));
        return;
      }
      var newCancel = event.target.closest("[data-cal-new-cancel]");
      if (newCancel) { setNewCalendarForm(false); return; }
      var createCalendar = event.target.closest("[data-cal-create-calendar]");
      if (createCalendar) { createCalendarFromForm(); return; }
      var inviteRemove = event.target.closest("[data-cal-invite-remove]");
      if (inviteRemove) {
        var removedInvite = inviteRemove.getAttribute("data-cal-invite-remove") || "";
        inviteDraft = inviteDraft.filter(function (email) { return email !== removedInvite; });
        renderInviteChips();
        return;
      }
      var swatch = event.target.closest("[data-cal-swatch]");
      if (swatch) {
        eventColorDraft = eventColorId(swatch.getAttribute("data-cal-swatch") || "");
        renderEventColorSwatches();
        return;
      }
      var recurrenceCancel = event.target.closest("[data-cal-recurrence-cancel]");
      if (recurrenceCancel) { closeRecurrenceModal(true); return; }
      var recurrenceDone = event.target.closest("[data-cal-recurrence-done]");
      if (recurrenceDone) { closeRecurrenceModal(false); return; }
      var recurrenceOverlay = event.target.closest("[data-cal-recurrence-modal]");
      if (recurrenceOverlay && event.target === recurrenceOverlay) { closeRecurrenceModal(true); return; }
      var scopeCancel = event.target.closest("[data-cal-scope-cancel]");
      if (scopeCancel) { closeScopeModal(); return; }
      var scopeConfirm = event.target.closest("[data-cal-scope-confirm]");
      if (scopeConfirm) {
        var mode = scopeMode;
        closeScopeModal();
        if (mode === "delete") performDelete();
        else if (mode === "save") submitForm();
        return;
      }
      var scopeOverlay = event.target.closest("[data-cal-scope-modal]");
      if (scopeOverlay && event.target === scopeOverlay) { closeScopeModal(); return; }
      var kindTab = event.target.closest("[data-cal-kind-tab]");
      if (kindTab) return;
      var timeToggle = event.target.closest("[data-cal-time-toggle]");
      if (timeToggle) {
        var allDayState = el("[data-cal-all-day]");
        if (allDayState) allDayState.checked = !allDayState.checked;
        syncTimeFields();
        return;
      }
      var disclosure = event.target.closest("[data-cal-expand]");
      if (disclosure) {
        setDisclosure(disclosure.getAttribute("data-cal-expand") || "", disclosure.getAttribute("aria-expanded") !== "true");
        return;
      }
      var attendeeRemove = event.target.closest("[data-cal-attendee-remove]");
      if (attendeeRemove) {
        var removedEmail = attendeeRemove.getAttribute("data-cal-attendee-remove") || "";
        attendeeDraft = attendeeDraft.filter(function (email) { return email !== removedEmail; });
        setAttendeeError("");
        renderAttendeeChips();
        return;
      }
      var moveConfirm = event.target.closest("[data-cal-move-confirm]");
      if (moveConfirm) { confirmMove(); return; }
      var moveCancel = event.target.closest("[data-cal-move-cancel]");
      if (moveCancel) { closeMoveDialog(true, "일정 변경을 취소했습니다."); return; }
      var moveModal = event.target.closest("[data-cal-move-modal]");
      if (moveModal && event.target === moveModal) { closeMoveDialog(true, "일정 변경을 취소했습니다."); return; }
      var quickDone = event.target.closest("[data-cal-quick-done]");
      if (quickDone) { toggleCompletion(quickDone.getAttribute("data-cal-quick-done") || "", quickDone); return; }
      var summaryFilter = event.target.closest("[data-cal-summary-filter]");
      if (summaryFilter) {
        var nextFilter = summaryFilter.getAttribute("data-cal-summary-filter") || "";
        var summaryLabel = (summaryFilter.querySelector("span") || {}).textContent || "선택 일정";
        activeFilter = activeFilter === nextFilter ? "" : nextFilter;
        agendaDateKey = "";
        if (activeFilter === "today") {
          monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
          loadItems();
          return;
        }
        renderAll();
        setStatus(activeFilter ? summaryLabel + "만 표시합니다." : "전체 일정을 표시합니다.", "");
        return;
      }
      var clearFilter = event.target.closest("[data-cal-filter-clear]");
      if (clearFilter) {
        activeFilter = "";
        agendaDateKey = "";
        renderAll();
        setStatus("전체 일정을 표시합니다.", "");
        return;
      }
      var create = event.target.closest("[data-cal-create]");
      if (create) { openDialog(null, ""); return; }
      var today = event.target.closest("[data-cal-today]");
      if (today) {
        monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        loadItems();
        return;
      }
      var pickerTrigger = event.target.closest("[data-cal-month-picker-trigger]");
      if (pickerTrigger) {
        var picker = el("[data-cal-month-picker]");
        if (picker && !picker.hidden) closeMonthPicker(true);
        else openMonthPicker();
        return;
      }
      var previousYear = event.target.closest("[data-cal-picker-year-prev]");
      var nextYear = event.target.closest("[data-cal-picker-year-next]");
      if (previousYear || nextYear) {
        monthPickerYear += nextYear ? 1 : -1;
        renderMonthPicker();
        return;
      }
      var pickerMonth = event.target.closest("[data-cal-picker-month]");
      if (pickerMonth) {
        var selectedMonth = Number(pickerMonth.getAttribute("data-cal-picker-month"));
        if (Number.isInteger(selectedMonth) && selectedMonth >= 0 && selectedMonth < 12) {
          monthCursor = new Date(monthPickerYear, selectedMonth, 1);
          closeMonthPicker(true);
          loadItems();
        }
        return;
      }
      var pickerCancel = event.target.closest("[data-cal-picker-cancel]");
      if (pickerCancel) { closeMonthPicker(true); return; }
      var previous = event.target.closest("[data-cal-month-prev]");
      var next = event.target.closest("[data-cal-month-next]");
      if (previous || next) {
        closeMonthPicker(false);
        monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + (next ? 1 : -1), 1);
        loadItems();
        return;
      }
      var dateOverflow = event.target.closest("[data-cal-date-overflow]");
      if (dateOverflow) {
        agendaDateKey = dateOverflow.getAttribute("data-cal-date-overflow") || "";
        activeFilter = "";
        renderAll();
        setStatus(agendaDateKey + "의 모든 일정을 가까운 일정에서 표시합니다.", "");
        return;
      }
      var dateButton = event.target.closest("[data-cal-date]");
      if (dateButton) { openDialog(null, dateButton.getAttribute("data-cal-date")); return; }
      var edit = event.target.closest("[data-cal-edit]");
      if (edit) {
        if (Date.now() < ignoreClickUntil) return;
        var editItem = items.find(function (candidate) { return candidate.id === edit.getAttribute("data-cal-edit"); });
        if (editItem) openDialog(editItem, "");
        return;
      }
      var deleteButton = event.target.closest("[data-cal-delete]");
      if (deleteButton) {
        var deleteId = value("[data-cal-id]");
        if (!deleteId) return;
        // 반복 인스턴스는 확인창이 곧 확인 절차다 — window.confirm 을 겹쳐 묻지 않는다.
        if (dialogRecurringInstance && openScopeModal("delete")) return;
        if (!window.confirm("이 일정을 삭제할까요?")) return;
        performDelete();
        return;
      }
      var dateCell = event.target.closest("[data-cal-cell-date]");
      if (dateCell) {
        if (Date.now() < ignoreClickUntil) return;
        openDialog(null, dateCell.getAttribute("data-cal-cell-date"));
        return;
      }
      var close = event.target.closest("[data-cal-close]");
      if (close) { closeDialog(); return; }
      var modal = event.target.closest("[data-cal-modal]");
      if (modal && event.target === modal) closeDialog();
    });

    on(node, "change", function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (target.matches("[data-cal-all-day]")) { syncTimeFields(); return; }
      if (target.matches("[data-cal-recurrence-preset]")) {
        syncRecurrenceFields();
        if (target.value === "custom") openRecurrenceModal();
        return;
      }
      if (target.matches("[data-cal-recurrence-unit]") || target.matches("[data-cal-recurrence-end]") || target.matches("[data-cal-recurrence-monthly-mode]")) {
        syncRecurrenceFields();
        return;
      }
      if (target.matches("[data-cal-recurrence-end-choice]")) {
        if (!target.checked) return;
        setValue("[data-cal-recurrence-end]", target.value);
        syncRecurrenceFields();
        return;
      }
      if (target.matches("[data-cal-google-calendar]")) { syncGoogleCalendarDot(); return; }
      if (target.matches("[data-cal-start]")) {
        var endInput = el("[data-cal-end]");
        if (endInput && (!endInput.value || endInput.value < target.value)) endInput.value = target.value;
        var recurrenceUntil = el("[data-cal-recurrence-until]");
        if (recurrenceUntil) recurrenceUntil.min = String(target.value || "").slice(0, 10);
        syncRecurrenceLabels();
      }
    });

    on(node, "keydown", function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      // 맞춤 반복 창은 편집 폼 안에 떠 있다. Enter 가 폼 제출로 새지 않게 여기서 막고,
      // 대신 "완료" 와 같은 동작으로 창만 닫는다.
      if (target.closest && target.closest("[data-cal-recurrence-modal]")) {
        if (event.key !== "Enter" || target.tagName === "BUTTON") return;
        event.preventDefault();
        closeRecurrenceModal(false);
        return;
      }
      if (target.matches("[data-cal-invite-input]")) {
        if (event.key !== "Enter" && event.key !== "," && event.key !== ";") return;
        event.preventDefault();
        commitInviteInput();
        return;
      }
      if (target.matches("[data-cal-acl-email]")) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        addAclEmail();
        return;
      }
      if (target.matches("[data-cal-attendee-input]")) {
        if (event.key !== "Enter" && event.key !== "," && event.key !== ";") return;
        event.preventDefault();
        commitAttendeeInput();
      }
    });

    on(node, "blur", function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (target.matches("[data-cal-invite-input]")) commitInviteInput();
      if (target.matches("[data-cal-attendee-input]")) commitAttendeeInput();
    }, true);

    var formNode = el("[data-cal-form]");
    if (formNode) {
      on(formNode, "submit", async function (event) {
        event.preventDefault();
        if (!commitAttendeeInput()) {
          var attendeeInput = el("[data-cal-attendee-input]");
          if (attendeeInput) attendeeInput.focus();
          return;
        }
        var payload = formPayload();
        if (value("[data-cal-recurrence-preset]") === "custom" && value("[data-cal-recurrence-end]") === "until") {
          var customUntil = el("[data-cal-recurrence-until]");
          var customUntilValue = String(value("[data-cal-recurrence-until]") || "").slice(0, 10);
          if (googleConnected() && (!customUntilValue || customUntilValue < String(payload.startsAt || "").slice(0, 10))) {
            setStatus("반복 종료일은 시작일과 같거나 이후여야 합니다.", "warn");
            if (customUntil) customUntil.focus();
            return;
          }
        }
        // 반복 인스턴스 수정은 여기서 멈추고 범위를 먼저 묻는다.
        if (payload.id && dialogRecurringInstance && openScopeModal("save")) return;
        await submitForm();
      });
    }

    on(window, "pointerdown", function (event) {
      var picker = el("[data-cal-month-picker]");
      var navigation = node.querySelector(".mi-cal-month-nav");
      if (picker && !picker.hidden && navigation && !navigation.contains(event.target)) closeMonthPicker(false);
    }, true);

    on(window, "focusin", function (event) {
      var picker = el("[data-cal-month-picker]");
      var navigation = node.querySelector(".mi-cal-month-nav");
      if (picker && !picker.hidden && navigation && !navigation.contains(event.target)) closeMonthPicker(false);
    }, true);

    on(window, "keydown", function (event) {
      var editorModal = el("[data-cal-modal]");
      var recurrenceModal = el("[data-cal-recurrence-modal]");
      if (recurrenceModal && !recurrenceModal.hidden) editorModal = recurrenceModal;
      var scopeModal = el("[data-cal-scope-modal]");
      if (scopeModal && !scopeModal.hidden) editorModal = scopeModal;
      if (event.key === "Tab" && editorModal && !editorModal.hidden) {
        var focusable = Array.from(editorModal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
          .filter(function (found) { return found.offsetParent !== null; });
        if (focusable.length) {
          var first = focusable[0];
          var last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (scopeModal && !scopeModal.hidden) {
        event.preventDefault();
        closeScopeModal();
        return;
      }
      if (recurrenceModal && !recurrenceModal.hidden) {
        event.preventDefault();
        closeRecurrenceModal(true);
        return;
      }
      var picker = el("[data-cal-month-picker]");
      if (picker && !picker.hidden) {
        event.preventDefault();
        closeMonthPicker(true);
        return;
      }
      if (movePending) closeMoveDialog(true, "일정 변경을 취소했습니다.");
      else closeDialog();
    });

    // ── 실장 비서 ────────────────────────────────────────────
    function setAssistantStatus(message, state) {
      var statusNode = el("[data-cal-assistant-status]");
      if (!statusNode) return;
      statusNode.textContent = message || "";
      statusNode.classList.toggle("is-ok", state === "ok");
      statusNode.classList.toggle("is-warn", state === "warn");
    }

    function setAssistantVoiceStatus(message) {
      var voiceNode = el("[data-cal-assistant-voice-status]");
      if (voiceNode) voiceNode.textContent = message || "";
    }

    // 대화에 딸려 보내는 일정은 화면에 보이는 내 행뿐이다.
    function assistantScheduleSnapshot() {
      return visibleItems()
        .filter(function (item) { return item.status !== "done" && item.startsAt; })
        .sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); })
        .slice(0, 60)
        .map(function (item) { return { title: item.title || "", startsAt: item.startsAt, status: item.status || "", isAllDay: Boolean(item.isAllDay) }; });
    }

    function assistantSpeechSupported() {
      return Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === "function";
    }

    function speakAssistantText(text) {
      if (!assistantSpeechSupported()) return;
      window.speechSynthesis.cancel();
      var utterance = new window.SpeechSynthesisUtterance(String(text || ""));
      var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      utterance.voice = voices.find(function (voice) { return /^ko(?:-|_)/i.test(voice.lang || "") && voice.localService === true; }) ||
        voices.find(function (voice) { return /^ko(?:-|_)/i.test(voice.lang || ""); }) || null;
      utterance.lang = "ko-KR";
      utterance.rate = 1.05;
      // destroy() 가 취소할지 판단하려면 "이 패널이 시킨 말인가" 를 알아야 한다.
      assistantSpeechOwned = true;
      window.speechSynthesis.speak(utterance);
    }

    function speakAssistantBriefing(rangeKey) {
      var briefing = buildAssistantBriefingSpeech(rangeKey, visibleItems());
      if (!assistantSpeechSupported()) {
        setAssistantVoiceStatus("이 브라우저는 음성 읽기를 지원하지 않습니다. 브리핑은 위 목록에서 확인해주세요.");
        return briefing;
      }
      speakAssistantText(briefing.text);
      setAssistantVoiceStatus(briefing.label + " 브리핑을 읽고 있습니다.");
      return briefing;
    }

    // 브리핑·완료는 서버 대화 없이도 돌아간다. 그래서 대화가 꺼져 있어도 이 둘은 막지 않는다.
    function assistantLocalIntent(text) {
      return assistantBriefingIntent(text) || Boolean(parseAssistantCompletion(text));
    }

    function syncAssistantControls() {
      var sendButton = el("[data-cal-assistant-send]");
      if (!sendButton) return;
      var text = String(value("[data-cal-assistant-input]") || "").trim();
      sendButton.disabled = !assistantChatReady && !assistantLocalIntent(text);
    }

    function assistantClockLabel(item) {
      var date = new Date(item.startsAt);
      if (isNaN(date.getTime())) return "";
      if (item.isAllDay) return "종일";
      var hours = date.getHours();
      var minutes = date.getMinutes();
      return (hours < 12 ? "오전 " + (hours === 0 ? 12 : hours) : "오후 " + (hours === 12 ? 12 : hours - 12)) + "시" +
        (minutes ? " " + minutes + "분" : "");
    }

    function matchAssistantCompletionTargets(query) {
      var normalizedQuery = String(query || "").replace(/\s+/g, "").toLowerCase();
      if (!normalizedQuery) return [];
      return items.filter(function (item) {
        if (item.status === "done" || !item.id || !item.updatedAt) return false;
        var title = String(item.title || "").replace(/\s+/g, "").toLowerCase();
        return Boolean(title) && (title.indexOf(normalizedQuery) !== -1 || normalizedQuery.indexOf(title) !== -1);
      });
    }

    // 완료 처리는 이미 있는 /api/my/work-items 헬퍼를 그대로 쓴다(새 경로를 만들지 않는다).
    function patchAssistantComplete(item) {
      return requestWorkItems("PATCH", { action: "assistant-complete", id: item.id, expectedUpdatedAt: item.updatedAt });
    }

    // 완료는 되돌리기 어려운 쓰기다. 음성이든 버튼이든 반드시 사람이 한 번 확인한다.
    function confirmAssistantComplete(item) {
      return window.confirm('"' + (item.title || "제목 없는 업무") + '" 업무를 완료 처리할까요?');
    }

    function assistantAgendaRow(item) {
      var row = document.createElement("div");
      row.className = "mi-cal-assistant-agenda-item";
      var time = document.createElement("time");
      time.textContent = assistantClockLabel(item);
      var title = document.createElement("strong");
      title.textContent = item.title || "제목 없는 업무";
      row.append(time, title);
      if (!item.id || !item.updatedAt || !canEdit(item)) return row;
      var complete = document.createElement("button");
      complete.type = "button";
      complete.className = "mi-cal-assistant-complete";
      complete.textContent = "완료";
      complete.setAttribute("aria-label", (item.title || "제목 없는 업무") + " 완료 처리");
      // 이 버튼은 렌더마다 새로 만들고 destroy() 의 innerHTML 비우기와 함께 사라진다.
      // 그래서 windowListeners 에 쌓지 않는다(쌓으면 렌더 횟수만큼 목록이 늘어난다).
      complete.addEventListener("click", async function () {
        if (destroyed) return;
        if (!confirmAssistantComplete(item)) return;
        complete.disabled = true;
        setAssistantStatus("업무를 완료 처리하는 중입니다.", "");
        try {
          var payload = await patchAssistantComplete(item);
          await loadItems();
          if (destroyed) return;
          setAssistantStatus(payload && payload.unchanged ? "이미 완료된 업무였습니다." : "업무를 완료 처리했습니다.", "ok");
        } catch (error) {
          if (destroyed) return;
          complete.disabled = false;
          setAssistantStatus(error.message || "업무 완료 처리에 실패했습니다.", "warn");
        }
      });
      row.appendChild(complete);
      return row;
    }

    function renderAssistantBriefing() {
      var agenda = el("[data-cal-assistant-agenda]");
      if (!agenda) return;
      var now = new Date();
      var todayKey = dateKey(now);
      var openItems = visibleItems().filter(function (item) { return item.status !== "done"; });
      var metrics = {
        today: openItems.filter(function (item) { return dateKey(item.startsAt) === todayKey; }).length,
        overdue: openItems.filter(function (item) { var key = dateKey(item.startsAt); return Boolean(key) && key < todayKey; }).length,
        needs_check: openItems.filter(function (item) { return item.status === "needs_check"; }).length,
        next: openItems.filter(function (item) { return dateKey(item.startsAt) > todayKey; }).length
      };
      node.querySelectorAll("[data-cal-assistant-metric]").forEach(function (metricNode) {
        metricNode.textContent = String(metrics[metricNode.getAttribute("data-cal-assistant-metric")] || 0);
      });
      agenda.innerHTML = "";
      var weekEndKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
      var tableItems = openItems.filter(function (item) {
        var key = dateKey(item.startsAt);
        return Boolean(key) && key >= todayKey && key <= weekEndKey;
      }).sort(function (a, b) { return new Date(a.startsAt) - new Date(b.startsAt); }).slice(0, 10);
      var dayGroups = {};
      tableItems.forEach(function (item) {
        var key = dateKey(item.startsAt);
        if (!dayGroups[key]) dayGroups[key] = [];
        dayGroups[key].push(item);
      });
      var dayKeys = Object.keys(dayGroups).sort();
      if (dayKeys.indexOf(todayKey) === -1) dayKeys.unshift(todayKey);
      dayKeys.forEach(function (key) {
        var headerDate = dateFromKey(key);
        var header = document.createElement("div");
        header.className = "mi-cal-assistant-day";
        var headerLabel = (headerDate.getMonth() + 1) + "월 " + headerDate.getDate() + "일 (" + ASSISTANT_WEEKDAYS[headerDate.getDay()] + ")";
        header.textContent = key === todayKey ? "오늘 · " + headerLabel : headerLabel;
        agenda.appendChild(header);
        var dayItems = dayGroups[key] || [];
        if (!dayItems.length) {
          var empty = document.createElement("div");
          empty.className = "mi-cal-assistant-empty";
          empty.textContent = "일정 없음";
          agenda.appendChild(empty);
          return;
        }
        dayItems.forEach(function (item) { agenda.appendChild(assistantAgendaRow(item)); });
      });
    }

    function renderAssistantChatCard(question, reply) {
      var results = el("[data-cal-assistant-results]");
      if (!results) return;
      var placeholder = results.firstElementChild;
      if (placeholder && placeholder.classList.contains("mi-cal-assistant-empty") && results.children.length === 1) results.innerHTML = "";
      var card = document.createElement("div");
      card.className = "mi-cal-assistant-chat";
      var asked = document.createElement("span");
      asked.className = "mi-cal-assistant-chat-question";
      asked.textContent = question;
      var answered = document.createElement("p");
      answered.className = "mi-cal-assistant-chat-reply";
      answered.textContent = reply;
      card.append(asked, answered);
      results.prepend(card);
      while (results.children.length > 6) results.removeChild(results.lastElementChild);
    }

    async function runAssistantCompletion(query) {
      var targets = matchAssistantCompletionTargets(query);
      if (!targets.length) return setAssistantStatus("‘" + query + "’와 일치하는 미완료 업무를 찾지 못했습니다.", "warn");
      if (targets.length > 1) {
        return setAssistantStatus("‘" + query + "’는 여러 업무와 일치합니다: " +
          targets.slice(0, 3).map(function (item) { return item.title; }).join(", ") +
          ". 더 정확한 제목으로 말씀해주세요.", "warn");
      }
      var target = targets[0];
      if (!confirmAssistantComplete(target)) return setAssistantStatus("‘" + (target.title || query) + "’ 완료 처리를 취소했습니다.", "warn");
      setAssistantStatus("업무를 완료 처리하는 중입니다.", "");
      try {
        var payload = await patchAssistantComplete(target);
        await loadItems();
        if (destroyed) return;
        var spoken = payload && payload.unchanged ? "이미 완료된 업무였습니다." : "‘" + (target.title || query) + "’ 업무를 완료 처리했습니다.";
        setAssistantStatus(spoken, "ok");
        speakAssistantText(spoken);
      } catch (error) {
        if (destroyed) return;
        setAssistantStatus("‘" + (target.title || query) + "’ 완료 처리 실패: " + (error.message || "요청 오류"), "warn");
      }
    }

    async function askAssistant(message) {
      var sendButton = el("[data-cal-assistant-send]");
      setAssistantStatus("실장이 생각 중입니다…", "");
      if (sendButton) sendButton.disabled = true;
      try {
        var response = await doFetch(apiUrl("/assistant-chat"), {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: message,
            history: assistantChatHistory.slice(-12),
            schedule: assistantScheduleSnapshot()
          }),
          timeoutMs: 30000
        });
        var payload = await readPayload(response, "실장 응답을 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload || payload.ok !== true) throw new Error(payload && payload.message ? payload.message : "실장 응답에 실패했습니다.");
        assistantChatHistory.push({ role: "user", text: message }, { role: "assistant", text: payload.reply });
        while (assistantChatHistory.length > 12) assistantChatHistory.shift();
        renderAssistantChatCard(message, payload.reply);
        speakAssistantText(payload.reply);
        setAssistantStatus("실장이 답변했습니다.", "ok");
      } catch (error) {
        if (destroyed) return;
        setAssistantStatus(error.message || "실장 대화에 실패했습니다.", "warn");
      } finally {
        if (!destroyed) syncAssistantControls();
      }
    }

    // 명령 라우터: 브리핑 → 완료 → 자유 대화. 앞의 둘은 이 화면 안에서 끝난다.
    async function runAssistantPrompt(text) {
      var prompt = String(text || "").trim();
      if (!prompt) return setAssistantStatus("실장에게 전할 내용을 입력해주세요.", "warn");
      if (assistantBriefingIntent(prompt)) {
        assistantBriefingRange = parseAssistantBriefingRange(prompt);
        setValue("[data-cal-assistant-input]", "");
        syncAssistantControls();
        renderAssistantBriefing();
        speakAssistantBriefing(assistantBriefingRange);
        return setAssistantStatus((ASSISTANT_RANGE_LABELS[assistantBriefingRange] || "오늘") + " 일정을 브리핑합니다.", "ok");
      }
      var completionQuery = parseAssistantCompletion(prompt);
      if (completionQuery) {
        setValue("[data-cal-assistant-input]", "");
        syncAssistantControls();
        return runAssistantCompletion(completionQuery);
      }
      if (!assistantChatReady) return setAssistantStatus("실장 대화 기능이 아직 연결되지 않았습니다.", "warn");
      setValue("[data-cal-assistant-input]", "");
      syncAssistantControls();
      return askAssistant(prompt);
    }

    function applyAssistantAccount() {
      syncAssistantControls();
      if (assistantVoice) assistantVoice.syncAccount();
      if (!assistantChatReady) setAssistantStatus("실장 대화 기능이 아직 연결되지 않았습니다.", "warn");
    }

    // 계정 태그는 마운트 때 한 번만 받는다. 이 값이 상시 대기 저장 키의 네임스페이스가 된다.
    async function loadAssistantAccount() {
      if (destroyed) return;
      try {
        var response = await doFetch(apiUrl("/assistant-chat"), { method: "GET", cache: "no-store", timeoutMs: 15000 });
        var payload = await readPayload(response, "실장 비서 상태를 확인할 수 없습니다.");
        if (destroyed) return;
        if (!response.ok || !payload || payload.ok !== true) throw new Error(payload && payload.message ? payload.message : "실장 비서 상태를 확인할 수 없습니다.");
        assistantAccountTag = String(payload.accountTag || "");
        assistantChatReady = payload.ready === true;
        applyAssistantAccount();
      } catch (error) {
        if (destroyed) return;
        assistantAccountTag = "";
        assistantChatReady = false;
        applyAssistantAccount();
        setAssistantStatus(error.message || "실장 비서 상태를 확인하지 못했습니다.", "warn");
      }
    }

    function initAssistant() {
      var input = el("[data-cal-assistant-input]");
      var sendButton = el("[data-cal-assistant-send]");
      var micButton = el("[data-cal-assistant-mic]");
      var wakeButton = el("[data-cal-assistant-wake]");
      var readButton = el("[data-cal-assistant-read]");
      if (!input || !sendButton) return;

      on(input, "input", syncAssistantControls);
      on(sendButton, "click", function () {
        runAssistantPrompt(String(input.value || "")).catch(function () {});
      });

      // 음성은 있으면 얹고 없으면 조용히 접는다. 없다고 해서 던지지 않는다 —
      // 브리핑·완료·대화는 텍스트만으로 전부 동작해야 한다.
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      var recognition = null;
      var wakeMode = false;
      var wakeTimer = 0;
      var stopped = false;

      function voiceAlive() {
        return !stopped && !destroyed;
      }

      function stopRecognition() {
        wakeMode = false;
        window.clearTimeout(wakeTimer);
        wakeTimer = 0;
        if (micButton) micButton.classList.remove("is-listening");
        if (wakeButton) {
          wakeButton.classList.remove("is-active");
          wakeButton.setAttribute("aria-pressed", "false");
        }
        if (recognition) {
          recognition.onend = null;
          try { recognition.stop(); } catch (error) {}
        }
        recognition = null;
      }

      function recognitionError(event) {
        var code = event && event.error ? event.error : "unknown";
        if (code === "not-allowed" || code === "service-not-allowed") setAssistantVoiceStatus("마이크 권한이 차단되었습니다. 브라우저 주소창의 사이트 설정에서 마이크를 허용해주세요.");
        else if (code !== "no-speech" && code !== "aborted") setAssistantVoiceStatus("음성 인식 오류: " + code);
      }

      function createRecognition(continuous) {
        var instance = new SpeechRecognition();
        instance.lang = "ko-KR";
        instance.continuous = continuous;
        instance.interimResults = true;
        instance.maxAlternatives = 1;
        return instance;
      }

      function readStandbyPreference() {
        var key = assistantStandbyKey(assistantAccountTag);
        if (!key) return false;
        try { return window.localStorage.getItem(key) === "on"; } catch (error) { return false; }
      }

      function writeStandbyPreference(nextOn) {
        var key = assistantStandbyKey(assistantAccountTag);
        if (!key) return;
        try { window.localStorage.setItem(key, nextOn ? "on" : "off"); } catch (error) {}
      }

      function standbyLoop() {
        if (!voiceAlive() || !wakeMode) return;
        if (document.hidden) {
          wakeTimer = window.setTimeout(standbyLoop, 1200);
          return;
        }
        recognition = createRecognition(true);
        var fired = false;
        var processedFinalLength = 0;
        recognition.onresult = function (event) {
          if (!voiceAlive()) return stopRecognition();
          if (fired) return;
          var heard = "";
          var finals = "";
          for (var index = 0; index < event.results.length; index += 1) {
            heard += event.results[index][0].transcript;
            if (event.results[index].isFinal) finals += event.results[index][0].transcript;
          }
          if (window.speechSynthesis && window.speechSynthesis.speaking) {
            processedFinalLength = finals.length;
            return setAssistantVoiceStatus("브리핑을 읽는 중에는 새 명령을 받지 않습니다.");
          }
          var newFinal = finals.slice(processedFinalLength).trim();
          // 최종 인식 결과에만 반응한다. 중간 결과로 실행하면 말하는 도중에
          // 완료 처리가 먼저 나가 버린다 — 되돌릴 수 없는 쓰기라 특히 위험하다.
          if (!newFinal) {
            var interimWake = ASSISTANT_WAKE_INTERIM_PATTERN.test(heard);
            return setAssistantVoiceStatus(interimWake ? "네, 듣고 있습니다. 명령을 이어서 말씀해주세요." : "상시 대기 중 · 들림: " + heard.trim().slice(-32));
          }
          processedFinalLength = finals.length;
          var command = "";
          var wakeMatch = finals.match(ASSISTANT_WAKE_PATTERN);
          if (wakeMatch) {
            command = String(wakeMatch[1] || "").trim();
            if (!command) return setAssistantVoiceStatus("네, 듣고 있습니다. 명령을 이어서 말씀해주세요.");
          } else {
            // 호출어가 없으면 브리핑·완료 문장만 받는다(대표실의 광고주 전환 갈래는 옮기지 않았다).
            if (!assistantLocalIntent(newFinal)) return setAssistantVoiceStatus("상시 대기 중 · 들림: " + finals.trim().slice(-32));
            command = newFinal;
          }
          fired = true;
          input.value = command;
          syncAssistantControls();
          setAssistantVoiceStatus("실장이 명령을 받아 바로 실행합니다.");
          if (recognition) try { recognition.stop(); } catch (error) {}
          window.setTimeout(function () {
            if (voiceAlive() && !sendButton.disabled) sendButton.click();
          }, 250);
        };
        recognition.onerror = function (event) {
          recognitionError(event);
          if (event && (event.error === "not-allowed" || event.error === "service-not-allowed")) {
            // 마이크가 막히면 상시 대기를 꺼 둔다. 다음 방문에 몰래 다시 켜지지 않게 하는 안전 기본값이다.
            writeStandbyPreference(false);
            stopRecognition();
          }
        };
        recognition.onend = function () {
          recognition = null;
          if (!voiceAlive() || !wakeMode) return;
          wakeTimer = window.setTimeout(standbyLoop, fired ? 700 : 450);
        };
        try { recognition.start(); } catch (error) { wakeTimer = window.setTimeout(standbyLoop, 1500); }
      }

      function startStandby() {
        stopRecognition();
        wakeMode = true;
        if (wakeButton) {
          wakeButton.classList.add("is-active");
          wakeButton.setAttribute("aria-pressed", "true");
        }
        setAssistantVoiceStatus("상시 대기 중 — ‘실장님’이라고 부른 뒤 명령을 말씀해주세요.");
        standbyLoop();
      }

      if (micButton) {
        on(micButton, "click", function () {
          if (!SpeechRecognition) return setAssistantVoiceStatus("이 브라우저는 음성 인식을 지원하지 않습니다. Chrome에서 이용해주세요.");
          stopRecognition();
          var base = String(input.value || "").trim();
          var heard = "";
          recognition = createRecognition(false);
          micButton.classList.add("is-listening");
          setAssistantVoiceStatus("듣는 중입니다. 명령을 말씀해주세요.");
          recognition.onresult = function (event) {
            if (!voiceAlive()) return stopRecognition();
            heard = "";
            for (var index = 0; index < event.results.length; index += 1) heard += event.results[index][0].transcript;
            input.value = (base ? base + "\n" : "") + heard.trim();
            syncAssistantControls();
          };
          recognition.onerror = recognitionError;
          recognition.onend = function () {
            micButton.classList.remove("is-listening");
            recognition = null;
            if (voiceAlive()) setAssistantVoiceStatus(heard.trim() ? "음성 입력을 완료했습니다. 내용을 확인한 뒤 보내주세요." : "음성을 인식하지 못했습니다. 다시 눌러 말씀해주세요.");
          };
          try { recognition.start(); } catch (error) { stopRecognition(); setAssistantVoiceStatus("마이크를 시작하지 못했습니다. 잠시 후 다시 시도해주세요."); }
        });
      }

      if (wakeButton) {
        on(wakeButton, "click", function () {
          if (!SpeechRecognition) return setAssistantVoiceStatus("이 브라우저는 음성 인식을 지원하지 않습니다. Chrome에서 이용해주세요.");
          if (!assistantAccountTag) return setAssistantVoiceStatus("계정을 확인하는 중입니다. 잠시 후 다시 눌러주세요.");
          if (wakeMode) {
            writeStandbyPreference(false);
            stopRecognition();
            return setAssistantVoiceStatus("실장 상시 호출을 껐습니다. 버튼을 누르면 다시 켜집니다.");
          }
          writeStandbyPreference(true);
          startStandby();
        });
      }

      if (readButton) {
        on(readButton, "click", function () {
          speakAssistantBriefing(assistantBriefingRange);
        });
      }

      if (!SpeechRecognition) {
        if (micButton) micButton.hidden = true;
        if (wakeButton) wakeButton.hidden = true;
      }
      if (!assistantSpeechSupported() && readButton) readButton.hidden = true;
      if (!SpeechRecognition && !assistantSpeechSupported()) {
        setAssistantVoiceStatus("이 브라우저는 음성 기능을 지원하지 않습니다. 아래 입력창으로 명령해주세요.");
      }

      assistantVoice = {
        syncAccount: function () {
          if (!wakeButton) return;
          // 계정 태그가 오기 전에는 토글을 잠가 둔다. 공용 키로 흘러 내려가면
          // 한 브라우저의 두 계정이 서로의 상시 대기 설정을 물려받는다.
          var enabled = Boolean(SpeechRecognition) && Boolean(assistantAccountTag);
          wakeButton.disabled = !enabled;
          if (!enabled || wakeMode) return;
          if (readStandbyPreference()) startStandby();
        },
        stop: function () {
          stopped = true;
          stopRecognition();
        }
      };
    }

    function stopAssistant() {
      if (assistantVoice) assistantVoice.stop();
      assistantVoice = null;
      if (assistantSpeechOwned && window.speechSynthesis) window.speechSynthesis.cancel();
      assistantSpeechOwned = false;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      requestGeneration += 1;
      window.clearTimeout(pointerTimer);
      stopAssistant();
      windowListeners.forEach(function (entry) {
        entry[0].removeEventListener(entry[1], entry[2], entry[3]);
      });
      windowListeners = [];
      node.innerHTML = "";
    }

    async function refresh() {
      if (destroyed) return;
      await loadItems();
      await refreshCalendarBanner().catch(function () {});
      await refreshLoginBanner().catch(function () {});
      maybeSync("auto").catch(function () {});
    }

    consumeNoticeParams();
    initAssistant();
    syncAssistantControls();
    renderAll();
    loadItems().then(function () {
      if (destroyed) return;
      return refreshCalendarBanner().catch(function () {});
    }).then(function () {
      if (destroyed) return;
      return refreshLoginBanner().catch(function () {});
    }).then(function () {
      if (destroyed) return;
      return loadAssistantAccount().catch(function () {});
    }).then(function () {
      if (destroyed) return;
      maybeSync("auto").catch(function () {});
    }).catch(function () {});

    return {
      version: VERSION,
      destroy: destroy,
      refresh: function () { return refresh().catch(function () {}); },
      sync: function (trigger) { return maybeSync(trigger).catch(function () {}); },
      isDestroyed: function () { return destroyed; }
    };
  }

  window.MomentPersonalCalendar = {
    VERSION: VERSION,
    mount: mount,
    markupHtml: markupHtml,
    EVENT_COLORS: EVENT_COLORS,
    STATUS_LABELS: STATUS_LABELS,
    TYPE_LABELS: TYPE_LABELS,
    RECURRENCE_DAY_CODES: RECURRENCE_DAY_CODES,
    RECURRENCE_DAY_NAMES: RECURRENCE_DAY_NAMES,
    RECURRENCE_ORDINAL_NAMES: RECURRENCE_ORDINAL_NAMES,
    ATTENDEE_LIMIT: ATTENDEE_LIMIT,
    EMAIL_PATTERN: EMAIL_PATTERN,
    LOGIN_NOTICES: LOGIN_NOTICES,
    ASSISTANT_RANGE_LABELS: ASSISTANT_RANGE_LABELS,
    ASSISTANT_WEEKDAYS: ASSISTANT_WEEKDAYS,
    ASSISTANT_BRIEFING_INTENT: ASSISTANT_BRIEFING_INTENT,
    ASSISTANT_COMPLETION_PATTERN: ASSISTANT_COMPLETION_PATTERN,
    ASSISTANT_WAKE_PATTERN: ASSISTANT_WAKE_PATTERN,
    assistantBriefingIntent: assistantBriefingIntent,
    parseAssistantBriefingRange: parseAssistantBriefingRange,
    parseAssistantCompletion: parseAssistantCompletion,
    assistantRangeWindow: assistantRangeWindow,
    assistantSpokenWhen: assistantSpokenWhen,
    buildAssistantBriefingSpeech: buildAssistantBriefingSpeech,
    assistantStandbyKey: assistantStandbyKey,
    escapeHtml: escapeHtml,
    gcalColor: gcalColor,
    eventColorId: eventColorId,
    itemColor: itemColor,
    itemTextColor: itemTextColor,
    statusLabel: statusLabel,
    typeLabel: typeLabel,
    dateKey: dateKey,
    dateFromKey: dateFromKey,
    parseRecurrence: parseRecurrence,
    syncAgeLabel: syncAgeLabel,
    loginNotice: loginNotice,
    calendarNotice: calendarNotice
  };
})();
