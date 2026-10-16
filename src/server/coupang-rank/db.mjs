// C 30일 순위 DB 공용 도우미(명세 §5.1, WP0). 화면 API(WP2)·수집기 API(WP3)가 import 만 한다.
// 이 모듈은 다른 서버 모듈을 import 하지 않는다. ctx 는 withSupabase 가 넘기는 값이며 ctx.supabaseAdmin 만 쓴다.

// 표·함수가 아직 없을 때 Postgres·PostgREST 가 돌려주는 코드(§3.4 COUPANG_SETUP_REQUIRED).
// 42P01 표 없음, PGRST205 스키마 캐시에 표 없음, PGRST202 스키마 캐시에 함수 없음, 42883 함수 없음.
const SETUP_MISSING_CODES = new Set(["42P01", "PGRST205", "PGRST202", "42883"]);

const SETTINGS_TABLE = "coupang_rank_settings";

// 마이그레이션 전(표·함수 없음)인지 판정한다. 코드만 본다. DB 문구는 응답에 쓰지 않는다.
export function isSetupMissing(error) {
  if (!error || typeof error !== "object") return false;
  return SETUP_MISSING_CODES.has(String(error.code || ""));
}

// 설정 1행(id = 1)을 읽는다.
// - 성공: { setupRequired: false, settings: <행 그대로(snake_case)> }
// - 표가 없거나 설정 행이 없음: { setupRequired: true, settings: null }
//   (행 없음은 마이그레이션이 덜 된 것으로 보고 '설정 필요'로 닫는다. 기본값으로 채워 수집을 열지 않는다)
// - 그 밖의 DB 오류: Error 를 던진다. code 는 DB 코드, stage 는 "settings". DB 문구는 message 에 넣지 않는다.
export async function loadSettings(ctx) {
  const { data, error } = await ctx.supabaseAdmin
    .from(SETTINGS_TABLE)
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    if (isSetupMissing(error)) return { setupRequired: true, settings: null };
    throw dbFailure("settings", error);
  }
  if (!data || typeof data !== "object") return { setupRequired: true, settings: null };
  return { setupRequired: false, settings: data };
}

// 1000행씩 페이지를 넘겨 모두 읽는다(PostgREST 기본 상한 1000행 때문).
// makeQuery() 는 부를 때마다 새 쿼리 빌더를 돌려줘야 한다(빌더는 한 번만 실행된다).
// 이 함수가 빌더에 .range(from, to) 를 붙인다. 순서가 고정되도록 makeQuery 안에서 .order(...) 를 걸어 둘 것.
// 반환: { data: 행 배열 | null, error: DB 오류 | null, complete: boolean }
// - 덜 찬 페이지를 만나면 끝(complete: true).
// - maxPages 번째 페이지까지 꽉 찼으면 거기서 멈추고 complete: false(읽은 만큼은 data 에 담는다).
// - 한 페이지라도 오류면 그때까지 읽은 행은 버리고 { data: null, error, complete: false }.
export async function selectPages(makeQuery, { pageSize = 1000, maxPages = 64 } = {}) {
  const size = positiveInteger(pageSize, "pageSize");
  const pages = positiveInteger(maxPages, "maxPages");
  const rows = [];
  for (let page = 0; page < pages; page += 1) {
    const from = page * size;
    const { data, error } = await makeQuery().range(from, from + size - 1);
    if (error) return { data: null, error, complete: false };
    if (!Array.isArray(data)) {
      return { data: null, error: { code: "", message: "page_not_array" }, complete: false };
    }
    for (const row of data) rows.push(row);
    if (data.length < size) return { data: rows, error: null, complete: true };
  }
  return { data: rows, error: null, complete: false };
}

// PostgREST in 목록 값 "(…)" 을 만든다. 사람이 쓴 글자(키워드 등)는 .in() 대신 .filter(열, "in", inList(값들)) 로 넘긴다.
// postgrest-js .in() 은 , ( ) 가 있을 때 "…" 로 감싸기만 하고 안의 " \ 는 이스케이프하지 않는다(2.108.2 실측). 그러면
// PostgREST 가 값을 잘못 나누고 ')' 뒤를 오류 없이 버린다(2026-10-16 통합 검수: 인치 표시 " 가 든 키워드).
// 그래서 모든 값을 늘 따옴표로 감싸고 \ → \\, " → \" 로 바꾼다(PostgREST 따옴표 값: 따옴표 안의 \x 는 x).
// 빈 목록은 받지 않는다(부르는 쪽이 먼저 건너뛴다).
export function inList(values) {
  const items = [...new Set(Array.from(values || [], (value) => String(value)))];
  if (!items.length) throw new RangeError("inList needs at least one value");
  return `(${items.map((value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`).join(",")})`;
}

// 배열을 size 개씩 자른다. 빈 배열은 [] 를 돌려준다.
export function chunk(list, size) {
  const step = positiveInteger(size, "size");
  const items = Array.from(list || []);
  const out = [];
  for (let index = 0; index < items.length; index += step) out.push(items.slice(index, index + step));
  return out;
}

// 동시에 최대 limit 개씩 fn(item, index) 를 돌리고, 결과를 입력 순서대로 돌려준다.
// 하나라도 실패하면 새 작업은 더 시작하지 않고, 처음 실패한 오류로 reject 한다(Promise.all 과 같은 뜻).
export async function mapLimit(list, limit, fn) {
  const items = Array.from(list || []);
  const width = Math.min(positiveInteger(limit, "limit"), Math.max(items.length, 1));
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = [];
  for (let count = 0; count < width; count += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function dbFailure(stage, error) {
  const failure = new Error(`coupang_rank_${stage}_failed`);
  failure.code = String(error?.code || "");
  failure.stage = stage;
  failure.cause = error;
  return failure;
}
