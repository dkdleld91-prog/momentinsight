// N30 그룹상품 추적 (대표 승인 2026-10-23 "네 그룹 추적으로 진행해주세요").
//
// 스마트스토어 그룹상품은 검색 결과에 카드 한 장으로 나오고, 그 카드에는 그때의 대표 옵션
// 상품번호가 붙는다. 대표 옵션이 자동으로 바뀌면(아이쉘 12356459438 사례) 추적 번호(product_id)
// 로는 '300위 밖'이 된다. 추적 하나에 같은 그룹상품의 다른 옵션 상품번호(option_product_ids)를
// 붙여 두고, 이미 받은 같은 300개 창(네이버 추가 요청 0)에서 옵션 번호가 붙은 카드가 보이면 그
// 위치도 순위로 본다. 순위 고르기(지휘 결정 2026-10-23, 규칙 C'): 다른 스토어로 확인된(mismatch) 옵션 카드만 뺀다.
// 확인됨·확인 안 됨 옵션 카드는 모두 대표 번호(정확 상품·원부)와 똑같이 순위로 겨뤄 가장 높은 순위를 기록한다 —
// 같으면 대표, 옵션끼리 같으면 확인됨 먼저. 대표가 보이든 안 보이든, 첫 확인·지난 기록 유무와 상관없이 같다.
// 옵션 번호는 대표가 직접 넣은 번호이고 네이버 상품번호는 전역 고유라, 뺄 것은 '다른 스토어로 확인된 것'뿐이다.
// 스토어 확인(규칙 A·B)은 optionStoreCheck 를 본다.
//
// 지켜야 할 경계
// - 이 파일은 N30 런타임 지문 부품(scripts/naver-shopping-runtime-fingerprint.mjs)이 아니다.
//   지문 부품인 handlers/naver-shopping-rank.mjs 는 바꾸지 않고, 그 파일이 이미 내보내는 함수만 쓴다.
// - 옵션 판정은 절대 던지지 않는다(evaluateGroupTrackingRank). 같은 키워드 묶음의 다른 추적이
//   옵션 판정 때문에 실패하거나 다시 수집되면 안 된다. 실패하면 대표 결과를 그대로 쓴다.
// - 옵션으로 잡힌 행은 언제나 exact_product 다. 원부(related_catalog) 규칙은 대표 번호 전용이다.
// - naver-rank-trackers.mjs 를 불러오지 않는다(그 파일이 이 파일을 불러온다). 대표 판정 함수는 인자로 받는다.
import {
  buildRankTarget,
  catalogIdCandidates,
  classifyNaverProductType,
  findShoppingRankFromWindow,
  isAdItem,
  matchTargetItem,
  normalizeText,
  productIdCandidates,
} from "./handlers/naver-shopping-rank.mjs";
import { rankProductUrlRejection } from "./rank-target-url.mjs";

export const OPTION_PRODUCT_IDS_MAX = 20;
export const OPTION_PRODUCT_ID_MIN_DIGITS = 5;
export const OPTION_PRODUCT_ID_MAX_DIGITS = 20;
// 브라우저 주소창에서 복사한 상품 URL 은 ?NaPm=… 추적 꼬리가 붙어 한 줄 200~300자가 흔하다.
// 옵션 20개를 URL 로 붙여 넣어도 막히지 않게 넉넉히 둔다(칸 수 상한 60 은 그대로).
export const OPTION_INPUT_MAX_CHARS = 20_000;
export const OPTION_INPUT_MAX_TOKENS = 60;
export const OPTION_SAME_PRODUCT_TRACKERS_MAX = 100;
export const OPTION_COLUMN_MISSING_MEMO_MS = 10 * 60_000;
const OPTION_TITLE_MAX = 80;
const MESSAGE_ID_LIST_MAX = 5;
const OPTION_PRODUCT_ID_PATTERN = new RegExp(
  `^[0-9]{${OPTION_PRODUCT_ID_MIN_DIGITS},${OPTION_PRODUCT_ID_MAX_DIGITS}}$`,
  "u",
);
const THOUSANDS_SEPARATED_NUMBER = /^[0-9]{1,3}(?:,[0-9]{3}){2,}$/u;
const WRAPPING_PUNCTUATION = /^["'`“”‘’()[\]{}<>.,;:]+|["'`“”‘’()[\]{}<>.,;:]+$/gu;
const URL_LIKE = /^(?:https?:\/\/|(?:[a-z0-9-]+\.)*naver\.(?:com|me)(?:[/?#]|$))/iu;
const OPTION_GROUP_SNAPSHOT_KEYS = [
  "checkedOptionCount",
  "matchedOptionTitle",
  "mallCheck",
  "titleCheck",
  "cardCount",
  "otherCardCount",
  "otherCardBestRank",
  "mallMismatchCount",
  // 다른 스토어로 확인돼 뺀 번호(있을 때만, 최대 OPTION_PRODUCT_IDS_MAX 개). 대표가 이겨 문장에 꼬리가 없는 경우에도
  // 관리자 줄이 번호를 보이게 스냅샷에 남긴다(규칙 E'). 넣은 번호 전체 목록은 싣지 않는다(egress).
  "mallMismatchProductIds",
  "primaryProductRank",
  "primaryRankSource",
];

export const OPTION_REJECTION_LABELS = Object.freeze({
  digit_length: `숫자 ${OPTION_PRODUCT_ID_MIN_DIGITS}~${OPTION_PRODUCT_ID_MAX_DIGITS}자리만 받습니다`,
  thousands_separator: "천 단위 쉼표를 빼고 숫자만 넣어주세요",
  catalog_url: "원부(가격비교) URL 은 넣을 수 없습니다",
  unsupported_url: "상품 페이지 URL 이 아닙니다(목록·검색·기획전 주소)",
  other_store: "다른 스토어 상품 URL 입니다",
  not_product_url: "상품번호를 찾을 수 없는 URL 입니다",
  not_product_number: "상품번호가 아닙니다",
});

// ───────────────────────── 칸 없음(대표 SQL 전) 견디기 ─────────────────────────

let optionColumnMissingUntilMs = 0;

const OPTION_COLUMN_MISSING_CODES = new Set(["42703", "PGRST204"]);

// 기존 isMissingRankGroupColumn(/group_name|schema cache|does not exist/)은 넓게 잡는다.
// 옵션 칸 오류를 그 함수가 먼저 보면 그룹 이름까지 잃으므로, 이 검사를 항상 먼저 한다.
// 오류 코드를 먼저 보고 message 만 읽는다. details·hint 는 보지 않는다 — CHECK 위반(23514)의
// details 'Failing row contains (…)' 에 상품번호·uuid 숫자가 섞여 '42703' 처럼 보일 수 있고,
// message 에는 제약 이름(option_product_ids 가 들어감)이 있어서다(반박 검토 2026-10-23).
export function isOptionColumnMissingError(error) {
  if (!error || typeof error !== "object") return false;
  const message = String(error.message || "");
  if (!/option_product_ids/iu.test(message)) return false;
  const code = String(error.code ?? "").trim().toUpperCase();
  if (code) return OPTION_COLUMN_MISSING_CODES.has(code);
  // 코드 없이 문구만 오는 경로(오래된 클라이언트)는 message 의 칸 없음 문구만 본다.
  return /does not exist|schema cache|could not find/iu.test(message);
}

export function optionColumnRecentlyMissing(nowMs = Date.now()) {
  return nowMs < optionColumnMissingUntilMs;
}

// 함수 인스턴스마다 한 번만 경고를 남기고, 10분 동안은 실패할 조회를 다시 보내지 않는다
// (Supabase Log Ingestion 한도 초과 상태라 실패 조회 로그를 쌓지 않기 위해서다).
export function rememberOptionColumnMissing(source = "", nowMs = Date.now()) {
  const alreadyKnown = nowMs < optionColumnMissingUntilMs;
  optionColumnMissingUntilMs = nowMs + OPTION_COLUMN_MISSING_MEMO_MS;
  if (!alreadyKnown) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "naver_rank_option_column_missing",
      source: String(source || "").slice(0, 40),
    }));
  }
}

