// 모먼트 옵션 확인(정식판) — 판정 부분. 화면은 panel.js, 즐겨찾기 버튼으로 묶기는 build.mjs.
// 맨 아래에는 인사이트로 넘기는 값(#mi-optfill=…)을 만드는 순수 함수가 있다(advertiser-impl-spec 1·3절, 2.1.0).
//
// 사람이 연 스마트스토어 상품 페이지에 이미 들어 있는 데이터(페이지 상태 객체)와 지금 상품번호만 받아
// 그룹상품 옵션(멤버 상품) 번호 목록을 고른다. 순수 함수만 둔다: 화면·주소창·저장소를 만지지 않고,
// 어디에도 요청을 보내지 않는다. 그래서 node 시험에서 그대로 부른다.
//
// 정한 것(formal-plan A1~A6, impl-spec 4절, 2026-10-31)
// - A1 경로에 group 이 들어 있고 지금 상품번호가 든 목록만 쓴다. 추천·함께 본 상품 같은 구역(NOT_GROUP)은 뺀다.
//   비슷한 목록을 추정하는 모드(시제품의 current_only·overlap)는 없다. 못 찾으면 not_found.
// - A2 버튼 안에 고정 비교 목록을 두지 않는다(비교는 인사이트 편집창이 저장값 기준으로 한다).
// - A3 이름은 화면 확인용이다. 항목 안 1~2단계까지 이름 같은 키에서 찾고, 숫자만 든 목록이면 같은 부모 아래
//   같은 길이의 이름 목록과 짝짓는다. 못 찾으면 빈 이름(화면이 '(이름 못 찾음)'으로 보여 줌).
// - A5 다 못 읽으면 거절(refused): 탐색 상한에 걸림 / 고른 목록에 번호를 알아보지 못한 항목이 하나라도 있음 /
//   지금 상품을 뺀 옵션이 50개 초과 / 숫자형 번호가 정확히 표현되는 범위(Number.MAX_SAFE_INTEGER)를 넘음 /
//   자리 수가 서버 규칙 밖. 거절이면 번호 목록(items·copyText)을 아예 돌려주지 않는다.
//   더해서(명세 밖, 같은 방향, 2026-10-31 지휘 결정 K1~K5, 검토 반영 B1·B2·H2~H4·M3):
//   · 객체 목록은 항목마다 키를 고르지 않는다(B1). 키(ID_KEYS)마다 모든 항목에서 번호 묶음을 따로 만들고, 지금 상품번호가
//     든 키의 묶음을 쓴다(주소의 번호는 id·channelProductNo 쪽이고 productNo 는 원상품 번호일 수 있다). 지금 상품번호가 든
//     키가 둘 이상이고 번호 묶음이 서로 다르면 거절(mixed_id_keys). 고른 키에 번호가 없는 항목이 있으면 unrecognized_items.
//   · 고른 목록 바깥에 지금 상품이 든 그룹 목록(어느 키로든, 번호 2개 이상)이 또 있고 번호 묶음이 다르면(부분·더 큰 묶음 포함)
//     거절(ambiguous). '바깥'은 경로 글자가 아니라 객체로 가린다 — 고른 목록 항목 안에 든 하위 목록만 바깥이 아니다.
//     [지금 상품] 하나뿐인 목록은 보지 않는다.
//   · 고른 목록을 품은 조상 목록 안(옵션 축별 묶음·쪽 나눔)에 지금 상품이 없는 그룹 상품번호 목록이 또 있으면 그룹이 여러
//     조각으로 나뉜 것일 수 있어 거절(group_list_split, B2). 같은 부모 묶음 아래 목록은 고른 목록과 길이가 같거나 키 이름에
//     orig(origin·original)가 들면 같은 항목을 다른 번호 체계로 적은 나란한 칸(channelProductNos 옆 originalProductNos 같은
//     것)이라 조각으로 보지 않고 진단(chosen.parallel)에만 적는다. 길이가 다르면 조각이다(F4).
//     [[번호, 번호], …] 짝 목록은 어느 쪽이 옵션 번호인지 몰라 목록으로 쓰지 않고, 그룹 구역에서 지금 상품이 들어 있으면
//     거절(unrecognized_items).
//   · 탐색 상한(노드·깊이·긴 목록·목록 수)은 어디서 걸려도 거절이다(H3). 지금 상품이 없는 목록은 목록 수 상한을 쓰지 않는다.
//   · 한 번 훑은 객체라도 만나는 자리(부모·조상 목록)마다 다시 훑는다 — 전체 '훑은 객체' 기억이 없다(H2·F1). 같은 목록이
//     캐시 쪽과 그룹의 둘째 쪽에 함께 걸려 있어도 쪽 나눔을 놓치지 않는다. 순환은 지금 자리의 조상으로만 막고, 공유가 많아
//     일이 불어나면 노드 상한(거절)이 막는다. 고른 목록이 여러 자리에서 보이면 자리마다 조각을 확인한다.
//   · 페이지 데이터 일부를 못 읽었으면(패널이 unreadableSources 로 알려 줌) 거절(source_unreadable, H4). 훑다가 값 읽기·키
//     목록 읽기가 던져도(읽으면 던지는 getter·프록시 함정) 세어서 같은 이유로 거절한다(F3, 진단 readErrors).
// - A4 복사 내용은 지금 상품 번호를 포함한 번호 목록, 한 줄에 하나(주소 형식 아님).
// - 진단(diag)에는 키 경로·개수·값 종류만 담는다. 글자 값(이름 등)은 넣지 않고, 번호는 찾았을 때만 넣는다.
//   키 이름 안의 5자리 이상 숫자(상품번호로 된 키, groupProduct_9988776655 같은 키)는 경로·키 목록 어디서든 '#n' 으로
//   가린다(K4·M3).
//
// 아래 세 값은 src/server/naver-rank-option-group.mjs 의 같은 이름 값과 같아야 한다(시험과 build.mjs 가 확인).

export const OPTION_CHECK_VERSION = "2.1.0";
export const OPTION_PRODUCT_IDS_MAX = 50;
export const OPTION_PRODUCT_ID_MIN_DIGITS = 5;
export const OPTION_PRODUCT_ID_MAX_DIGITS = 20;
// 탐색 상한. 시제품(노드 40만·깊이 16·목록 5000칸·후보 600개)에서 깊이만 32로 넓혔다 — 상한에 걸리면 이제 거절이라
// 실제 페이지에서 괜히 거절하지 않게 여유를 둔다(노드 상한이 전체 일을 묶는다).
export const SCAN_LIMITS = Object.freeze({ nodes: 400_000, depth: 32, arrayItems: 5_000, lists: 600 });

