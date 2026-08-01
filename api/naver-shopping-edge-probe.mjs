const PROBE_KEY_SHA256 = "aacc13b5929f5fc3d72838caade3128dc04e36af5f152ea25958a85cb06ae190";
const TARGET_URL = "https://search.shopping.naver.com/search/all?query=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0&origQuery=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0&pagingIndex=1&pagingSize=40&productSet=total&sort=rel&viewType=list";

export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  const provided = request.headers.get("x-mi-probe-key") || "";
  if (await sha256(provided) !== PROBE_KEY_SHA256) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(TARGET_URL, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      },
    });
    const body = (await response.text()).slice(0, 2_000_000);
    const blocked = response.status === 418
      || /(?:접근이\s*제한|비정상적인\s*접근|captcha|자동입력\s*방지)/iu.test(body);
    return json({
      ok: response.status === 200 && !blocked,
      upstreamStatus: response.status,
      blocked,
      contentType: String(response.headers.get("content-type") || "").split(";")[0],
      contentLength: body.length,
      hasNextData: /__NEXT_DATA__/u.test(body),
      hasShoppingState: /shopping|productList|nvMid/u.test(body),
      redirectLocationPresent: Boolean(response.headers.get("location")),
    });
  } catch (error) {
    return json({
      ok: false,
      code: error?.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILED",
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
