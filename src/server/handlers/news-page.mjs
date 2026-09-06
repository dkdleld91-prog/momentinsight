// 공개 /news 페이지 서버 렌더링(2026-09-06 피드백 홈 3): 검색 로봇이 기사 제목을 바로 읽도록
// 기사 목록을 HTML에 넣어 보낸다. 화면 상호작용(플랫폼·주제 필터)은 public/mi-news-page.js 가
// 같은 데이터(#news-data)로 이어받는다. 세션·광고주 데이터는 없다.

const SITE = "https://insight.momentlabs.co.kr";
const KAKAO = "https://pf.kakao.com/_ixoLxfX";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(link) {
  const text = String(link || "").trim();
  return /^https?:\/\//i.test(text) ? text : "#";
}

function dateLabel(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function collectArticles(news) {
  const out = [];
  for (const key of ["naver", "coupang", "elevenst", "gmarket"]) {
    const section = news?.[key];
    if (!section || section.ok === false) continue;
    const items = Array.isArray(section.all) && section.all.length
      ? section.all
      : [section.lead, ...(section.items || [])].filter(Boolean);
    for (const item of items) {
      out.push({
        platform: key,
        title: String(item?.title || ""),
        link: safeHref(item?.link),
        source: String(item?.source || ""),
        publishedAt: String(item?.publishedAt || ""),
        topic: String(item?.topic || ""),
      });
    }
  }
  out.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return out;
}

function topicChips(items) {
  const counts = new Map();
  for (const item of items) if (item.topic) counts.set(item.topic, (counts.get(item.topic) || 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (!keys.length) return "";
  return [`<button class="chip on" type="button" data-news-topic="all">주제 전체</button>`]
    .concat(keys.map((key) => `<button class="chip" type="button" data-news-topic="${escapeHtml(key)}">${escapeHtml(key)} ${counts.get(key)}</button>`))
    .join("");
}

function rows(items) {
  if (!items.length) return `<div class="empty">이번 주 셀러 관련 기사가 없습니다.</div>`;
  return items.map((item) => `<a class="row is-${escapeHtml(item.platform)}" href="${escapeHtml(item.link)}" target="_blank" rel="noopener nofollow"><span class="src"><i></i>${platformLabel(item.platform)}</span><span class="t">${escapeHtml(item.title)}<small>${escapeHtml([item.source, item.topic].filter(Boolean).join(" · "))}</small></span><span class="d">${escapeHtml(dateLabel(item.publishedAt))}</span></a>`).join("");
}

export function platformLabel(platform) {
  return { naver: "네이버", coupang: "쿠팡", elevenst: "11번가", gmarket: "G마켓", openmarket: "11번가·G마켓" }[platform] || "기타";
}

const STYLE = `
  :root { --navy: #061a3a; --ink: #111827; --muted: #667085; --line: #dfe5ef; --bg: #f4f6fa; --blue: #2d6ac5; --naver: #03c75a; --coupang: #4a9ed2; --grey: #f8fafc; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; line-height: 1.5; word-break: keep-all; }
  a { color: inherit; }
  .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
  .top { background: #fff; border-bottom: 1px solid var(--line); }
  .top-inner { display: flex; align-items: center; gap: 12px; min-height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; font-weight: 800; color: var(--navy); }
  .brand .mk { width: 34px; height: 34px; border-radius: 10px; background: var(--navy); color: #fff; display: grid; place-items: center; font-size: 13px; }
  .top-links { margin-left: auto; display: flex; gap: 8px; }
  .btn { display: inline-flex; align-items: center; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--navy); font-weight: 700; font-size: 13px; text-decoration: none; }
  .btn.primary { background: var(--navy); color: #fff; border-color: transparent; }
  .head { padding: 34px 0 14px; }
  .head .kicker { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }
  .head h1 { margin: 6px 0 6px; font-size: 30px; color: var(--navy); letter-spacing: -0.03em; }
  .head p { margin: 0; color: var(--muted); font-size: 14px; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 0 12px; }
  .chip { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--muted); cursor: pointer; }
  .chip.on { background: var(--navy); color: #fff; border-color: transparent; }
  .bar .meta { margin-left: auto; font-size: 12.5px; color: var(--muted); }
  .list { display: grid; gap: 8px; margin: 0 0 40px; }
  .row { display: grid; grid-template-columns: 96px 1fr 130px; gap: 12px; align-items: center; padding: 12px 14px; background: #fff; border: 1px solid var(--line); border-radius: 12px; text-decoration: none; }
  .row:hover { border-color: var(--blue); }
  .row .src { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .row .src i { width: 8px; height: 8px; border-radius: 50%; background: var(--naver); }
  .row.is-coupang .src i { background: var(--coupang); }
  .row.is-elevenst .src i { background: #ef7d1a; }
  .row.is-gmarket .src i { background: #0aa87a; }
  .row .t { font-size: 15px; font-weight: 700; color: var(--navy); }
  .row .t small { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--muted); }
  .row .d { text-align: right; font-size: 12px; color: var(--muted); }
  .empty { padding: 30px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed var(--line); border-radius: 12px; }
  .cta { margin: 0 0 40px; padding: 18px 20px; background: #fff; border: 1px solid var(--line); border-radius: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .cta b { color: var(--navy); }
  .cta span { color: var(--muted); font-size: 13.5px; }
  .cta .btn { margin-left: auto; }
  footer { border-top: 1px solid var(--line); background: #fff; }
  .foot-inner { display: flex; flex-wrap: wrap; gap: 8px 18px; min-height: 60px; align-items: center; font-size: 12.5px; color: var(--muted); }
  .foot-inner a { text-decoration: none; }
  @media (max-width: 720px) { .row { grid-template-columns: 1fr; gap: 4px; } .row .d { text-align: left; } .cta .btn { margin-left: 0; } .head h1 { font-size: 24px; } }
`;

export function renderNewsPage(news, nowMs = Date.now()) {
  const items = collectArticles(news);
  const naver = news?.naver && news.naver.ok !== false ? Number(news.naver.count7d || 0) : 0;
  const coupang = news?.coupang && news.coupang.ok !== false ? Number(news.coupang.count7d || 0) : 0;
  const elevenst = news?.elevenst && news.elevenst.ok !== false ? Number(news.elevenst.count7d || 0) : 0;
  const gmarket = news?.gmarket && news.gmarket.ok !== false ? Number(news.gmarket.count7d || 0) : 0;
  const payload = { ok: true, news: news && news.ok !== false ? news : { ok: false, reason: "news_unavailable" } };
  const embedded = JSON.stringify(payload).replace(/</g, "\\u003c");
  const description = `네이버·쿠팡·11번가·G마켓 셀러에게 필요한 정산·수수료·규제·물류·광고 기사만 골라 1시간마다 갱신합니다. 최근 7일 네이버 ${naver}건 · 쿠팡 ${coupang}건 · 11번가 ${elevenst}건 · G마켓 ${gmarket}건.`;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>셀러 뉴스 | 모먼트 인사이트 — 네이버·쿠팡 셀러 관련 기사 7일치</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${SITE}/news" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="모먼트 인사이트" />
<meta property="og:title" content="셀러 뉴스 | 네이버·쿠팡 셀러 관련 기사 7일치" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${SITE}/news" />
<meta property="og:image" content="${SITE}/og-image.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<style>${STYLE}</style>
</head>
<body>
  <header class="top">
    <div class="shell top-inner">
      <a class="brand" href="/"><span class="mk">MI</span><span>모먼트 인사이트</span></a>
      <nav class="top-links" aria-label="상단 바로가기">
        <a class="btn" href="/client">광고주 로그인</a>
        <a class="btn primary" href="${KAKAO}" target="_blank" rel="noopener">도입 문의</a>
      </nav>
    </div>
  </header>

  <main class="shell" id="news">
    <div class="head">
      <span class="kicker">셀러 뉴스 · 로그인 없이 누구나</span>
      <h1>네이버·쿠팡·11번가·G마켓 셀러 관련 기사, 최근 7일치</h1>
      <p>정산·수수료·규제·물류·광고 기사만 골라 1시간마다 갱신합니다. 기사를 누르면 언론사 원문으로 이동합니다.</p>
    </div>

    <div class="bar" data-news-filters>
      <button class="chip on" type="button" data-news-platform="all">전체</button>
      <button class="chip" type="button" data-news-platform="naver">네이버</button>
      <button class="chip" type="button" data-news-platform="coupang">쿠팡</button>
      <button class="chip" type="button" data-news-platform="elevenst">11번가</button>
      <button class="chip" type="button" data-news-platform="gmarket">G마켓</button>
      <span class="meta" data-news-meta>${items.length}건 표시 · 전체 ${items.length}건</span>
    </div>
    <div class="bar" data-news-topics>${topicChips(items)}</div>

    <div class="list" data-news-list>${rows(items)}</div>

    <div class="cta">
      <div><b>로그인하면 내 키워드 뉴스까지.</b><br /><span>추적 중인 키워드와 관련된 기사, 검색량 증감, 30일 순위를 첫 화면에서 봅니다.</span></div>
      <a class="btn primary" href="${KAKAO}" target="_blank" rel="noopener">도입 문의 · 카카오 채널</a>
    </div>
  </main>

  <footer>
    <div class="shell foot-inner">
      <span>Moment Insight · 네이버·쿠팡 셀러의 시장 뉴스 · 키워드 조사 · 30일 순위 추적</span>
      <a href="/">홈</a>
      <a href="/privacy">개인정보처리방침</a>
      <a href="mailto:mml93@naver.com">이메일 문의</a>
    </div>
  </footer>

  <script type="application/json" id="news-data">${embedded}</script>
  <script src="/mi-news-page.js?v=news-v5-20260907" defer></script>
  <script src="/mi-analytics.js?v=ga-v1-20260906" defer></script>
</body>
</html>
`;
}