export function forgetOptionColumnMissing() {
  optionColumnMissingUntilMs = 0;
}

// ───────────────────────── 번호 정리 ─────────────────────────

export function isOptionProductId(value) {
  return OPTION_PRODUCT_ID_PATTERN.test(String(value ?? "").trim());
}

export function normalizeStoredOptionProductIds(value, excludeIds = []) {
  if (!Array.isArray(value)) return [];
  const excluded = new Set((Array.isArray(excludeIds) ? excludeIds : [excludeIds])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean));
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    const id = String(raw ?? "").trim();
    if (!isOptionProductId(id) || excluded.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= OPTION_PRODUCT_IDS_MAX) break;
  }
  return ids;
}

// 옵션을 붙일 수 있는 추적인지: 상품 기준이고, 대표 번호가 숫자이며 URL 번호와 같아야 한다.
// product_id 가 빈 옛 행이나 URL 과 번호가 다른 행은 옵션을 쓰지 않는다(커밋 RPC 가 빈
// product_id 를 결과 번호로 채우는 길을 옵션이 타지 않게 하기 위해서다).
// 던지지 않는다: 목록 응답(trackerPayload·groupOptionSuggestionCounts)이 모든 행에 부르므로, 퍼센트
// 인코딩이 깨진 옛 URL 행 하나(buildRankTarget 이 URIError)로 목록 GET 전체가 500 이 되면 안 된다.
// 예외가 나면 옵션 없음(primary_invalid) = 옵션 칸이 없던 때와 같은 결과다.
export function trackerOptionEligibility(tracker = {}) {
  const productId = normalizeText(tracker?.product_id);
  let target;
  try {
    target = buildRankTarget({
      targetProductId: productId,
      targetUrl: normalizeText(tracker?.product_url),
    });
  } catch {
    return { eligible: false, reason: "primary_invalid", primaryProductId: productId, primaryProductIds: [] };
  }
  const primaryProductIds = Array.isArray(target.productIds) ? target.productIds.map(String) : [];
  if (target.targetMode === "catalog") {
    return { eligible: false, reason: "catalog_tracker", primaryProductId: productId, primaryProductIds };
  }
  if (!/^[0-9]{5,}$/u.test(productId)
    || target.hasDirectTarget !== true
    || target.identityConflict === true
    || primaryProductIds[0] !== productId) {
    return { eligible: false, reason: "primary_invalid", primaryProductId: productId, primaryProductIds };
  }
  return { eligible: true, reason: "", primaryProductId: productId, primaryProductIds };
}

// submit 반복 안에서 쓰므로 던지지 않는다(이상한 행이면 옵션 없음 = 지금 동작).
export function trackerOptionProductIds(tracker = {}) {
  try {
    const eligibility = trackerOptionEligibility(tracker);
    if (!eligibility.eligible) return [];
    return normalizeStoredOptionProductIds(tracker?.option_product_ids, eligibility.primaryProductIds);
  } catch {
    return [];
  }
}

// ───────────────────────── 붙여 넣기 해석 (순수 함수, 입출력 없음) ─────────────────────────

function smartStoreSlug(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "smartstore.naver.com" && host !== "m.smartstore.naver.com") return "";
  let first = "";
  try {
    first = decodeURIComponent(parsed.pathname.split("/").filter(Boolean)[0] || "");
  } catch {
    first = parsed.pathname.split("/").filter(Boolean)[0] || "";
  }
  const slug = first.trim().toLowerCase();
  // 검색 결과 카드 링크는 smartstore.naver.com/main/products/{id} 꼴이라 'main' 은 스토어가 아니다.
  if (!slug || slug === "main" || slug === "products") return "";
  return slug;
}

// 스토어 주소(규칙 A): smartstore.naver.com/<slug> 또는 brand.naver.com/<slug>(모바일 m. 포함).
// 검색 카드 링크의 'main' 경로(smartstore.naver.com/main/products/{id})는 스토어 주소가 아니다.
// 붙여 넣기 해석(smartStoreSlug)은 예전 그대로 두고, 순위 판정의 스토어 확인만 이 함수를 쓴다.
const STORE_ADDRESS_HOSTS = new Map([
  ["smartstore.naver.com", "smartstore"],
  ["m.smartstore.naver.com", "smartstore"],
  ["brand.naver.com", "brand"],
  ["m.brand.naver.com", "brand"],
]);

export function storeAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const kind = STORE_ADDRESS_HOSTS.get(parsed.hostname.toLowerCase());
  if (!kind) return null;
  const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // 깨진 퍼센트 인코딩은 원문 조각을 쓴다.
  }
  const slug = decoded.trim().toLowerCase();
  if (!slug || slug === "main" || slug === "products") return null;
  return { kind, slug };
}

