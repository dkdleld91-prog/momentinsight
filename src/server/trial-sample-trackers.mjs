// 체험 계정(구글 가입) 전용 예시 순위 데이터(대표 지시 2026-09-07 "무료체험 계정에 예시로 나올 수 있게").
// 세션 게이트가 체험 세션의 GET /api/naver-rank-trackers · /api/naver-place-rank-trackers 에 이 응답을
// 돌려준다. 순위 수집 코드·표·워커는 전혀 건드리지 않는다. 화면(잠긴 renderRankResult 등)은 실제
// 서버 응답과 같은 필드 모양을 받으므로 여기 필드 이름은 handlers/naver-rank-trackers.mjs 의
// trackerPayload / snapshotPayload, naver-place-rank-trackers.mjs 의 placeTrackerPayload 와 같아야 한다.
// 값은 전부 지어낸 예시이고 제목에 [예시] 를 붙여 실제 상품·업체와 섞이지 않게 한다.

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const PRODUCT_MAX_RANK = 300;
const PLACE_MAX_RANK = 300;

// 30일 순위 곡선(오래된 날 → 최근 날). 0 은 "그날 미발견".
const PRODUCT_SAMPLES = [
  {
    key: "p1",
    keyword: "차량용 거치대",
    groupName: "예시 그룹",
    productTitle: "[예시] 차량용 핸드폰 거치대 3세대 송풍구형",
    mallName: "예시 스토어",
    productId: "9000000001",
    productUrl: "https://smartstore.naver.com/example/products/9000000001",
    keywordVolume: 22710,
    keywordVolumeLabel: "22,710",
    ranks: [41, 38, 36, 35, 31, 29, 27, 27, 24, 22, 21, 19, 19, 18, 16, 15, 15, 14, 12, 12, 11, 10, 9, 9, 8, 8, 7, 7, 6, 6],
  },
  {
    key: "p2",
    keyword: "온수매트",
    groupName: "예시 그룹",
    productTitle: "[예시] 온수매트 싱글 분리난방 2026형",
    mallName: "예시 스토어",
    productId: "9000000002",
    productUrl: "https://smartstore.naver.com/example/products/9000000002",
    keywordVolume: 9410,
    keywordVolumeLabel: "9,410",
    ranks: [12, 12, 13, 11, 11, 10, 10, 12, 14, 13, 13, 11, 10, 9, 9, 9, 10, 11, 11, 10, 9, 8, 8, 8, 9, 9, 8, 7, 7, 7],
  },
  {
    key: "p3",
    keyword: "전기요",
    groupName: "예시 그룹",
    productTitle: "[예시] 극세사 전기요 더블 과열방지",
    mallName: "예시 스토어",
    productId: "9000000003",
    productUrl: "https://smartstore.naver.com/example/products/9000000003",
    keywordVolume: 4240,
    keywordVolumeLabel: "4,240",
    ranks: [0, 0, 0, 96, 88, 81, 77, 70, 64, 61, 58, 55, 52, 49, 47, 45, 44, 41, 39, 38, 36, 35, 33, 33, 31, 30, 29, 28, 27, 26],
  },
];

const PLACE_SAMPLES = [
  {
    key: "l1",
    keyword: "강남역 필라테스",
    groupName: "예시 그룹",
    placeName: "[예시] 모먼트 필라테스 강남점",
    placeId: "1900000001",
    placeUrl: "https://map.naver.com/p/entry/place/1900000001",
    ranks: [18, 17, 17, 16, 15, 15, 14, 14, 13, 13, 12, 12, 12, 11, 11, 10, 10, 9, 9, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6, 5],
  },
  {
    key: "l2",
    keyword: "홍대 브런치 카페",
    groupName: "예시 그룹",
    placeName: "[예시] 모먼트 브런치 홍대점",
    placeId: "1900000002",
    placeUrl: "https://map.naver.com/p/entry/place/1900000002",
    ranks: [7, 7, 8, 8, 9, 9, 8, 7, 7, 6, 6, 6, 7, 7, 6, 5, 5, 5, 6, 6, 5, 4, 4, 4, 5, 5, 4, 4, 3, 3],
  },
];