export const REASON_CODES = Object.freeze([
  "source_unreadable",
  "traversal_cap",
  "ambiguous",
  "group_list_split",
  "mixed_id_keys",
  "unrecognized_items",
  "unsafe_number",
  "digit_length",
  "too_many",
  "no_group_list",
  "group_list_without_current",
  // 판정이 직접 내지 않는 코드. 인사이트로 넘기는 진단(optionFillDiag)에서 이유를 못 정했을 때만 쓴다(advertiser-impl-spec 1절 목록과 같게).
  "not_found",
]);

const CANDIDATE_DIAG_MAX = 12;
const GROUP_KEYS_DIAG_MAX = 40;
const DIAG_KEYS_MAX = 40;
const DIAG_IDS_MAX = 60;
const KIND_KEYS_MAX = 8;
const NAME_MAX_CHARS = 60;
const NAME_SEARCH_DEPTH = 2;
const NAME_SEARCH_WIDTH = 50;
const ID_STRING_MAX_CHARS = 40;

const DIGITS = /^[0-9]+$/;
const PRODUCT_ID_RULE = new RegExp(`^[0-9]{${OPTION_PRODUCT_ID_MIN_DIGITS},${OPTION_PRODUCT_ID_MAX_DIGITS}}$`);
// 상품번호처럼 보이는 키(5자리 이상 숫자)와, 키 이름 안에 든 5자리 이상 숫자. 진단에는 '#n' 으로만 남긴다
// (다른 상품번호가 진단에 실리지 않게, K4·M3).
const NUMBER_LIKE_KEY = new RegExp(`^[0-9]{${OPTION_PRODUCT_ID_MIN_DIGITS},}$`);
const NUMBER_RUN = new RegExp(`[0-9]{${OPTION_PRODUCT_ID_MIN_DIGITS},}`, "g");
const NUMBER_KEY_MASK = "#n";
// 번호 목록 항목이 객체가 아니라 번호 그 자체일 때 '읽은 키' 자리에 넣는 표시.
const VALUE_ITEM_KEY = "(값)";
// 개인정보·인증값이 있을 수 있는 키는 들어가지도, 진단에 이름을 남기지도 않는다
// (groupMembers 같은 상품 묶음 키는 막지 않게 member 는 정확한 이름만).
const SENSITIVE = /token|cookie|session|auth|csrf|secret|password|login|address|phone|email|buyer|payment|card|account|nickname|profile|^user|^member(Info|No|Id|Key|ship|Grade)?$/i;
// 추천·함께 본 상품 같은 구역은 그룹 옵션 후보에서 뺀다(오탐 방지). 진단에는 남긴다.
const NOT_GROUP = /recommend|together|similar|best|ranking|banner|review|benefit|coupon|related|popular|advert|^ads?$/i;
const GROUP_MARK = /group/i;
// 이름을 찾으러 들어가지 않는 하위 묶음(스토어·브랜드·이미지 이름이 옵션 이름처럼 보이지 않게).
const NAME_SKIP = /channel|store|seller|mall|brand|manufactur|maker|category|image|thumbnail|delivery|shipping|benefit|review|price|discount|coupon/i;
const NAME_LIKE_KEY = /name|title|label|text/i;
// 숫자만 든 목록과 짝지을 '글자만 든 목록'은 키 이름에 name 이 있을 때만 쓴다(optionName·valueName·productName 등).
// 상태·배지·라벨·문구·제목 목록(statusText 의 '판매중'·'품절' 같은 것)은 이름으로 쓰지 않는다(K7).
const BARE_NAME_KEY = /name/i;
const BARE_NAME_EXCLUDE = /status|badge|label|text|title/i;
const DIAG_SEGMENT = /^[A-Za-z0-9_$-]{1,40}$/;
// 같은 부모 묶음 아래 원상품 번호 칸(originalProductNos·originProductNos 등). 길이가 달라도 나란한 칸으로 본다(F4).
const PARALLEL_KEY = /orig/i;
const ID_KEYS = ["productNo", "channelProductNo", "productId", "id", "no"];
// 번호를 읽는 칸 순서. 번호 그 자체 항목(VALUE_ITEM_KEY)도 한 칸으로 본다.
const ID_COLUMNS = [VALUE_ITEM_KEY, ...ID_KEYS];
const NAME_KEYS = ["optionName", "valueName", "name", "productName", "dispName", "channelProductName", "title", "label", "text"];
const STORE_HOST = /(^|\.)(smartstore|brand)\.naver\.com$/i;
const PRODUCT_PATH = /^\/([^/]+)\/products\/([0-9]{1,30})(?:\/|$)/;

export function reasonFor(code, count = 0) {
  const texts = {
    source_unreadable: "페이지 데이터 일부를 읽지 못했습니다.",
    traversal_cap: "페이지 데이터가 커서 끝까지 훑지 못했습니다.",
    ambiguous: "지금 상품이 든 그룹 목록이 여러 개이고 번호가 서로 달라 하나로 정하지 못했습니다.",
    group_list_split: "그룹 목록이 여러 조각으로 나뉘어 있어 한 번에 읽지 못했습니다.",
    unrecognized_items: `그룹 목록 항목 ${count}개에서 상품번호를 알아보지 못했습니다.`,
    unsafe_number: `상품번호 ${count}개가 너무 큰 숫자로 들어 있어 정확히 읽을 수 없습니다.`,
    digit_length: `상품번호 ${count}개가 ${OPTION_PRODUCT_ID_MIN_DIGITS}~${OPTION_PRODUCT_ID_MAX_DIGITS}자리 숫자가 아닙니다.`,
    too_many: `지금 상품을 뺀 옵션이 ${count}개라 저장 한도 ${OPTION_PRODUCT_IDS_MAX}개를 넘습니다.`,
    no_group_list: "페이지 데이터에 그룹 표시가 있는 상품번호 목록이 없습니다.",
    group_list_without_current: "그룹 목록은 있지만 지금 상품번호가 든 목록이 없습니다.",
    mixed_id_keys: `그룹 목록에서 지금 상품번호가 든 칸이 ${count}가지이고 칸마다 번호 묶음이 달라, 어느 칸이 옵션 상품번호인지 알 수 없습니다.`,
    not_found: "이 페이지에서 그룹상품 옵션 목록을 찾지 못했습니다.",
  };
  return { code, count, text: texts[code] || "" };
}