function rejectedToken(token, reason) {
  return {
    token: String(token || "").slice(0, 160),
    reason,
    label: OPTION_REJECTION_LABELS[reason] || OPTION_REJECTION_LABELS.not_product_number,
  };
}

function classifyOptionToken(token, primaryStoreSlug) {
  if (/^[0-9]+$/u.test(token)) {
    return isOptionProductId(token)
      ? { id: token }
      : { rejected: rejectedToken(token, "digit_length") };
  }
  if (!URL_LIKE.test(token)) return { rejected: rejectedToken(token, "not_product_number") };
  if (catalogIdCandidates(token).length > 0) return { rejected: rejectedToken(token, "catalog_url") };
  if (rankProductUrlRejection(token)) return { rejected: rejectedToken(token, "unsupported_url") };
  const tokenSlug = smartStoreSlug(token);
  if (primaryStoreSlug && tokenSlug && tokenSlug !== primaryStoreSlug) {
    return { rejected: rejectedToken(token, "other_store") };
  }
  const candidates = productIdCandidates(token);
  if (candidates.length === 1) {
    return isOptionProductId(candidates[0])
      ? { id: candidates[0] }
      : { rejected: rejectedToken(token, "digit_length") };
  }
  return { rejected: rejectedToken(token, "not_product_url") };
}

export function parseOptionProductInput(input, { primaryProductIds = [], primaryProductUrl = "" } = {}) {
  const text = typeof input === "string" ? input : String(input ?? "");
  const base = {
    optionProductIds: [],
    inputTokenCount: 0,
    duplicatesRemoved: 0,
    primaryRemoved: false,
    primaryRemovedCount: 0,
    rejected: [],
    limit: OPTION_PRODUCT_IDS_MAX,
    overLimit: false,
    error: "",
  };
  if (text.length > OPTION_INPUT_MAX_CHARS) return { ...base, error: "too_long" };

  const tokens = [];
  const thousandTokens = new Set();
  for (const chunk of text.split(/[\s;]+/u)) {
    const cleaned = chunk.replace(WRAPPING_PUNCTUATION, "");
    if (!cleaned) continue;
    if (THOUSANDS_SEPARATED_NUMBER.test(cleaned)) {
      thousandTokens.add(tokens.length);
      tokens.push(cleaned);
      continue;
    }
    for (const part of cleaned.split(",")) {
      const token = part.replace(WRAPPING_PUNCTUATION, "");
      if (token) tokens.push(token);
    }
  }
  if (tokens.length > OPTION_INPUT_MAX_TOKENS) {
    return { ...base, inputTokenCount: tokens.length, error: "too_many_tokens" };
  }

  const primaryIds = new Set((Array.isArray(primaryProductIds) ? primaryProductIds : [primaryProductIds])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean));
  const primaryStoreSlug = smartStoreSlug(primaryProductUrl);
  const seen = new Set();
  const ids = [];
  const rejected = [];
  let duplicatesRemoved = 0;
  let primaryRemovedCount = 0;
  tokens.forEach((token, index) => {
    if (thousandTokens.has(index)) {
      rejected.push(rejectedToken(token, "thousands_separator"));
      return;
    }
    const classified = classifyOptionToken(token, primaryStoreSlug);
    if (classified.rejected) {
      rejected.push(classified.rejected);
      return;
    }
    const id = classified.id;
    if (primaryIds.has(id)) {
      primaryRemovedCount += 1;
      return;
    }
    if (seen.has(id)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(id);
    ids.push(id);
  });
  return {
    ...base,
    optionProductIds: ids,
    inputTokenCount: tokens.length,
    duplicatesRemoved,
    primaryRemoved: primaryRemovedCount > 0,
    primaryRemovedCount,
    rejected,
    overLimit: ids.length > OPTION_PRODUCT_IDS_MAX,
  };
}

// ───────────────────────── 같은 상품 함께 적용 (순수 함수) ─────────────────────────

function idDiff(left, right) {
  const rightSet = new Set(right);
  return left.filter((id) => !rightSet.has(id));
}

// 그룹 G = [대표, ...옵션]. 함께 바꾸는 추적은 명세 §8.3-4 그대로 같은 범위·같은 대표 번호(product_id)의
// 상품 기준 활성·일시중지 추적뿐이다(같은 옵션 목록을 저장). 같은 그룹의 다른 옵션을 대표로 등록한 추적은
// 대상이 아니다(명세 §17-3) — 잘못 넣은 번호 하나로 다른 상품의 추적까지 덮어쓰는 길을 막는다(반박 검토 2026-10-23).
export function planOptionGroupUpdate({
  tracker,
  optionProductIds = [],
  candidates = [],
  applyToSameProduct = false,
  columnReady = true,
} = {}) {
  const selfEligibility = trackerOptionEligibility(tracker);
  const primary = selfEligibility.primaryProductId;
  const after = normalizeStoredOptionProductIds(optionProductIds, selfEligibility.primaryProductIds);
  const group = [primary, ...after];
  const selfId = String(tracker?.id || "");
  const beforeOf = (row, eligibility) => (columnReady
    ? normalizeStoredOptionProductIds(row?.option_product_ids, eligibility.primaryProductIds)
    : []);
  const selfBefore = beforeOf(tracker, selfEligibility);
  const targets = [{
    id: selfId,
    keyword: normalizeText(tracker?.keyword),
    status: String(tracker?.status || ""),
    primaryProductId: primary,
    relation: "self",
    before: selfBefore,
    after,
    addedCount: idDiff(after, selfBefore).length,
    removedCount: idDiff(selfBefore, after).length,
  }];
  const siblings = [];
  const seen = new Set([selfId]);
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const id = String(row?.id || "");
    if (!id || seen.has(id)) continue;
    const eligibility = trackerOptionEligibility(row);
    if (!eligibility.eligible || !primary || eligibility.primaryProductId !== primary) continue;
    if (!["active", "paused"].includes(String(row?.status || ""))) continue;
    seen.add(id);
    const siblingAfter = normalizeStoredOptionProductIds(group, eligibility.primaryProductIds);
    const siblingBefore = beforeOf(row, eligibility);
    siblings.push({
      id,
      keyword: normalizeText(row?.keyword),
      status: String(row?.status || ""),
      primaryProductId: eligibility.primaryProductId,
      relation: "same_primary",
      before: siblingBefore,
      after: siblingAfter,
      addedCount: idDiff(siblingAfter, siblingBefore).length,
      removedCount: idDiff(siblingBefore, siblingAfter).length,
    });
  }
  return {
    primaryProductId: primary,
    group,
    selfTarget: targets[0],
    siblings,
    targets: applyToSameProduct ? [...targets, ...siblings] : targets,
    removedOptionProductIds: idDiff(selfBefore, after),
  };
}

