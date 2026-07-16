# 복구 체크포인트 운영

이 문서는 오류 발생 시 현재 작업 브랜치를 덮어쓰지 않고 정상 커밋을 검증·복구하는 절차입니다. `git reset --hard`와 기존 브랜치 강제 이동은 사용하지 않습니다.

## 체크포인트 만들기

작업트리가 clean이고 전체 품질 검사가 통과한 커밋에서만 생성합니다.

```bash
npm run check:quality
npm run recovery:checkpoint -- --name checkpoint/production-YYYYMMDD-HHMM --ref HEAD
```

스크립트는 dirty worktree를 거부하고, 필수 화면·서버·패키지 파일과 lockfile 일치 여부를 확인한 뒤 annotated Git tag를 만듭니다. 운영 배포 체크포인트만 원격에 보관합니다.

```bash
git push origin checkpoint/production-YYYYMMDD-HHMM
```

미승인 개발 기능이 포함된 로컬 체크포인트는 원격 `main`이나 운영 태그로 push하지 않습니다.

## 체크포인트 검증

```bash
npm run recovery:verify -- --name checkpoint/production-YYYYMMDD-HHMM
npm run recovery:verify -- --name checkpoint/production-YYYYMMDD-HHMM --quality
```

첫 명령은 태그·Git 객체·필수 파일·lockfile을 확인합니다. `--quality`는 전체 회귀 검사와 Vercel 정적 빌드까지 추가 실행합니다.

## 비파괴 복구

현재 작업 폴더를 변경하지 않고 별도 worktree에서 먼저 확인합니다.

```bash
git fetch --tags origin
git worktree add --detach /tmp/moment-insight-recovery checkpoint/production-YYYYMMDD-HHMM
cd /tmp/moment-insight-recovery
npm ci
npm run check:quality
```

검증된 상태에서 수정이 필요하면 detached worktree 안에서 새 복구 브랜치를 만듭니다.

```bash
git switch -c recovery/YYYYMMDD-HHMM
```

운영 복구 여부는 이 브랜치의 diff와 전체 검증 결과를 확인한 뒤 별도 승인으로 결정합니다. 기존 `main`과 미커밋 작업은 그대로 보존합니다.
