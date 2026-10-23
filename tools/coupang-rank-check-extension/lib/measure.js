// C 30일 ① '지금 확인' 확장 — 쪽 안에서 도는 함수(spec-manual §4.5).
// chrome.scripting.executeScript 의 func 로 넘겨 확장이 연 시크릿 탭에서만 돈다(기본 ISOLATED 세계).
// 그래서 두 함수 모두 자기완결이다: 이 파일 밖의 값·import·전역 상수를 쓰지 않는다(테스트가 node:vm 으로 확인).
// 읽기 규칙은 수집기 tools/coupang-rank-collector/lib/extract.mjs EXTRACT_SOURCE 와 같다(선택자·광고 표식·제목 200자).
// 더한 것: 쿠팡 한국어 차단 화면 문구, 검색어(q), 주 문서 HTTP 상태, 측정 중 숨김·주소 바뀜(경로·q·정렬·쪽 번호·목록 크기) 표시.
// 하지 않는 것: 누르기·입력·포커스 옮기기·주소 바꾸기·브라우저 표식 숨기기. 스크롤은 수집기와 같은 범위만 한다.

// 페이지가 다 불러와졌는지(주 문서 load = readyState complete)를 본다. 화면을 바꾸지 않는다.
// 불러오는 동안의 차단 신호(주 문서 HTTP 상태·차단 문구)도 함께 적는다: 사람이 첫 읽기 전에 창을 닫아도
// 확장이 그 신호로 그날 중지를 걸 수 있게(차단 문구 식은 아래 miCoupangMeasure 와 같다).
export function miCoupangProbe() {
  let httpStatus = null;
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    const status = entry ? entry.responseStatus : null;
    httpStatus = Number.isInteger(status) && status >= 1 && status <= 599 ? status : null;
  } catch {
    httpStatus = null;
  }
  const body = document.body ? String(document.body.innerText || "") : "";
  const blockPattern = /Access Denied|permission to access|비정상적인 접근|자동입력 방지|captcha|사용권한이 없습니다|사용권한이 제한된/i;
  return {
    readyState: String(document.readyState || ""),
    host: String(location.host || "").toLowerCase(),
    path: String(location.pathname || "").slice(0, 80),
    httpStatus,
    blockedText: blockPattern.test(body.slice(0, 4000)) || /Access Denied/i.test(String(document.title || "")),
  };
}