// 다른 추적(같은 범위)에 이미 붙은 번호 중 이 추적에 없는 것. "가져오기"·카드 알림용.
export function siblingOptionSuggestions(tracker, relatedRows = [], currentIds = []) {
  const eligibility = trackerOptionEligibility(tracker);
  if (!eligibility.eligible) return [];
  const exclude = new Set([...eligibility.primaryProductIds, ...currentIds.map(String)]);
  const selfId = String(tracker?.id || "");
  const ids = [];
  const seen = new Set();
  for (const row of relatedRows) {
    if (String(row?.id || "") === selfId) continue;
    const rowEligibility = trackerOptionEligibility(row);
    if (!rowEligibility.eligible) continue;
    const members = [
      rowEligibility.primaryProductId,
      ...normalizeStoredOptionProductIds(row?.option_product_ids, rowEligibility.primaryProductIds),
    ];
    for (const id of members) {
      if (exclude.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= OPTION_INPUT_MAX_TOKENS) return ids;
    }
  }
  return ids;
}

// 목록 응답용: 같은 그룹(번호 하나라도 겹침)의 다른 추적에 있는데 이 추적에는 없는 번호 개수.
// 이미 읽은 목록 행만 쓴다(추가 조회 0).
export function groupOptionSuggestionCounts(rows = []) {
  const entries = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const eligibility = trackerOptionEligibility(row);
    if (!eligibility.eligible) continue;
    const own = normalizeStoredOptionProductIds(row?.option_product_ids, eligibility.primaryProductIds);
    entries.push({ id: row.id, primary: eligibility.primaryProductId, group: [eligibility.primaryProductId, ...own] });
  }
  const counts = new Map();
  if (!entries.some((entry) => entry.group.length > 1)) return counts;
  const byMember = new Map();
  for (const entry of entries) {
    for (const id of entry.group) {
      if (!byMember.has(id)) byMember.set(id, []);
      byMember.get(id).push(entry);
    }
  }
  for (const entry of entries) {
    const union = new Set();
    for (const member of entry.group) {
      for (const other of byMember.get(member) || []) {
        if (other === entry) continue;
        other.group.forEach((id) => union.add(id));
      }
    }
    entry.group.forEach((id) => union.delete(id));
    if (union.size) counts.set(entry.id, union.size);
  }
  return counts;
}

// 옵션으로 잡힌 지난 기록은 옵션 목록을 고쳐도(번호 교체·모두 지우기) 화면에서 숨기지 않는다 — 명세 §7.3
// '저장 전 기록은 바꾸지 않는다'·§15-4 '옵션으로 기록된 과거 스냅샷은 지우지 않는다(실제 검색 결과 기록)'.
// 날짜 칸의 '옵션' 표시(압축 키 matchBasis)로만 구분한다(반박 검토 2026-10-23, 숨김 규칙 철회).

// ───────────────────────── 판정 (경로 A: 로컬 워커 submit) ─────────────────────────

export function mallKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleTokens(value) {
  return [...new Set(normalizeText(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2))];
}

export function optionTitleCheck(trackerTitle, cardTitle) {
  const trackerTokens = titleTokens(trackerTitle);
  const cardTokens = new Set(titleTokens(cardTitle));
  if (trackerTokens.length < 2 || cardTokens.size < 1) return "unverified";
  const shared = trackerTokens.filter((token) => cardTokens.has(token)).length;
  return shared / trackerTokens.length < 0.34 ? "low_overlap" : "ok";
}

function positiveRank(value) {
  const rank = Number(value);
  return Number.isSafeInteger(rank) && rank > 0 ? rank : null;
}

// 원부(가격비교) 카드가 내는 스토어 이름. 원부 카드는 판매처가 아니라 '네이버'로 표시된다(저장소 고정값
// scripts/check-naver-rank-matching.mjs 의 productType 1 원부 카드가 모두 mallName "네이버"). 이 이름은 기준으로 쓰지
// 않는다 — 원부 카드에서 온 값일 수 있어서다. 진짜 스토어 이름이 '네이버'라면 확인 안 됨이 될 뿐 순위는 그대로 겨룬다.
const CATALOG_CARD_MALL_KEYS = new Set(["네이버"]);

// 원부(가격비교) 카드인지: 관련 원부 표시·상품 형태(원부형)·원부 주소(/catalog/) 중 하나라도 있으면 원부 카드다.
function isCatalogCardItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.isRelatedCatalog === true || item.isPriceCompareCatalog === true) return true;
  if (classifyNaverProductType(item.productType).isPriceCompareCatalog) return true;
  return catalogIdCandidates(typeof item.link === "string" ? item.link : "").length > 0;
}

// 대표 번호가 정확 상품으로 잡혔던 지난 30일 기록의 스토어 이름(옵션·원부로 잡힌 행은 빼고). 정확 상품 행이라도
// 기록된 카드가 원부 카드이거나 이름이 원부 카드 표시 이름('네이버')이면 원부 카드에서 온 값일 수 있어 쓰지 않는다.
export function primaryMallKeysFromHistory(historyRows = [], primaryProductIds = []) {
  const primaryIds = new Set((primaryProductIds || []).map(String));
  const keys = new Set();
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    const item = row?.item;
    if (row?.matched !== true || !item || typeof item !== "object") continue;
    if (item.trackingRankSource !== "exact_product" || item.matchBasis === "group_option") continue;
    if (item.isAd === true || item.isOrganic === false) continue;
    if (isCatalogCardItem(item)) continue;
    const sellerProductId = normalizeText(item.sellerProductId);
    if (item.isExactTarget !== true && !primaryIds.has(sellerProductId)) continue;
    const key = mallKey(item.mallName);
    if (key && !CATALOG_CARD_MALL_KEYS.has(key)) keys.add(key);
  }
  return keys;
}

