import { createHandler } from "../_shared.mjs";

// 광고주 대시보드 공개 수치. api/[...path] 캐치올은 프로덕션에서 /api/client/* 같은
// 중첩 경로를 받지 않아(플랫폼 NOT_FOUND) 전용 함수 파일로 연다. 세션 판정·
// 대상 광고주 결정은 그대로 src/server/index.mjs → client-api.mjs 가 한다.
export default createHandler("/api/client/public-state");