// 측정 1번. options = { quick, settleMs, scrollCount, extraScrollCount, scrollPixels, gapMin, gapMax, readGapMs }
// quick=true 는 기다리지도 스크롤하지도 않고 한 번만 읽는다(시간 초과 때 차단 문구·HTTP 상태를 얻으려고).
export async function miCoupangMeasure(options) {
  const o = options && typeof options === "object" ? options : {};
  const num = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
  const settleMs = num(o.settleMs, 2500);
  const scrollCount = num(o.scrollCount, 8);
  const extraScrollCount = num(o.extraScrollCount, 2);
  const scrollPixels = num(o.scrollPixels, 1400);
  const gapMin = num(o.gapMin, 350);
  const gapMax = Math.max(gapMin, num(o.gapMax, 700));
  const readGapMs = num(o.readGapMs, 1200);
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const jitter = () => gapMin + Math.floor(Math.random() * (gapMax - gapMin + 1));

  const blockPattern = /Access Denied|permission to access|비정상적인 접근|자동입력 방지|captcha|사용권한이 없습니다|사용권한이 제한된/i;
  // 주소 바뀜 = 경로가 바뀜, 검색어(q)가 바뀜, 또는 목록의 순서·범위를 바꾸는 값(정렬 sorter·쪽 번호 page·목록 크기 listSize)이 바뀜.
  // 같은 쪽 안 이동(pushState)으로 목록만 갈아 끼워도 잡는다. 쿠팡 기본값(sorter=scoreDesc·page=1)은 값이 없는 것과 같고,
  // 목록 크기는 생기기만 해도 바뀐 것이다(기본값 미확인). 이 표는 lib/protocol.js LIST_PARAM_DEFAULTS 와 같다(테스트).
  // 쿠팡 쪽 스크립트가 주소 꼬리에 추적 값(&channel= 등)만 붙이는 것은 사람이 옮긴 것이 아니므로 보지 않는다
  // (q 가 바뀐 목록은 서버 M2 query_mismatch 가 따로 잡는다).
  const listDefaults = { sorter: "scoreDesc", page: "1", listSize: "" };
  const addressKey = () => {
    const parts = [String(location.pathname || "")];
    try {
      const params = new URLSearchParams(String(location.search || ""));
      parts.push(params.get("q"));
      Object.keys(listDefaults).forEach((name) => {
        const raw = params.get(name);
        const value = raw === null ? "" : String(raw).trim();
        parts.push(value === "" ? listDefaults[name] : value);
      });
    } catch {
      parts.push(null);
    }
    return JSON.stringify(parts);
  };
  const startAddress = addressKey();
  let wasHidden = document.visibilityState === "hidden";
  const onVisibility = () => {
    if (document.visibilityState === "hidden") wasHidden = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  let scrolls = 0;
  let reads = 0;

  const statusOf = () => {
    try {
      const entry = performance.getEntriesByType("navigation")[0];
      const status = entry ? entry.responseStatus : null;
      return Number.isInteger(status) && status >= 1 && status <= 599 ? status : null;
    } catch {
      return null;
    }
  };
  const queryOf = () => {
    let q = "";
    try {
      q = new URLSearchParams(location.search).get("q") || "";
    } catch {
      q = "";
    }
    return Array.from(q.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 100).join("");
  };
  const moved = () => addressKey() !== startAddress;

  const read = () => {
    reads += 1;
    const body = document.body ? String(document.body.innerText || "") : "";
    const lis = Array.from(document.querySelectorAll('li[class*="ProductUnit"]'));
    const items = [];
    lis.forEach((li) => {
      const a = li.querySelector('a[href*="/vp/products/"]');
      if (!a) return;
      let u;
      try {
        u = new URL(a.href);
      } catch {
        return;
      }
      items.push({
        p: (u.pathname.match(/products\/(\d+)/) || [])[1] || "",
        v: u.searchParams.get("vendorItemId") || "",
        ad: (u.searchParams.get("sourceType") || "") === "srp_product_ads",
        t: ((li.innerText || "").split("\n")[0] || "").trim().slice(0, 200),
      });
    });
    return {
      host: String(location.host || "").toLowerCase(),
      path: String(location.pathname || "").slice(0, 80),
      query: queryOf(),
      blockedText: blockPattern.test(body.slice(0, 4000)) || /Access Denied/i.test(String(document.title || "")),
      noResultText: /검색결과가 없습니다/.test(body),
      loginWall: /로그인하고 더 많은 상품/.test(body),
      items,
    };
  };

  const scroll = async (times) => {
    for (let index = 0; index < times; index += 1) {
      if (moved()) return;
      window.scrollBy(0, scrollPixels);
      scrolls += 1;
      await sleep(jitter());
    }
  };

  const finish = (latest, stable, navigated) => ({
    ...latest,
    httpStatus: statusOf(),
    stable,
    navigated,
    scrolls,
    reads,
    wasHidden: wasHidden || document.visibilityState === "hidden",
    visibility: String(document.visibilityState || ""),
  });

  try {
    if (o.quick === true) return finish(read(), false, moved());
    await sleep(settleMs);
    if (moved()) return finish(read(), false, true);
    const first = read();
    const status = statusOf();
    // 차단 화면·쿠팡 검색 1쪽이 아닌 곳에서는 스크롤하지 않는다(차단 화면과의 상호작용 최소).
    const blocked = first.blockedText || status === 403 || status === 429 || status === 503;
    const onSearch = first.host === "www.coupang.com" && first.path === "/np/search";
    if (blocked || !onSearch) return finish(first, false, false);
    await scroll(scrollCount);
    if (moved()) return finish(read(), false, true);
    await sleep(readGapMs);
    const second = read();
    await sleep(readGapMs);
    const third = read();
    let latest = third;
    let stable = true;
    if (second.items.length !== third.items.length) {
      await scroll(extraScrollCount);
      await sleep(readGapMs);
      const fourth = read();
      stable = fourth.items.length === third.items.length;
      latest = fourth;
    }
    if (moved()) return finish(latest, false, true);
    return finish(latest, stable, false);
  } catch {
    return { extractError: true, host: String(location.host || "").toLowerCase(), path: String(location.pathname || "").slice(0, 80), query: "", items: [], httpStatus: statusOf(), wasHidden, scrolls, reads };
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}