function trialTag(claims) {
  return String(claims?.gsub || "").slice(0, 8) || "sample";
}

// 매일 09:00(KST) 수집 시각. day=0 이 오늘, day=29 가 29일 전.
function checkedAtFor(nowMs, daysAgo) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const base = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return new Date(base + 9 * 60 * 60 * 1000 - daysAgo * DAY_MS).toISOString();
}

function nextCheckAtFor(nowMs) {
  // 내일 09:00(KST): 화면의 dueRankTrackers 가 "밀린 갱신" 으로 보지 않게 항상 미래다.
  return new Date(new Date(checkedAtFor(nowMs, 0)).getTime() + DAY_MS).toISOString();
}

function productSnapshots(sample, trackerId, nowMs) {
  const ranks = sample.ranks.slice(-HISTORY_DAYS);
  const rows = [];
  for (let index = 0; index < ranks.length; index += 1) {
    const daysAgo = ranks.length - 1 - index;
    const rank = ranks[index];
    const matched = rank > 0;
    rows.push({
      id: `${trackerId}:s${daysAgo}`,
      trackerId,
      checkedAt: checkedAtFor(nowMs, daysAgo),
      rank: matched ? rank : null,
      page: matched ? Math.ceil(rank / 40) : null,
      position: matched ? ((rank - 1) % 40) + 1 : null,
      matched,
      checkedCount: PRODUCT_MAX_RANK,
      total: PRODUCT_MAX_RANK,
      item: matched
        ? { title: sample.productTitle, mallName: sample.mallName, productId: sample.productId, link: sample.productUrl }
        : null,
      message: matched ? "예시 데이터" : "예시 데이터 · 300위 안에 없음",
      source: "trial_sample",
      createdAt: checkedAtFor(nowMs, daysAgo),
    });
  }
  // 서버 응답과 같이 최신이 앞.
  return rows.reverse();
}

function productTracker(sample, claims, nowMs) {
  const id = `trial-${trialTag(claims)}-${sample.key}`;
  const snapshots = productSnapshots(sample, id, nowMs);
  const found = snapshots.filter((snapshot) => snapshot.matched);
  const ranks = found.map((snapshot) => snapshot.rank);
  const latest = snapshots[0];
  return {
    id,
    keyword: sample.keyword,
    groupName: sample.groupName,
    keywordVolume: sample.keywordVolume,
    keywordVolumeLabel: sample.keywordVolumeLabel,
    keywordVolumeStatus: "ready",
    productUrl: sample.productUrl,
    productId: sample.productId,
    mallName: sample.mallName,
    productTitle: sample.productTitle,
    maxRank: PRODUCT_MAX_RANK,
    status: "active",
    startedAt: checkedAtFor(nowMs, HISTORY_DAYS - 1),
    endsAt: nextCheckAtFor(nowMs),
    lastCheckedAt: latest.checkedAt,
    nextCheckAt: nextCheckAtFor(nowMs),
    currentRank: latest.rank,
    currentRankSource: "trial_sample",
    currentRankSourceLabel: "예시",
    exactProductRank: latest.rank,
    relatedCatalogRank: null,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    worstRank: ranks.length ? Math.max(...ranks) : null,
    checkCount: snapshots.length,
    foundCount: found.length,
    lastMessage: latest.message,
    lastError: null,
    retryCount: 0,
    sortOrder: 0,
    createdAt: checkedAtFor(nowMs, HISTORY_DAYS - 1),
    updatedAt: latest.checkedAt,
    snapshots,
    neverFound: false,
    foundRate: snapshots.length ? Math.round((found.length / snapshots.length) * 100) / 100 : null,
    lastFoundAt: found.length ? found[0].checkedAt : null,
    sample: true,
  };
}