// 주소가 스마트스토어·브랜드스토어 상품 페이지면 { store, productId }, 아니면 null.
export function productPageFromUrl(href) {
  let url = null;
  try {
    url = new URL(String(href || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!STORE_HOST.test(url.hostname)) return null;
  const match = PRODUCT_PATH.exec(url.pathname);
  if (!match) return null;
  return { store: diagSegment(match[1]), productId: match[2] };
}

export function isServerProductId(id) {
  return typeof id === "string" && PRODUCT_ID_RULE.test(id);
}

// 아래 읽기 도우미는 던지지 않는다. tally({ errors }) 를 넘기면 던진 횟수를 센다(F3) — 탐색에서는 넘기고, 이름 찾기·진단처럼
// 판정에 쓰지 않는 읽기에서는 넘기지 않는다.
function countReadError(tally) {
  if (tally) tally.errors += 1;
}

function safeGet(owner, key, tally) {
  try {
    return owner[key];
  } catch {
    countReadError(tally);
    return undefined;
  }
}

function safeKeys(value, tally) {
  try {
    return Object.keys(value);
  } catch {
    countReadError(tally);
    return [];
  }
}

function safeLength(array, tally) {
  const length = safeGet(array, "length", tally);
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

// 목록이면 true, 아니면 false, 알아볼 수 없으면(폐기된 프록시 등) null.
function arrayKind(value, tally) {
  try {
    return Array.isArray(value);
  } catch {
    countReadError(tally);
    return null;
  }
}

function isPlainObject(value, tally) {
  return Boolean(value) && typeof value === "object" && arrayKind(value, tally) === false;
}

// 진단에 남기는 키 이름 하나. 상품번호처럼 보이는 키는 '#n', 영문·숫자 모양이 아닌 키는 '?',
// 키 이름 안에 든 5자리 이상 숫자는 그 부분만 '#n'(groupProduct_9988776655 → groupProduct_#n).
// 경로·후보 경로·group 키·묶음 키 목록·읽은 칸 이름이 모두 이 함수를 거친다(K4·M3).
function diagSegment(key) {
  const text = String(key);
  if (NUMBER_LIKE_KEY.test(text)) return NUMBER_KEY_MASK;
  return DIAG_SEGMENT.test(text) ? text.replace(NUMBER_RUN, NUMBER_KEY_MASK) : "?";
}

// 값 종류만(값 없음). 글자는 길이만, 묶음은 키 이름만 몇 개.
function kindOf(value) {
  if (value === null) return "null";
  if (value === undefined) return "없음";
  if (typeof value === "number") return "숫자";
  if (typeof value === "boolean") return "참거짓";
  if (typeof value === "string") return `글자 ${value.length}자`;
  const array = arrayKind(value);
  if (array === null) return "읽지 못함";
  if (array) return `목록 ${safeLength(value)}개`;
  if (typeof value === "object") {
    const keys = safeKeys(value).filter((key) => !SENSITIVE.test(key)).slice(0, KIND_KEYS_MAX).map(diagSegment);
    return `묶음(${keys.join(",")})`;
  }
  return typeof value;
}

function describeKeys(owner, markKey = null) {
  if (!isPlainObject(owner)) return [];
  return safeKeys(owner)
    .filter((key) => !SENSITIVE.test(key))
    .slice(0, DIAG_KEYS_MAX)
    .map((key) => (key === markKey
      ? { key: diagSegment(key), type: kindOf(safeGet(owner, key)), chosen: true }
      : { key: diagSegment(key), type: kindOf(safeGet(owner, key)) }));
}

// 번호 하나 읽기. 숫자형은 정수만, 정확히 표현되지 않는 큰 수는 unsafe 로 표시한다(반올림된 번호일 수 있음).
function idValue(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return Number.isSafeInteger(value) ? { id: String(value), unsafe: false } : { id: "", unsafe: true };
  }
  if (typeof value === "string" && value.length <= ID_STRING_MAX_CHARS && DIGITS.test(value)) return { id: value, unsafe: false };
  return null;
}

function idKeyLabel(key) {
  return key === VALUE_ITEM_KEY ? key : diagSegment(key);
}

// 목록 하나를 칸(키)별로 읽는다(B1). 항목마다 키를 고르지 않고, 키마다 모든 항목에서 번호를 모은다.
// 칸: { key, ids(겹친 번호 뺀 번호 묶음), entries(겹친 번호를 뺀 칸, 순서대로, 너무 큰 숫자형 포함), present(번호가 든 항목 수),
//       duplicates, unsafe }. 칸 순서는 ID_COLUMNS 순서.
function readIdColumns(array, scanned, tally) {
  const byKey = new Map();
  const add = (key, found, index) => {
    let column = byKey.get(key);
    if (!column) {
      column = { key, ids: new Set(), entries: [], present: 0, duplicates: 0, unsafe: 0 };
      byKey.set(key, column);
    }
    column.present += 1;
    if (found.unsafe) {
      column.unsafe += 1;
      column.entries.push({ ...found, index });
    } else if (column.ids.has(found.id)) {
      column.duplicates += 1;
    } else {
      column.ids.add(found.id);
      column.entries.push({ ...found, index });
    }
  };
  for (let index = 0; index < scanned; index += 1) {
    const item = safeGet(array, index, tally);
    if (isPlainObject(item, tally)) {
      for (const key of ID_KEYS) {
        const found = idValue(safeGet(item, key, tally));
        if (found) add(key, found, index);
      }
    } else {
      const found = idValue(item);
      if (found) add(VALUE_ITEM_KEY, found, index);
    }
  }
  return ID_COLUMNS.map((key) => byKey.get(key)).filter(Boolean);
}

// 번호가 2개 이상(겹친 번호 빼고) 든 칸만 목록 칸으로 본다. [지금 상품] 하나뿐인 칸은 보지 않는다.
function isListColumn(column) {
  return column.present >= 2 && column.entries.length >= 2;
}

// 칸의 번호가 모두 상품번호 모양(서버 자리 수 규칙, 또는 너무 큰 숫자형)인가. 쪼개진 조각(B2)은 이런 칸만 본다
// (이미지·옵션 순번 같은 작은 번호 목록이 조각으로 잡히지 않게).
function isProductColumn(column) {
  if (!column.entries.length) return false;
  for (const entry of column.entries) if (!entry.unsafe && !isServerProductId(entry.id)) return false;
  return true;
}

// 항목이 모두 [번호, 번호] 짝인 목록인가([[채널 번호, 원상품 번호], …] 처럼 어느 쪽이 옵션 번호인지 알 수 없는 모양, B2).
function isIdPairs(array, scanned, tally) {
  if (scanned < 1) return false;
  for (let index = 0; index < scanned; index += 1) {
    const item = safeGet(array, index, tally);
    if (arrayKind(item, tally) !== true || safeLength(item, tally) !== 2) return false;
    if (!idValue(safeGet(item, 0, tally)) || !idValue(safeGet(item, 1, tally))) return false;
  }
  return true;
}

function pairsHold(array, scanned, id, tally) {
  if (!id) return false;
  for (let index = 0; index < scanned; index += 1) {
    const item = safeGet(array, index, tally);
    for (const side of [0, 1]) {
      const found = idValue(safeGet(item, side, tally));
      if (found && found.id === id) return true;
    }
  }
  return false;
}

// 두 번호 묶음이 똑같은가(순서·겹친 번호는 보지 않음). 너무 큰 숫자형 번호가 있으면 비교할 수 없어 다르다고 본다.
function sameIdSet(left, right) {
  if (left.unsafe > 0 || right.unsafe > 0 || left.ids.size !== right.ids.size) return false;
  for (const id of left.ids) if (!right.ids.has(id)) return false;
  return true;
}

// 조상 목록 사슬({ array, up })에 이 목록 객체가 있는가.
function chainHas(node, array) {
  for (let cursor = node; cursor; cursor = cursor.up) if (cursor.array === array) return true;
  return false;
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || DIGITS.test(text) || /^https?:/i.test(text)) return "";
  return text.slice(0, NAME_MAX_CHARS);
}

// 항목 자신 → 1단계 → 2단계 안쪽 묶음 순서로 이름 같은 키를 찾는다(목록·민감 키·스토어 같은 묶음은 들어가지 않음).
function nameOf(item) {
  if (!isPlainObject(item)) return "";
  let level = [item];
  for (let depth = 0; depth <= NAME_SEARCH_DEPTH && level.length; depth += 1) {
    for (const owner of level) {
      for (const key of NAME_KEYS) {
        const name = cleanName(safeGet(owner, key));
        if (name) return name;
      }
    }
    const next = [];
    for (const owner of level) {
      for (const key of safeKeys(owner)) {
        if (next.length >= NAME_SEARCH_WIDTH) break;
        if (SENSITIVE.test(key) || NAME_SKIP.test(key)) continue;
        const child = safeGet(owner, key);
        if (isPlainObject(child)) next.push(child);
      }
    }
    level = next;
  }
  return "";
}

// 숫자만 든 목록이면 같은 부모 아래 같은 길이의 이름 목록(글자만 든 목록은 키 이름에 name 이 있고 상태·배지·라벨·
// 문구·제목 목록이 아닐 때만)이나 이름을 가진 묶음 목록과 짝짓는다. 모든 칸에서 이름이 나와야 쓴다.
function siblingNames(list, limits) {
  const owner = list.parent && list.parent.owner;
  if (!isPlainObject(owner)) return null;
  const found = [];
  for (const key of safeKeys(owner)) {
    if (key === list.parent.key || SENSITIVE.test(key) || NAME_SKIP.test(key)) continue;
    const other = safeGet(owner, key);
    if (arrayKind(other) !== true || other === list.array) continue;
    const length = safeLength(other);
    if (length !== list.length || length > limits.arrayItems) continue;
    const bareNames = BARE_NAME_KEY.test(key) && !BARE_NAME_EXCLUDE.test(key);
    const names = [];
    for (let index = 0; index < length; index += 1) {
      const element = safeGet(other, index);
      const name = isPlainObject(element) ? nameOf(element) : bareNames ? cleanName(element) : "";
      if (!name) break;
      names.push(name);
    }
    if (names.length === length) found.push({ key, names });
  }
  return found.find((entry) => NAME_LIKE_KEY.test(entry.key)) || found[0] || null;
}

function namesFor(list, limits) {
  const entries = list.main.entries;
  const fromItems = entries.map((entry) => nameOf(safeGet(list.array, entry.index)));
  if (fromItems.some(Boolean)) return { names: fromItems, source: "item" };
  const sibling = siblingNames(list, limits);
  if (sibling) return { names: entries.map((entry) => sibling.names[entry.index] || ""), source: `sibling:${diagSegment(sibling.key)}` };
  return { names: fromItems, source: "none" };
}

// 고른 목록이 보인 한 자리(place: 부모·조상 사슬) 둘레의 지금 상품 없는 그룹 상품번호 목록을 가른다(B2·F4).
// 고른 목록 항목 안에 든 목록은 보지 않는다.
// - split: 쪼개진 조각. 고른 목록을 품은 조상 목록 안의 목록(옵션 축 묶음·쪽 나눔 — 길이·키와 상관없음), 또는 같은 부모
//   묶음 아래 목록 중 길이가 다르고 키에 orig 가 없는 것.
// - parallel: 같은 부모 묶음 아래 나란한 칸 — 고른 목록과 길이가 같거나 키에 orig 가 든 목록(원상품 번호처럼 같은 항목을 다른
//   번호 체계로 적은 칸). 조각으로 보지 않고 진단에만 적는다. 같은 부모인지를 조상 목록보다 먼저 본다(같은 쪽 안의 나란한 칸은
//   조상 목록도 같으므로).
function piecesAround(place, pieces) {
  const ancestors = new Set();
  for (let cursor = place.ancestry; cursor; cursor = cursor.up) ancestors.add(cursor.array);
  const owner = place.parent ? place.parent.owner : null;
  const split = [];
  const parallel = [];
  for (const piece of pieces) {
    if (!piece.productLike || piece.array === place.array || chainHas(piece.ancestry, place.array)) continue;
    if (owner && piece.owner === owner) {
      // 길이가 같다는 것만으로는 나란한 칸으로 보지 않는다 — 크기가 같은 쪽 나눔(pages.1·pages.2)·옵션 축 묶음을 형제 키로
      // 두면 절반만 복사된다(Codex·반박 검토 2026-11-01). 키에 orig 가 든 칸만 나란한 칸이다(모르면 거절 쪽).
      const parallelColumn = typeof piece.key === "string" && PARALLEL_KEY.test(piece.key);
      (parallelColumn ? parallel : split).push(piece);
      continue;
    }
    // 같은 키 이름의 목록이 형제 묶음(같은 할아버지 객체 아래 다른 객체)에 있으면 쪽 묶음을 객체로 나눈 모양이다
    // (pages: { "1": { channelProductNos }, "2": { channelProductNos } }).
    if (place.grandOwner && piece.grandOwner === place.grandOwner && piece.key === place.key) {
      split.push(piece);
      continue;
    }
    for (let cursor = piece.ancestry; cursor; cursor = cursor.up) {
      if (ancestors.has(cursor.array)) {
        split.push(piece);
        break;
      }
    }
  }
  return { split, parallel };
}

// 같은 목록 객체가 여러 자리에서 보이면 하나만 남긴다(진단·개수용).
function distinctArrays(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.array)) return false;
    seen.add(entry.array);
    return true;
  });
}