// 원부 카드에서 나온 스토어 이름들: 지난 기록의 원부 행·원부 카드, 이번 창의 대표 결과에 붙은 원부 카드.
// 커밋 RPC 는 빈 추적 mall_name 을 첫 결과 카드 이름으로 한 번 채우는데(원부로 잡힌 결과면 원부 카드 이름,
// handlers/naver-shopping-local-worker.mjs 의 p_mall_name), 그 값을 기준으로 쓰지 않으려고 대조한다.
function catalogCardMallKeys(historyRows = [], representativeResult = null) {
  const keys = new Set(CATALOG_CARD_MALL_KEYS);
  const add = (item) => {
    const key = mallKey(item?.mallName);
    if (key) keys.add(key);
  };
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    const item = row?.item;
    if (!item || typeof item !== "object") continue;
    if (item.trackingRankSource === "related_catalog" || isCatalogCardItem(item)) add(item);
  }
  if (representativeResult && typeof representativeResult === "object") {
    const items = [
      representativeResult.item,
      representativeResult.representativeItem,
      ...(Array.isArray(representativeResult.productExposureItems) ? representativeResult.productExposureItems : []),
    ];
    for (const item of items) if (isCatalogCardItem(item)) add(item);
  }
  return keys;
}

// 규칙 B 의 기준 이름: 지난 30일 대표 정확 기록의 스토어 이름, 없으면 추적 mall_name(입력 칸은 없고 첫 커밋 때
// 결과 카드 스토어 이름으로 채워진다). 추적 mall_name 이 원부 카드 이름(지난 기록·이번 창의 원부 카드 이름, 또는
// '네이버')과 같으면 원부 카드에서 채워진 값일 수 있어 쓰지 않는다. 둘 다 없으면 빈 집합 = 이름으로는 확인할 수 없다.
// 판별 못 하는 것: 30일보다 전에 원부 카드 이름(‘네이버’가 아닌 이름)으로 채워졌고 지난 30일 기록·이번 창에 그
// 이름이 없는 추적 — 원부 카드 이름이 기록에 남지 않아 대조할 수 없으므로 그대로 기준으로 쓴다(원부 카드가 보이는
// 날과 안 보이는 날에 순위가 번갈아 바뀔 수 있다). 실제 수집 원부 카드 이름은 빈 값·'네이버'뿐이라(2026-10-23
// 로컬 백업) 지금 데이터로는 생기지 않는다.
export function storeReferenceMallKeys(historyRows = [], primaryProductIds = [], trackerMallName = "", { representativeResult = null } = {}) {
  const keys = primaryMallKeysFromHistory(historyRows, primaryProductIds);
  if (keys.size) return keys;
  const trackerKey = mallKey(trackerMallName);
  if (!trackerKey || catalogCardMallKeys(historyRows, representativeResult).has(trackerKey)) return new Set();
  return new Set([trackerKey]);
}

// 옵션 카드 스토어 확인(지휘 결정 2026-10-23). 돌려주는 값: "matched"(확인됨)·"mismatch"(다른 스토어, 순위에
// 쓰지 않음)·"unverified"(확인 안 됨).
//  A) 추적 product_url 의 스토어 주소와 카드 링크의 같은 종류(스마트스토어·브랜드스토어) 스토어 주소가 둘 다
//     있으면 그것만 본다: 같으면 matched, 다르면 mismatch. 종류가 다른 주소끼리는 비교하지 않는다(B 로 간다).
//  B) 둘 중 하나라도 주소가 없으면 스토어 이름: 기준 이름(storeReferenceMallKeys)과 카드 mallName 이 같으면
//     matched, 다르면 mismatch, 기준이나 카드 이름이 비면 unverified.
export function optionStoreCheck({ cardMallName = "", cardLinks = [], referenceMallKeys = new Set(), trackerProductUrl = "" } = {}) {
  const trackerStore = storeAddress(trackerProductUrl);
  if (trackerStore) {
    const cardStore = (Array.isArray(cardLinks) ? cardLinks : [cardLinks])
      .map(storeAddress)
      .find((store) => store && store.kind === trackerStore.kind);
    if (cardStore) return cardStore.slug === trackerStore.slug ? "matched" : "mismatch";
  }
  const references = referenceMallKeys instanceof Set ? referenceMallKeys : new Set(referenceMallKeys || []);
  const cardKey = mallKey(cardMallName);
  if (!cardKey || !references.size) return "unverified";
  return references.has(cardKey) ? "matched" : "mismatch";
}

// 한 키워드 묶음(최대 100추적)은 같은 창 객체를 쓴다. 광고 판별(isAdItem)이 훑기 비용의 대부분이라
// 창마다 한 번만 거른다. 창의 items 배열이 바뀌면 다시 거른다.
const nonAdItemsByWindow = new WeakMap();
const DIGIT_RUN = /[0-9]{5,}/gu;

function digitRuns(value, into) {
  const text = String(value ?? "");
  for (const match of text.matchAll(DIGIT_RUN)) into.add(match[0]);
  if (text.includes("%")) {
    try {
      for (const match of decodeURIComponent(text).matchAll(DIGIT_RUN)) into.add(match[0]);
    } catch {
      // 깨진 퍼센트 인코딩은 위 원문 숫자만 쓴다.
    }
  }
}

// 오가닉 카드가 판매자 상품번호로 쓸 수 있는 칸(matchTargetItem 상품 기준이 보는 칸)의 모든 숫자 덩어리.
// 정확한 판정은 아니고 "이 창에 없는 번호"를 빨리 거르는 상위 집합이다 — 있으면 matchTargetItem 으로 다시 본다.
function sellerIdSuperset(items) {
  const ids = new Set();
  for (const item of items) {
    digitRuns(item?.sellerProductId, ids);
    digitRuns(item?.channelProductId, ids);
    digitRuns(item?.originalMallProductId, ids);
    if (Array.isArray(item?.sellerProductIds)) item.sellerProductIds.forEach((value) => digitRuns(value, ids));
    digitRuns(item?.link, ids);
  }
  return ids;
}

function nonAdWindowIndex(window) {
  const items = Array.isArray(window?.items) ? window.items : [];
  const cached = window && typeof window === "object" ? nonAdItemsByWindow.get(window) : null;
  if (cached && cached.source === items && cached.length === items.length) return cached;
  const nonAd = items.filter((item) => !isAdItem(item));
  const index = { source: items, length: items.length, items: nonAd, ids: sellerIdSuperset(nonAd) };
  if (window && typeof window === "object") nonAdItemsByWindow.set(window, index);
  return index;
}

