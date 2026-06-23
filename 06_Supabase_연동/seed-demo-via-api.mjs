import fs from "node:fs";
import path from "node:path";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const index = trimmed.indexOf("=");
      if (index === -1) return acc;
      acc[trimmed.slice(0, index)] = trimmed.slice(index + 1);
      return acc;
    }, {});
}

const env = {
  ...loadEnv(path.join(process.cwd(), "06_Supabase_연동", ".env.local")),
  ...process.env
};

const supabaseUrl = env.SUPABASE_URL;
const secretKey = env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !secretKey) {
  console.error(JSON.stringify({
    ok: false,
    message: "SUPABASE_URL and SUPABASE_SECRET_KEY are required"
  }, null, 2));
  process.exit(1);
}

const baseUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/moment-api`;

async function request(method, resource, body) {
  const response = await fetch(`${baseUrl}/api/admin/${resource}`, {
    method,
    headers: {
      "content-type": "application/json",
      apikey: secretKey
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { message: await response.text() };
  }

  if (!response.ok) {
    throw new Error(`${method} ${resource} failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function ensure(resource, id, body) {
  try {
    return await request("POST", resource, body);
  } catch (error) {
    const message = String(error.message || "");
    if (!message.includes("duplicate key") && !message.includes("23505")) throw error;
    return request("PATCH", `${resource}/${id}`, body);
  }
}

const clientId = "11111111-1111-4111-8111-111111111111";
const brandId = "22222222-2222-4222-8222-222222222222";
const month = new Date();
month.setUTCDate(1);
const period = month.toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const startsAtDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
const endsAtDate = new Date(startsAtDate.getTime() + 1000 * 60 * 60 * 2);
const startsAt = startsAtDate.toISOString();
const endsAt = endsAtDate.toISOString();

await ensure("clients", clientId, {
  id: clientId,
  name: "비타민 앰플 데모",
  business_name: "모먼트 인사이트 데모 광고주",
  agency_code: "MI-DEMO-01",
  status: "active",
  public_summary: "이번 달 핵심 지표와 실행 일정을 확인할 수 있는 데모 광고주입니다.",
  internal_note: "내부 테스트용 샘플 광고주입니다."
});

await ensure("brands", brandId, {
  id: brandId,
  client_id: clientId,
  name: "비타민 앰플",
  category: "뷰티/스킨케어",
  main_marketplace: "naver",
  status: "active"
});

await request("POST", "dashboard-snapshots", {
  client_id: clientId,
  brand_id: brandId,
  period,
  sales: 18400000,
  ad_spend: 3200000,
  impressions: 420000,
  clicks: 16800,
  orders: 530,
  reviews: 74,
  conversion_rate: 3.15,
  click_rate: 4.0,
  achievement_rate: 82.5,
  public_comment: "매출과 ROAS 흐름은 양호하며, 검색 키워드 보강이 다음 우선순위입니다.",
  internal_note: "네이버 검색광고 예산 증액 전 키워드 효율을 한 번 더 확인합니다."
}).catch((error) => {
  if (!String(error.message).includes("duplicate key")) throw error;
});

await request("POST", "reports", {
  client_id: clientId,
  brand_id: brandId,
  report_type: "weekly",
  title: "6월 4주차 주간 보고서",
  report_date: today,
  period_start: today,
  period_end: today,
  summary: "검색 유입과 구매 전환이 함께 상승했습니다.",
  public_comment: "다음 주에는 고효율 키워드 중심으로 예산을 재배치합니다.",
  internal_note: "광고주에게는 예산 증액 표현보다 효율 개선 중심으로 안내합니다.",
  visibility: "client_visible"
});

await request("POST", "schedule-items", {
  client_id: clientId,
  brand_id: brandId,
  title: "네이버 검색광고 키워드 재정리",
  schedule_type: "keyword",
  status: "planned",
  starts_at: startsAt,
  ends_at: endsAt,
  public_comment: "검색량이 높은 키워드 위주로 광고 그룹을 정리할 예정입니다.",
  internal_note: "작업 전 키워드 제외 목록 확인 필요.",
  visibility: "client_visible"
});

await request("POST", "action-plans", {
  client_id: clientId,
  brand_id: brandId,
  period_week: today,
  title: "검색 상위 키워드 중심 예산 재배치",
  category: "keyword",
  priority: "high",
  status: "planned",
  description: "전환 기여도가 높은 네이버 검색 키워드에 예산을 우선 배치합니다.",
  expected_impact: "ROAS 유지와 구매 수량 증가를 기대합니다.",
  client_request: "프로모션 가능 기간을 확인해주세요.",
  internal_note: "광고비 증액안은 내부 승인 후 공개.",
  is_client_visible: true
});

await request("POST", "keywords", {
  client_id: clientId,
  brand_id: brandId,
  keyword: "비타민 앰플",
  priority: "high",
  target_channel: "naver",
  is_active: true,
  internal_note: "대표 키워드 데모 데이터"
}).catch((error) => {
  if (!String(error.message).includes("duplicate key")) throw error;
});

const overview = await request("GET", `overview?client_id=${clientId}`);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  demo: {
    clientId,
    brandId,
    agencyCode: "MI-DEMO-01"
  },
  overview: overview.data
}, null, 2));