function normalizeRoots(roots) {
  if (Array.isArray(roots)) {
    return roots
      .filter((root) => root && typeof root === "object" && "value" in root)
      .map((root, index) => ({ label: diagSegment(root.label || `ROOT${index}`), value: root.value }));
  }
  return roots && typeof roots === "object" ? [{ label: "STATE", value: roots }] : [];
}

// roots: 페이지 상태 객체 하나, 또는 [{ label, value }] 목록(패널이 __PRELOADED_STATE__·JSON 스크립트로 만든다).
// unreadableSources: 패널이 읽으려다 못 읽은 데이터 묶음 수(페이지 상태 읽기 오류·JSON 이 깨진 데이터 스크립트). 1 이상이면 거절.
// 돌려주는 것: { status: "found" | "not_found" | "refused", items, copyText, optionCount, reasons, diag }
// - found 일 때만 items([{ id, name, current }])·copyText 가 찬다. 그 밖에는 빈 목록·빈 글자.
export function findGroupOptions(roots, currentProductId, { limits = {}, unreadableSources = 0 } = {}) {
  const scan = { ...SCAN_LIMITS, ...limits };
  const current = typeof currentProductId === "string" && DIGITS.test(currentProductId)
    ? currentProductId
    : Number.isSafeInteger(currentProductId) && currentProductId >= 0 ? String(currentProductId) : "";
  const unreadable = Number.isSafeInteger(unreadableSources) && unreadableSources > 0 ? unreadableSources : 0;
  const rootList = normalizeRoots(roots);
  // 전체 '훑은 객체' 기억은 두지 않는다(H2·F1). 다른 곳(그룹 밖·그룹 안 캐시 등)에서 이미 훑은 객체도 지금 자리(부모·조상
  // 목록)에서 다시 훑어야 그 자리의 조각·나란한 칸을 볼 수 있다. 순환 참조는 지금 자리의 조상(onPath)으로만 막고,
  // 공유가 많아 일이 불어나면 노드 상한(어디서 걸려도 거절)이 막는다.
  const onPath = new WeakSet();
  // 훑다가 값 읽기·키 목록 읽기가 던진 횟수(F3). 1 이상이면 거절(source_unreadable).
  const reads = { errors: 0 };
  // 어디서 걸려도 거절이다(H3).
  const cut = { nodes: false, depth: 0, arrays: 0, lists: 0 };
  // 지금 상품이 든 목록만 담는다(그룹 표시와 상관없이 — 진단 후보로도 보여 줌). 상한 scan.lists.
  const lists = [];
  // 지금 상품이 없는 그룹 목록(번호 1개 이상). 쪼개진 조각 확인(B2)과 진단에만 쓰고 목록 수 상한을 쓰지 않는다.
  const pieces = [];
  // 그룹 구역에서 지금 상품이 든 [번호, 번호] 짝 목록.
  const pairLists = [];
  const groupKeys = [];
  // 지금 자리의 조상 목록 사슬 { array, up }. 목록마다 이 고리 하나만 붙여 두고 '어느 목록 안인가'를 경로 글자가 아니라
  // 객체로 가린다(K5·B2).
  let ancestry = null;
  // 지금 자리까지 거쳐 온 객체(목록 제외). 목록이 든 객체(owner)의 바로 위 객체를 찾아 형제 묶음 조각을 가린다.
  const objectStack = [];
  const grandOwnerNow = () => (objectStack.length >= 2 ? objectStack[objectStack.length - 2] : null);
  // 같은 목록 객체를 여러 자리에서 다시 볼 때 칸 읽기 결과를 다시 쓴다. 숫자만 든 목록은 안으로 들어갈 것이 없으므로
  // 두 번째부터 항목 순회도 건너뛴다(공유가 겹겹이면 자리마다 5000칸을 다시 읽어 탭이 멈추는 것을 막음).
  const arrayInfo = new WeakMap();
  let nodes = 0;
  let otherLists = 0;

  function addList(path, array, columns, length, parent, flags) {
    const inGroup = flags.group && !flags.excluded;
    if (!current || !columns.some((column) => column.ids.has(current))) {
      if (!inGroup) {
        if (columns.some(isListColumn)) otherLists += 1;
        return;
      }
      const productColumns = columns.filter(isProductColumn);
      pieces.push({
        path, array, ancestry, length,
        owner: parent ? parent.owner : null,
        grandOwner: parent ? grandOwnerNow() : null,
        key: parent ? parent.key : null,
        count: Math.max(...columns.map((column) => column.entries.length)),
        productLike: productColumns.length > 0,
      });
      return;
    }
    // 지금 상품번호가 든 목록 칸. 번호 2개 이상인 칸만 본다([지금 상품] 하나뿐인 칸은 목록이 아님).
    const holding = columns.filter((column) => isListColumn(column) && column.ids.has(current));
    if (!holding.length) return;
    if (lists.length >= scan.lists) {
      cut.lists += 1;
      return;
    }
    // 지금 상품번호가 든 칸이 둘 이상이면 번호 묶음이 모두 같아야 한다(다르면 mixed). 같으면 모든 항목에 번호가 든 칸을 먼저 쓴다.
    const main = holding.find((column) => column.present === length) || holding[0];
    lists.push({
      path, array, main, holding, length, parent, ancestry,
      key: parent ? parent.key : null,
      grandOwner: parent ? grandOwnerNow() : null,
      mixed: holding.some((column) => column !== main && !sameIdSet(column, main)),
      groupPath: flags.group, excluded: flags.excluded,
    });
  }

  function readArrayInfo(array) {
    let info = arrayInfo.get(array);
    if (info) return info;
    const length = safeLength(array, reads);
    const scanned = Math.min(length, scan.arrayItems);
    const pairs = isIdPairs(array, scanned, reads);
    let hasObjects = false;
    if (!pairs) {
      for (let index = 0; index < scanned && !hasObjects; index += 1) {
        const item = safeGet(array, index, reads);
        hasObjects = Boolean(item) && typeof item === "object";
      }
    }
    info = {
      length,
      scanned,
      pairs,
      pairsHoldCurrent: pairs ? pairsHold(array, scanned, current, reads) : false,
      columns: pairs ? [] : readIdColumns(array, scanned, reads),
      hasObjects,
    };
    arrayInfo.set(array, info);
    return info;
  }

  function walkArray(array, path, depth, parent, flags) {
    const info = readArrayInfo(array);
    const { length, scanned } = info;
    if (length > scan.arrayItems) cut.arrays += 1;
    if (info.pairs) {
      // 짝 목록은 목록으로 쓰지 않고 안으로도 들어가지 않는다(안쪽 [번호, 번호] 하나를 그룹 목록으로 고르지 않게).
      if (flags.group && !flags.excluded && info.pairsHoldCurrent) pairLists.push({ path, count: scanned });
      return;
    }
    if (info.columns.length) addList(path, array, info.columns, length, parent, flags);
    if (!info.hasObjects) return;
    const outer = ancestry;
    ancestry = { array, up: outer };
    for (let index = 0; index < scanned; index += 1) walk(safeGet(array, index, reads), `${path}[]`, depth + 1, null, flags);
    ancestry = outer;
  }

  function walkObject(owner, path, depth, flags) {
    for (const key of safeKeys(owner, reads)) {
      if (SENSITIVE.test(key)) continue;
      const child = safeGet(owner, key, reads);
      const childPath = `${path}.${diagSegment(key)}`;
      const group = GROUP_MARK.test(key);
      if (group && groupKeys.length < GROUP_KEYS_DIAG_MAX) groupKeys.push({ path: childPath, type: kindOf(child) });
      walk(child, childPath, depth + 1, { owner, key }, {
        group: flags.group || group,
        excluded: flags.excluded || NOT_GROUP.test(key),
      });
    }
  }

  function walk(value, path, depth, parent, flags) {
    if (!value || typeof value !== "object") return;
    if (onPath.has(value)) return;
    if (nodes >= scan.nodes) {
      cut.nodes = true;
      return;
    }
    if (depth > scan.depth) {
      cut.depth += 1;
      return;
    }
    nodes += 1;
    const array = arrayKind(value, reads);
    if (array === null) return;
    onPath.add(value);
    if (array) {
      walkArray(value, path, depth, parent, flags);
    } else {
      objectStack.push(value);
      walkObject(value, path, depth, flags);
      objectStack.pop();
    }
    onPath.delete(value);
  }

  for (const root of rootList) walk(root.value, root.label, 0, null, { group: false, excluded: false });

  const capped = cut.nodes || cut.depth > 0 || cut.arrays > 0 || cut.lists > 0;
  const withCurrent = lists
    .filter((list) => list.groupPath && !list.excluded)
    .sort((a, b) => b.main.entries.length - a.main.entries.length);
  const chosen = withCurrent[0] || null;
  const groupListsWithoutCurrent = distinctArrays(pieces.filter((piece) => piece.count >= 2)).length;
  const reasons = [];
  if (unreadable + reads.errors > 0) reasons.push(reasonFor("source_unreadable", unreadable + reads.errors));
  if (capped) reasons.push(reasonFor("traversal_cap"));
  let split = [];
  let parallel = [];
  let unknownItems = pairLists.reduce((sum, list) => sum + list.count, 0);
  let optionCount = 0;
  if (chosen) {
    // 고른 목록 항목 안에 든 하위 목록(조상에 고른 목록 객체가 있음)만 뺀다. 지금 상품이 든 다른 그룹 목록은 어느 칸으로든
    // 번호 묶음이 조금이라도 다르면(부분 목록·더 큰 목록 포함) 하나로 정하지 않는다(K1·K5·B1).
    const conflicting = withCurrent.some((other) => other !== chosen
      && other.array !== chosen.array
      && !chainHas(other.ancestry, chosen.array)
      && other.holding.some((column) => !sameIdSet(column, chosen.main)));
    if (conflicting) reasons.push(reasonFor("ambiguous"));
    // 고른 목록이 그룹 구역의 여러 자리에서 보이면(F1) 자리마다 조각을 본다. 어느 자리에서든 조각이면 조각이다.
    const splitFound = [];
    const parallelFound = [];
    for (const place of withCurrent) {
      if (place.array !== chosen.array) continue;
      const around = piecesAround(place, pieces);
      splitFound.push(...around.split);
      parallelFound.push(...around.parallel);
    }
    split = distinctArrays(splitFound);
    const splitArrays = new Set(split.map((piece) => piece.array));
    parallel = distinctArrays(parallelFound.filter((piece) => !splitArrays.has(piece.array)));
    if (split.length) reasons.push(reasonFor("group_list_split", split.length));
    if (chosen.mixed) reasons.push(reasonFor("mixed_id_keys", chosen.holding.length));
    // 80% 규칙 없음: 고른 칸에 번호가 없는 항목(겹친 번호는 번호가 있는 것으로 셈)이 하나라도 있으면 거절한다.
    unknownItems += chosen.length - chosen.main.present;
  }
  if (unknownItems > 0) reasons.push(reasonFor("unrecognized_items", unknownItems));
  if (chosen) {
    if (chosen.main.unsafe > 0) reasons.push(reasonFor("unsafe_number", chosen.main.unsafe));
    const badDigits = [...chosen.main.ids].filter((id) => !isServerProductId(id)).length;
    if (badDigits > 0) reasons.push(reasonFor("digit_length", badDigits));
    optionCount = chosen.main.ids.size - 1 + chosen.main.unsafe;
    if (optionCount > OPTION_PRODUCT_IDS_MAX) reasons.push(reasonFor("too_many", optionCount));
  }

  let status = "found";
  if (reasons.length) status = "refused";
  else if (!chosen) {
    status = "not_found";
    reasons.push(reasonFor(groupListsWithoutCurrent > 0 ? "group_list_without_current" : "no_group_list"));
  }

  let items = [];
  let nameSource = "none";
  if (status === "found") {
    const named = namesFor(chosen, scan);
    nameSource = named.source;
    items = chosen.main.entries.map((entry, index) => ({ id: entry.id, name: named.names[index] || "", current: entry.id === current }));
  }

  const firstItem = chosen ? safeGet(chosen.array, chosen.main.entries[0].index) : undefined;
  const pieceDiag = (piece) => ({ path: piece.path, count: piece.count });
  const candidates = [
    ...lists.map((list) => ({ path: list.path, count: list.main.entries.length, hasCurrent: true, groupPath: list.groupPath, excluded: list.excluded })),
    ...pieces.filter((piece) => piece.count >= 2).slice(0, CANDIDATE_DIAG_MAX)
      .map((piece) => ({ ...pieceDiag(piece), hasCurrent: false, groupPath: true, excluded: false })),
  ];
  const diag = {
    v: OPTION_CHECK_VERSION,
    status,
    reasons: reasons.map((reason) => reason.code),
    roots: rootList.map((root) => root.label),
    unreadableSources: unreadable,
    readErrors: reads.errors,
    nodes,
    cut: { ...cut },
    otherLists,
    groupListsWithoutCurrent,
    pairLists: pairLists.slice(0, CANDIDATE_DIAG_MAX),
    chosen: chosen ? {
      path: chosen.path,
      length: chosen.length,
      count: chosen.main.entries.length,
      unrecognized: chosen.length - chosen.main.present,
      duplicates: chosen.main.duplicates,
      unsafe: chosen.main.unsafe,
      hasCurrent: true,
      idKey: idKeyLabel(chosen.main.key),
      idKeys: chosen.holding.map((column) => idKeyLabel(column.key)),
      ids: status === "found" ? [...chosen.main.ids].slice(0, DIAG_IDS_MAX) : [],
      split: split.slice(0, CANDIDATE_DIAG_MAX).map(pieceDiag),
      parallel: parallel.slice(0, CANDIDATE_DIAG_MAX).map(pieceDiag),
      parentKeys: describeKeys(chosen.parent && chosen.parent.owner, chosen.parent && chosen.parent.key),
      firstItem: isPlainObject(firstItem) ? describeKeys(firstItem) : kindOf(firstItem),
      names: { found: items.filter((item) => item.name).length, source: nameSource },
    } : null,
    candidates: candidates
      .sort((a, b) => (Number(b.hasCurrent) - Number(a.hasCurrent))
        || (Number(b.groupPath) - Number(a.groupPath))
        || (b.count - a.count))
      .slice(0, CANDIDATE_DIAG_MAX),
    groupKeys,
  };

  return {
    status,
    items,
    copyText: items.map((item) => item.id).join("\n"),
    optionCount: status === "found" ? optionCount : 0,
    reasons,
    diag,
  };
}

