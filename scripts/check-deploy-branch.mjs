// 프로덕션 배포가 main 이 아닌 브랜치에서 나가는 것을 차단한다.
//
// 배경: 프로덕션 빌드는 Vercel 이 주입하는 VERCEL_GIT_COMMIT_REF 로 자기 소스를
// 밝히지만, 이 저장소는 그 값을 어디에서도 읽지 않았다. 그래서 브랜치 배포가
// 프로덕션 별칭을 가져가도 게이트 어느 단계도 눈치채지 못했다.
//
// 판정은 배포 환경이 실제로 주입한 값만 본다. .env 파일을 읽지 않는다 —
// 로컬 .vercel/.env.production.local 에 남아 있는 과거 배포의 VERCEL_GIT_COMMIT_REF
// 를 읽으면 로컬 실행이 그 값으로 오판한다.
//
// VERCEL_GIT_COMMIT_REF 가 비어 있으면(로컬 실행·Git 연동 없는 CLI 배포) 판정하지
// 않는다. 그 경로는 이 게이트가 아니라 별도 항목이 다룬다.

const PRODUCTION_BRANCH = "main";

const vercelEnv = String(process.env.VERCEL_ENV || "").trim();
const commitRef = String(process.env.VERCEL_GIT_COMMIT_REF || "").trim();
const checkedAt = new Date().toISOString();

if (vercelEnv === "production" && commitRef && commitRef !== PRODUCTION_BRANCH) {
  console.error(JSON.stringify({
    ok: false,
    code: "DEPLOY_BRANCH_NOT_PRODUCTION",
    vercelEnv,
    commitRef,
    expectedBranch: PRODUCTION_BRANCH,
    checkedAt,
  }, null, 2));
  console.error(`프로덕션 배포가 차단되었습니다: 이 빌드의 브랜치는 "${commitRef}" 이고 프로덕션은 "${PRODUCTION_BRANCH}" 에서만 나갈 수 있습니다.`);
  console.error("브랜치 작업을 main 에 병합한 뒤 다시 배포하세요. 프리뷰 배포는 이 게이트에 걸리지 않습니다.");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  code: "DEPLOY_BRANCH_OK",
  vercelEnv: vercelEnv || "local",
  commitRef: commitRef || "unset",
  expectedBranch: PRODUCTION_BRANCH,
  enforced: vercelEnv === "production" && Boolean(commitRef),
  checkedAt,
}, null, 2));
