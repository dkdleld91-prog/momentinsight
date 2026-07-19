console.error(JSON.stringify({
  ok: false,
  code: "LEGACY_EDGE_DEPLOY_DISABLED",
  message: "이 명령은 구형 Supabase Edge 백엔드와 데이터베이스 변경을 함께 실행할 수 있어 영구 차단되었습니다.",
  canonicalBackend: "Vercel API",
  nextStep: "운영 서버 배포는 검증된 Vercel 배포 경로를 사용하고, 데이터베이스 변경은 별도 승인과 검증을 거쳐 실행하세요.",
}, null, 2));

process.exit(1);