// ── 인사이트로 넘기는 값(advertiser-impl-spec 1·3절, 2026-11-01) ──
// 버튼은 값을 만들기만 한다. 창 열기는 panel.js 주 버튼 한 곳뿐이고, 값은 고정 주소의 '#mi-optfill=' 뒤에만 싣는다(쿼리 없음).
// - 찾음: 2.f.<pageId>.<ids>  — ids 는 '-'로 이은 그룹 번호(지금 상품 포함, 겹침 없음, 1~51개).
// - 확인 못 함: 2.r.<pageId>.<diag> — diag 는 정해진 칸만 담은 JSON 을 base64url(무패딩)로, 2000자 이하.
// 받는 쪽(admin.html·client.html)과 서버(options-diag)가 같은 정규식·칸 규칙으로 다시 검사하고 다시 만든다.
export const OPTION_FILL_FOUND_PATTERN = /^2\.f\.([0-9]{5,20})\.([0-9]{5,20}(?:-[0-9]{5,20}){0,50})$/;
export const OPTION_FILL_REFUSED_PATTERN = /^2\.r\.([0-9]{5,20})\.([A-Za-z0-9_-]{1,2000})$/;
export const OPTION_FILL_HASH_MAX_CHARS = 2200;
export const OPTION_FILL_DIAG_MAX_CHARS = 2000;
export const OPTION_FILL_DIAG_COUNTS_MAX = 8;
export const OPTION_FILL_DIAG_KEYS_MAX = 20;
export const OPTION_FILL_DIAG_COUNT_KEY = /^[A-Za-z]{1,24}$/;
export const OPTION_FILL_DIAG_COUNT_VALUE_MAX = 10_000_000;
export const OPTION_FILL_DIAG_KEY_RULE = /^[A-Za-z0-9_#.-]{1,40}$/;
const DIAG_KEY_MAX_CHARS = 40;
// NUMBER_RUN 은 g 깃발이라 test() 에 쓰면 lastIndex 가 남는다. 있는지 볼 때는 이것을 쓴다.
const HAS_NUMBER_RUN = new RegExp(`[0-9]{${OPTION_PRODUCT_ID_MIN_DIGITS},}`);
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// 찾음 값. 규칙(지금 상품 포함·겹침 없음·자리 수·개수)에 하나라도 어긋나면 빈 글자(화면은 '확인 못 함'으로 간다).
export function optionFillFoundPayload(pageId, ids) {
  const list = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
  if (!isServerProductId(pageId) || !list.length || list.length > OPTION_PRODUCT_IDS_MAX + 1) return "";
  if (!list.every(isServerProductId) || !list.includes(pageId) || new Set(list).size !== list.length) return "";
  const payload = `2.f.${pageId}.${list.join("-")}`;
  return OPTION_FILL_FOUND_PATTERN.test(payload) ? payload : "";
}

// 확인 못 함 값. diag 는 optionFillDiag 가 만든 객체.
export function optionFillRefusedPayload(pageId, diag, { maxChars = OPTION_FILL_DIAG_MAX_CHARS } = {}) {
  if (!isServerProductId(pageId)) return "";
  const encoded = encodeOptionFillDiag(diag, { maxChars });
  if (!encoded) return "";
  const payload = `2.r.${pageId}.${encoded}`;
  return OPTION_FILL_REFUSED_PATTERN.test(payload) ? payload : "";
}

// ASCII 글자만 base64url(무패딩)로 바꾼다. 진단 JSON 은 칸 규칙상 ASCII 뿐이다(아니면 던짐).
export function base64UrlAscii(text) {
  const value = String(text);
  const codes = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) throw new Error("진단에 ASCII 가 아닌 글자가 있습니다");
    codes.push(code);
  }
  let out = "";
  for (let index = 0; index < codes.length; index += 3) {
    const size = Math.min(3, codes.length - index);
    const chunk = (codes[index] << 16) | ((size > 1 ? codes[index + 1] : 0) << 8) | (size > 2 ? codes[index + 2] : 0);
    out += BASE64_URL_ALPHABET.charAt((chunk >> 18) & 63) + BASE64_URL_ALPHABET.charAt((chunk >> 12) & 63);
    if (size > 1) out += BASE64_URL_ALPHABET.charAt((chunk >> 6) & 63);
    if (size > 2) out += BASE64_URL_ALPHABET.charAt(chunk & 63);
  }
  return out;
}