function placeSnapshots(sample, trackerId, nowMs) {
  const ranks = sample.ranks.slice(-HISTORY_DAYS);
  const rows = [];
  for (let index = 0; index < ranks.length; index += 1) {
    const daysAgo = ranks.length - 1 - index;
    const rank = ranks[index];
    const matched = rank > 0;
    rows.push({
      id: `${trackerId}:s${daysAgo}`,
      trackerId,
      checkedAt: checkedAtFor(nowMs, daysAgo),
      rank: matched ? rank : null,
      matched,
      checkedCount: PLACE_MAX_RANK,
      requestedMaxRank: PLACE_MAX_RANK,
      complete: true,
      partial: false,
      total: PLACE_MAX_RANK,
      place: matched ? { name: sample.placeName, id: sample.placeId } : null,
      message: matched ? "예시 데이터" : "예시 데이터 · 300위 안에 없음",
      source: "trial_sample",
      createdAt: checkedAtFor(nowMs, daysAgo),
    });
  }
  return rows.reverse();
}

function placeTracker(sample, claims, nowMs) {
  const id = `trial-${trialTag(claims)}-${sample.key}`;
  const snapshots = placeSnapshots(sample, id, nowMs);
  const found = snapshots.filter((snapshot) => snapshot.matched);
  const ranks = found.map((snapshot) => snapshot.rank);
  const latest = snapshots[0];
  return {
    id,
    keyword: sample.keyword,
    groupName: sample.groupName,
    placeUrl: sample.placeUrl,
    placeId: sample.placeId,
    placeName: sample.placeName,
    maxRank: PLACE_MAX_RANK,
    status: "active",
    startedAt: checkedAtFor(nowMs, HISTORY_DAYS - 1),
    lastCheckedAt: latest.checkedAt,
    nextCheckAt: nextCheckAtFor(nowMs),
    currentRank: latest.rank,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    worstRank: ranks.length ? Math.max(...ranks) : null,
    checkCount: snapshots.length,
    foundCount: found.length,
    lastMessage: latest.message,
    lastError: null,
    retryExhausted: false,
    sortOrder: 0,
    createdAt: checkedAtFor(nowMs, HISTORY_DAYS - 1),
    updatedAt: latest.checkedAt,
    snapshots,
    sample: true,
  };
}

const SAMPLE_MESSAGE = "예시 데이터입니다. 도입하면 내 상품·업체의 실제 순위로 채워집니다.";

function scopeFields(claims) {
  const clientId = String(claims?.clientId || "").trim().toLowerCase();
  const agencyCode = String(claims?.agencyCode || "").trim().toLowerCase();
  return {
    scopeKey: agencyCode,
    scopeAgencyCode: agencyCode,
    scopeClientId: clientId,
    scopeMode: "advertiser",
  };
}

export function trialProductTrackersPayload(claims, nowMs = Date.now()) {
  const trackers = PRODUCT_SAMPLES.map((sample) => productTracker(sample, claims, nowMs));
  return {
    ok: true,
    sample: true,
    message: SAMPLE_MESSAGE,
    rankSourceReady: true,
    configured: true,
    mode: "trial_sample",
    coverage: "sample",
    fullCoverageReady: true,
    preserveOnMiss: false,
    localWorkerEnabled: false,
    localWorkerSecretReady: false,
    ...scopeFields(claims),
    returnedCount: trackers.length,
    totalCount: trackers.length,
    hasMore: false,
    complete: true,
    workerStatus: { state: "idle" },
    trackers,
  };
}

export function trialPlaceTrackersPayload(claims, nowMs = Date.now()) {
  const trackers = PLACE_SAMPLES.map((sample) => placeTracker(sample, claims, nowMs));
  return {
    ok: true,
    sample: true,
    message: SAMPLE_MESSAGE,
    ...scopeFields(claims),
    returnedCount: trackers.length,
    totalCount: trackers.length,
    hasMore: false,
    complete: true,
    configured: true,
    lookupMode: "trial_sample",
    trackers,
  };
}

export const TRIAL_SAMPLE_PATHS = new Map([
  ["/api/naver-rank-trackers", trialProductTrackersPayload],
  ["/api/naver-place-rank-trackers", trialPlaceTrackersPayload],
]);

export function trialSampleTrackersPayload(path, claims, nowMs = Date.now()) {
  const build = TRIAL_SAMPLE_PATHS.get(String(path || ""));
  return build ? build(claims, nowMs) : null;
}
