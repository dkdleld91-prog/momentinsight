// 체험 계정 구분값(점검 2026-11-02 F72). 예전에는 구글 식별자(sub) 원문 앞 8자를 그대로 써서, 앞자리가 같은 두 체험 사용자가
// 조사 노트(agency_code)를 서로 보고 지울 수 있었다(구글 식별자는 앞자리가 '10'·'11' 로 몰린다). 이제 전체 식별자의
// SHA-256 앞 16자(64비트)를 쓴다. 비밀값이 아니라 계정마다 겹치지 않게 나누는 값이다.
import { createHash } from "node:crypto";

function cleanSub(googleSub) {
  return String(googleSub ?? "").trim().toLowerCase();
}

export function trialAccountCode(googleSub) {
  const sub = cleanSub(googleSub);
  return sub ? `trial-${createHash("sha256").update(sub).digest("hex").slice(0, 16)}` : "";
}

// 2026-11-04 전 형식(앞 8자). 그때 저장됐을 수 있는 조사 노트를 알아보는 데만 쓴다(새로 만들지 않는다).
export function legacyTrialAccountCode(googleSub) {
  const sub = cleanSub(googleSub);
  return sub ? `trial-${sub.slice(0, 8)}` : "";
}

// 체험 구분값의 모양: 새 형식(16자 16진수) 또는 옛 형식(구글 식별자 숫자 앞 8자). 사람이 정한 코드('trial-team01' 등)는 맞지 않는다.
export const TRIAL_ACCOUNT_CODE_PATTERN = /^trial-(?:[0-9a-f]{16}|[0-9]{8})$/;