// 300개 창을 한 번 훑어 옵션 번호가 붙은 오가닉 카드가 있는 번호만 고른다(보통 0~1개).
export function scanVisibleOptionProductIds(window, optionProductIds = []) {
  const index = nonAdWindowIndex(window);
  const present = (Array.isArray(optionProductIds) ? optionProductIds : [])
    .map((id) => String(id ?? "").trim())
    .filter((id) => index.ids.has(id));
  if (!present.length) return [];
  const target = { productIds: present, targetMode: "product", catalogIds: [] };
  const visible = [];
  const seen = new Set();
  for (const item of index.items) {
    const match = matchTargetItem(item, target);
    const id = normalizeText(match?.matchedProductId);
    if (match?.matched !== true || !id || seen.has(id)) continue;
    seen.add(id);
    visible.push(id);
  }
  return visible;
}

function exactOnlyOptionLookup(lookup) {
  if (!lookup || lookup.matched !== true) return null;
  const exactItems = (Array.isArray(lookup.productExposureItems) ? lookup.productExposureItems : [])
    .filter((item) => item?.isExactTarget === true && item?.isRelatedCatalog !== true);
  const exactItem = lookup.exactItem?.isExactTarget === true ? lookup.exactItem : exactItems[0];
  if (!exactItem || exactItems.length < 1) return null;
  return {
    ...lookup,
    item: exactItem,
    representativeItem: exactItem,
    exactItem,
    productExposureItems: exactItems,
    relatedCatalogRank: null,
    relatedCatalogIds: [],
    relatedCatalogContinuityUsed: false,
    verifiedRelatedCatalogId: null,
    trackingRankSource: "exact_product",
  };
}

function acceptableOptionCandidate(candidate, optionId, window) {
  const rank = Number(candidate?.rank);
  const item = candidate?.item;
  return Boolean(candidate)
    && candidate.matched === true
    && candidate.trackingRankSource === "exact_product"
    && Number.isSafeInteger(rank)
    && rank >= 1
    && rank <= Number(window?.checkedCount || 0)
    && Boolean(item)
    && typeof item === "object"
    && item.isExactTarget === true
    && item.isRelatedCatalog !== true
    && item.isOrganic !== false
    && item.isAd !== true
    && !isAdItem(item)
    && normalizeText(candidate.matchedProductId) === optionId;
}

function truncateTitle(value) {
  const title = normalizeText(value);
  return title.length > OPTION_TITLE_MAX ? `${title.slice(0, OPTION_TITLE_MAX - 1)}…` : title;
}

function optionEvaluationFailure(reason, error = null) {
  console.warn(JSON.stringify({
    level: "warn",
    event: "naver_rank_option_evaluation_failed",
    reason: String(reason || "").slice(0, 40),
    errorType: error instanceof Error ? String(error.name || "Error").slice(0, 40) : "",
  }));
}

// 같은 창(submit 한 번 = 키워드 한 묶음, 최대 100추적)에서 옵션 번호 하나의 정식 판정 결과는 추적과 상관없다.
// skipTargetMetadata:true 라 targetMallName·targetProductTitle 은 결과에 쓰이지 않고(naver-shopping-rank.mjs 의
// resolveRankTarget 만 읽고 이 경로는 그 함수를 건너뜀), 대표 URL·원부 연속성은 넘기지 않는다. 그래서 창·판정
// 함수·키워드·maxRank·번호로 결과를 기억해, 여러 추적이 같은 번호를 볼 때 300개를 다시 돌지 않는다.
// 창 하나에서 새로 도는 정식 판정은 OPTION_LOOKUPS_PER_WINDOW_MAX 번까지다. 넘으면 그 추적은 대표 결과 그대로
// 쓰고 경고 1줄만 남긴다 — 옵션 때문에 워커 submit 제한 시간(scripts/naver-shopping-local-worker.mjs, 지문 부품)을
// 넘겨 묶음 전체가 다시 수집되는(네이버 요청이 느는) 길을 막는다(반박 검토 2026-10-23).
export const OPTION_LOOKUPS_PER_WINDOW_MAX = 200;
const optionLookupStateByWindow = new WeakMap();

function newOptionLookupState(items) {
  return { source: items, length: items.length, used: 0, warned: false, byFinder: new Map() };
}

function optionLookupState(window) {
  const items = Array.isArray(window?.items) ? window.items : [];
  if (!window || typeof window !== "object") return newOptionLookupState(items);
  const cached = optionLookupStateByWindow.get(window);
  if (cached && cached.source === items && cached.length === items.length) return cached;
  const state = newOptionLookupState(items);
  optionLookupStateByWindow.set(window, state);
  return state;
}

function optionLookupCache(state, findRankFromWindow) {
  if (!state.byFinder.has(findRankFromWindow)) state.byFinder.set(findRankFromWindow, new Map());
  return state.byFinder.get(findRankFromWindow);
}