// 진단 키 하나를 칸 규칙(영숫자·_#.- 40자 이하)에 맞춘다. 경로의 '[]'·'?'·'$' 같은 글자는 '_' 로, 5자리 이상 숫자는 다시 '#n' 으로
// (판정 진단이 이미 가렸지만 한 번 더). 길면 끝 쪽(잎 키)을 남긴다.
function optionFillDiagKey(text) {
  let key = String(text).replace(/[^A-Za-z0-9_#.-]+/g, "_").replace(NUMBER_RUN, NUMBER_KEY_MASK);
  if (key.length > DIAG_KEY_MAX_CHARS) key = `_${key.slice(key.length - DIAG_KEY_MAX_CHARS + 1)}`;
  return OPTION_FILL_DIAG_KEY_RULE.test(key) ? key : "";
}

function optionFillDiagCount(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, OPTION_FILL_DIAG_COUNT_VALUE_MAX);
}

// 인사이트로 넘기는 진단: { v, reason, counts(영문 키 정수 8개 이하), keys(경로 20개 이하) }. 이름·글자 값·상품번호는 담지 않는다.
// result: findGroupOptions 결과(실행 오류면 null). sources: 패널이 센 데이터 묶음 수. runtimeError: 실행 중 오류가 났음.
export function optionFillDiag(result, { sources = null, runtimeError = false } = {}) {
  const reasons = result && Array.isArray(result.reasons) ? result.reasons.filter((reason) => reason && REASON_CODES.includes(reason.code)) : [];
  let reason = reasons.length ? reasons[0].code : "not_found";
  if (runtimeError) reason = "source_unreadable";
  const diag = result && result.diag ? result.diag : {};
  const cut = diag.cut || {};
  const chosen = diag.chosen || null;
  const counted = [
    ["runtimeError", runtimeError ? 1 : null],
    ["nodes", diag.nodes],
    ["jsonScripts", sources ? sources.jsonScripts : null],
    ["unreadable", result && result.diag ? (diag.unreadableSources || 0) + (diag.readErrors || 0) : null],
    ["capped", result && result.diag ? Number(Boolean(cut.nodes)) + (cut.depth || 0) + (cut.arrays || 0) + (cut.lists || 0) : null],
    ["reasonCount", reasons.length ? reasons[0].count : null],
    ["chosenCount", result && result.diag ? (chosen ? chosen.count : 0) : null],
    ["splitPieces", chosen ? chosen.split.length : null],
    ["groupLists", diag.groupListsWithoutCurrent],
  ];
  const counts = {};
  for (const [key, value] of counted) {
    const count = optionFillDiagCount(value);
    if (count === null || !OPTION_FILL_DIAG_COUNT_KEY.test(key)) continue;
    if (Object.keys(counts).length >= OPTION_FILL_DIAG_COUNTS_MAX) break;
    counts[key] = count;
  }
  const keys = [];
  const addKey = (text) => {
    const key = optionFillDiagKey(text);
    if (key && !keys.includes(key) && keys.length < OPTION_FILL_DIAG_KEYS_MAX) keys.push(key);
  };
  for (const other of reasons.slice(1)) addKey(`reason.${other.code}`);
  if (chosen) {
    addKey(chosen.path);
    for (const idKey of chosen.idKeys || []) addKey(`idKey.${idKey === VALUE_ITEM_KEY ? "value" : idKey}`);
    for (const piece of [...(chosen.split || []), ...(chosen.parallel || [])]) addKey(piece.path);
  }
  for (const list of diag.pairLists || []) addKey(list.path);
  for (const list of diag.candidates || []) addKey(list.path);
  for (const entry of diag.groupKeys || []) addKey(entry.path);
  return { v: OPTION_CHECK_VERSION, reason, counts, keys };
}

// 진단 객체 → base64url. 칸 규칙 밖 값은 버리고 다시 만든 뒤, maxChars 를 넘으면 keys 를 뒤에서부터 줄인다.
export function encodeOptionFillDiag(diag, { maxChars = OPTION_FILL_DIAG_MAX_CHARS } = {}) {
  const source = diag && typeof diag === "object" ? diag : {};
  const reason = REASON_CODES.includes(source.reason) ? source.reason : "not_found";
  const counts = {};
  for (const [key, value] of Object.entries(source.counts && typeof source.counts === "object" ? source.counts : {})) {
    const count = typeof value === "boolean" ? null : optionFillDiagCount(value);
    if (count === null || !OPTION_FILL_DIAG_COUNT_KEY.test(key)) continue;
    if (Object.keys(counts).length >= OPTION_FILL_DIAG_COUNTS_MAX) break;
    counts[key] = count;
  }
  const keys = (Array.isArray(source.keys) ? source.keys : [])
    .filter((key) => typeof key === "string" && OPTION_FILL_DIAG_KEY_RULE.test(key) && !HAS_NUMBER_RUN.test(key))
    .slice(0, OPTION_FILL_DIAG_KEYS_MAX);
  for (let size = keys.length; size >= 0; size -= 1) {
    const encoded = base64UrlAscii(JSON.stringify({ v: OPTION_CHECK_VERSION, reason, counts, keys: keys.slice(0, size) }));
    if (encoded.length <= maxChars) return encoded;
  }
  return "";
}
