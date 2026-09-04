import { createHandler } from "../_shared.mjs";

// Vercel 프로덕션에서 api/[...path] 캐치올은 /api/<한 단계> 경로만 받는다(중첩 경로는
// 플랫폼 NOT_FOUND). /api/my/* 와 같은 이유로 시장 홈 피드도 전용 함수 파일로 연다.
// 세션 게이트·라우팅은 그대로 src/server/index.mjs 가 처리한다.
export default createHandler("/api/client/home-feed");