// 대표 결과(representativeResult)를 바탕으로 최종 결과를 고른다. 절대 던지지 않는다.
// [규칙 C' — 지휘 결정 2026-10-23, 명세 §6.3 D2 원안 바탕] 다른 스토어("mismatch")로 판정된 옵션만 뺀다. 확인됨
// ("matched")·확인 안 됨("unverified") 옵션 카드는 모두 대표 순위(상품·원부)와 똑같이 겨뤄 가장 높은 순위(작은
// 숫자)를 기록한다. 같으면 대표, 옵션끼리 같으면 확인됨 먼저. 대표가 보이든 안 보이든, 첫 확인·지난 기록 유무와
// 상관없이 같은 규칙이라, 같은 옵션 카드가 이기는 날은 대표가 보였는지와 상관없이 같은 순위다(튀지 않음).
// 대표가 이기면 대표 결과 그대로이고, 대표 순위와 다른 순위에서 옵션 카드가 보였으면 optionGroup.otherCardCount·
// otherCardBestRank 를, 다른 스토어로 뺀 번호가 있으면 optionGroup.mallMismatchCount·mallMismatchProductIds 를
// 덧붙인다(규칙 E' — 대표가 이겨도 흔적을 남긴다. 문장은 대표 결과 그대로라 광고주 화면에는 나가지 않는다).
// 둘 다 없으면 대표 결과 객체 그대로(옵션 없는 추적과 바이트 같음). 옵션이 이기면 대표가 보였던 순위를
// optionGroup.primaryProductRank·primaryRankSource 로 남긴다.
export async function evaluateGroupTrackingRank({
  window,
  tracker,
  representativeResult,
  optionProductIds = [],
  historyRows = [],
  maxRank = 300,
  selectRepresentative,
  acceptResult = () => true,
  findRankFromWindow = findShoppingRankFromWindow,
} = {}) {
  try {
    const optionIds = normalizeStoredOptionProductIds(optionProductIds);
    if (!optionIds.length || typeof selectRepresentative !== "function") return representativeResult;
    const primaryProductId = normalizeText(tracker?.product_id);
    const primaryRank = representativeResult?.matched === true ? positiveRank(representativeResult.rank) : null;
    const primaryFound = Boolean(primaryRank);
    const visibleIds = scanVisibleOptionProductIds(window, optionIds);
    const checkedOptionCount = optionIds.length;

    if (!visibleIds.length) {
      if (primaryFound) return representativeResult;
      return {
        ...representativeResult,
        matchBasis: "not_found",
        optionGroup: { checkedOptionCount },
      };
    }

    const keyword = normalizeText(tracker?.keyword);
    const lookupState = optionLookupState(window);
    const lookupCache = optionLookupCache(lookupState, findRankFromWindow);
    const cacheKey = (optionId) => `${keyword}\u0000${maxRank}\u0000${optionId}`;
    const missingCount = visibleIds.filter((optionId) => !lookupCache.has(cacheKey(optionId))).length;
    if (lookupState.used + missingCount > OPTION_LOOKUPS_PER_WINDOW_MAX) {
      if (!lookupState.warned) {
        lookupState.warned = true;
        optionEvaluationFailure("lookup_budget_exhausted");
      }
      return representativeResult;
    }

    const eligibility = trackerOptionEligibility(tracker);
    const referenceMallKeys = storeReferenceMallKeys(
      historyRows,
      eligibility.primaryProductIds,
      tracker?.mall_name,
      { representativeResult },
    );
    const accepted = [];
    const mallMismatchProductIds = [];
    for (const optionId of visibleIds) {
      const key = cacheKey(optionId);
      let entry = lookupCache.get(key);
      if (!entry) {
        lookupState.used += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          entry = { lookup: await findRankFromWindow(window, {
            keyword: tracker?.keyword,
            targetProductId: optionId,
            // 대표 URL 을 넣으면 번호가 달라 identityConflict 로 거절된다.
            targetUrl: "",
            targetMallName: tracker?.mall_name,
            targetProductTitle: tracker?.product_title,
            // 원부 연속성은 대표 번호 전용이다.
            verifiedRelatedCatalogId: "",
            maxRank,
            // 네이버 상품 페이지 요청 금지.
            skipTargetMetadata: true,
          }) };
        } catch (error) {
          entry = { error };
        }
        lookupCache.set(key, entry);
      }
      // 기억한 예외도 처음과 같이 아래 catch 로 가서 대표 결과를 쓴다.
      if (entry.error) throw entry.error;
      const exactLookup = exactOnlyOptionLookup(entry.lookup);
      if (!exactLookup) continue;
      const candidate = selectRepresentative(exactLookup, optionId);
      if (!acceptableOptionCandidate(candidate, optionId, window) || acceptResult(candidate) !== true) continue;
      const rank = Number(candidate.rank);
      const mallCheck = optionStoreCheck({
        cardMallName: candidate.item.mallName,
        cardLinks: [candidate.item.link, candidate.item.sourceLink],
        referenceMallKeys,
        trackerProductUrl: tracker?.product_url,
      });
      if (mallCheck === "mismatch") {
        // 대표 번호 카드와 같은 자리면 그 카드는 대표 카드 자신이다(그룹상품은 카드 한 장) — 다른 스토어 카드로
        // 세지 않는다(기준 이름이 어긋났을 뿐인 대표 카드에 '다른 스토어로 뺀 번호' 흔적이 붙지 않게).
        if (!(primaryFound && rank === primaryRank)) mallMismatchProductIds.push(optionId);
        continue;
      }
      accepted.push({ optionId, candidate, rank, mallCheck });
    }

    const cardRanks = [...new Set(accepted.map((entry) => entry.rank))].sort((left, right) => left - right);
    // [규칙 C'] 다른 스토어("mismatch") 카드는 위에서 이미 뺐다. 남은 확인됨·확인 안 됨 카드는 대표와 똑같이
    // 겨룬다: 가장 높은 순위, 옵션끼리 같은 순위면 확인됨 먼저(그다음은 창에 보인 번호 순서 — 정렬은 안정적이다).
    const checkOrder = (entry) => (entry.mallCheck === "matched" ? 0 : 1);
    const best = [...accepted].sort((left, right) => (left.rank - right.rank) || (checkOrder(left) - checkOrder(right)))[0] || null;
    const mismatchFields = mallMismatchProductIds.length
      ? { mallMismatchCount: mallMismatchProductIds.length, mallMismatchProductIds: [...mallMismatchProductIds] }
      : {};

    if (primaryFound && (!best || primaryRank <= best.rank)) {
      // 대표가 더 높거나 같다. 그룹상품은 카드 한 장이라, 대표 카드와 다른 순위에서 옵션이 보이면 잘못 넣은 번호일 수
      // 있어 확인 키만 남긴다(대표가 상품·원부 어느 쪽이든). 다른 스토어로 뺀 번호도 흔적으로 남긴다(규칙 E').
      // 문장(groupTrackingRankMessage 의 'primary')은 대표 결과 문장 그대로다.
      const otherCardRanks = cardRanks.filter((rank) => rank !== primaryRank);
      if (!otherCardRanks.length && !mallMismatchProductIds.length) return representativeResult;
      return {
        ...representativeResult,
        matchBasis: "primary",
        optionGroup: {
          checkedOptionCount,
          ...(otherCardRanks.length ? { otherCardCount: otherCardRanks.length, otherCardBestRank: otherCardRanks[0] } : {}),
          ...mismatchFields,
        },
        ...(mallMismatchProductIds.length ? { optionMallMismatchProductIds: mallMismatchProductIds } : {}),
      };
    }

    if (!best) {
      return {
        ...representativeResult,
        matchBasis: "not_found",
        optionGroup: {
          checkedOptionCount,
          ...mismatchFields,
        },
        optionMallMismatchProductIds: mallMismatchProductIds,
      };
    }

    const bestItem = best.candidate.item;
    const finalResult = {
      ...best.candidate,
      // 커밋 RPC 는 빈 product_id 를 이 값으로 채운다 — 대표 번호를 유지한다.
      targetProductId: primaryProductId,
      targetProductIds: [primaryProductId, ...optionIds],
      matchedProductId: best.optionId,
      // 대표 번호의 정확 순위 칸은 비운다. 대표가 보였으면 그 순위는 optionGroup.primaryProductRank 에만 둔다.
      exactProductRank: null,
      relatedCatalogRank: null,
      relatedCatalogProductId: null,
      relatedCatalogTitle: null,
      relatedCatalogRelationBasis: null,
      matchBasis: "group_option",
      matchedOptionProductId: best.optionId,
      optionGroup: {
        checkedOptionCount,
        matchedOptionTitle: truncateTitle(bestItem?.title),
        mallCheck: best.mallCheck,
        titleCheck: optionTitleCheck(tracker?.product_title, bestItem?.title),
        ...(cardRanks.length > 1 ? { cardCount: cardRanks.length } : {}),
        ...mismatchFields,
        ...(primaryFound ? {
          primaryProductRank: primaryRank,
          primaryRankSource: representativeResult.trackingRankSource === "related_catalog" ? "related_catalog" : "exact_product",
        } : {}),
      },
      optionMallMismatchProductIds: mallMismatchProductIds,
    };
    // 옵션으로 잡힌 행은 반드시 정확 상품이다. 원부로 저장되면 DB 원부 방어 트리거가 커밋 전체를
    // 막으므로 여기서 먼저 걸러 대표 결과로 돌아간다(422 로 묶음 전체를 실패시키지 않는다).
    if (finalResult.trackingRankSource !== "exact_product"
      || !acceptableOptionCandidate(finalResult, best.optionId, window)
      || acceptResult(finalResult) !== true) {
      optionEvaluationFailure("final_result_rejected");
      return representativeResult;
    }
    return finalResult;
  } catch (error) {
    optionEvaluationFailure("exception", error);
    return representativeResult;
  }
}

// ───────────────────────── 기록 문장·스냅샷 키 ─────────────────────────

function idListText(ids = []) {
  const shown = ids.slice(0, MESSAGE_ID_LIST_MAX).join(", ");
  return ids.length > MESSAGE_ID_LIST_MAX ? `${shown} 외 ${ids.length - MESSAGE_ID_LIST_MAX}개` : shown;
}

// 기록 문장(last_message·스냅샷 message)은 명세 §7.2 문장이 바탕이다. 관리자용 확인 사항(여러 카드·제목 차이·
// 다른 카드에서도 잡힘)은 문장에 넣지 않고 스냅샷 optionGroup 키로만 남긴다 — 관리자 화면 '잡힌 옵션'·'그룹상품
// 확인' 줄이 그 키를 읽는다(반박 검토 2026-10-23). 확인 안 된 옵션이 최종 순위로 쓰였을 때만 문장 꼬리
// GROUP_OPTION_UNVERIFIED_TAIL 을 붙인다(규칙 D' — 대표가 보였든 안 보였든. 기준이 없었는지 카드 이름이 없었는지는
// 단정하지 않는다). 대표가 이긴 결과('primary')는 다른 스토어로 뺀 번호가 있어도 대표 결과 문장 그대로다 — 그 번호는
// 스냅샷 optionGroup.mallMismatchProductIds 로만 남아 관리자 줄에 보인다(규칙 E').
// 이 꼬리는 관리자용이라 광고주 화면 '메시지' 칸은 이 꼬리를 뺀 문장을 보인다(client.html renderRankTrackerCard,
// 2차 수정 #10 원칙). 꼬리 글자를 바꾸면 두 화면의 같은 글자도 함께 바꾼다(화면 테스트가 대조한다).
export const GROUP_OPTION_UNVERIFIED_TAIL = " 스토어를 확인하지 못해 확인 없이 기록했습니다.";

export function groupTrackingRankMessage(result = {}, baseMessage = "") {
  const basis = result?.matchBasis;
  if (!basis) return baseMessage;
  const group = result.optionGroup && typeof result.optionGroup === "object" ? result.optionGroup : {};
  const mismatchIds = Array.isArray(result.optionMallMismatchProductIds) ? result.optionMallMismatchProductIds : [];
  const mismatchTail = mismatchIds.length ? ` 다른 스토어로 보여 뺀 옵션: ${idListText(mismatchIds)}.` : "";
  if (basis === "group_option") {
    const primaryRank = positiveRank(group.primaryProductRank);
    let primaryTail = " 대표 상품번호는 이번 결과에 없습니다.";
    if (primaryRank) {
      primaryTail = group.primaryRankSource === "related_catalog"
        ? ` 대표 상품번호의 관련 원부는 ${primaryRank}위입니다.`
        : ` 대표 상품번호는 ${primaryRank}위입니다.`;
    }
    const unverifiedTail = group.mallCheck === "unverified" ? GROUP_OPTION_UNVERIFIED_TAIL : "";
    return `그룹상품 옵션(상품번호 ${result.matchedOptionProductId})이 오가닉 ${result.rank}위로 잡혀 30일 대표 순위로 기록했습니다.${primaryTail}${unverifiedTail}${mismatchTail}`;
  }
  if (basis === "not_found") {
    const checked = Number(result.checkedCount || 0);
    const scope = checked > 0 ? `오가닉 상위 ${checked}개 결과` : "검색 결과";
    return `대표 상품번호와 그룹상품 옵션 ${Number(group.checkedOptionCount || 0)}개 모두 ${scope}에서 찾지 못했습니다.${mismatchTail}`;
  }
  return baseMessage;
}

// buildProductRankSnapshotRecord 가 item 끝에 붙이는 키. matchBasis 가 없으면 빈 객체라
// 옵션 없는 추적·대표로 잡힌 보통 행은 지금과 같은 바이트다.
export function groupOptionSnapshotFields(result = {}) {
  const basis = result?.matchBasis;
  if (!["group_option", "not_found", "primary"].includes(basis)) return {};
  const source = result.optionGroup && typeof result.optionGroup === "object" ? result.optionGroup : {};
  const optionGroup = {};
  for (const key of OPTION_GROUP_SNAPSHOT_KEYS) {
    const value = source[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const ids = normalizeStoredOptionProductIds(value);
      if (ids.length) optionGroup[key] = ids;
      continue;
    }
    optionGroup[key] = value;
  }
  return {
    matchBasis: basis,
    ...(basis === "group_option" ? { matchedOptionProductId: normalizeText(result.matchedOptionProductId) || null } : {}),
    optionGroup,
  };
}
