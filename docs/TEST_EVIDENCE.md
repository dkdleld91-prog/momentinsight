# Test Evidence

## 2026-08-24 N쇼핑 atomic success·candidate 제어 강화 (Production·DB·첫 자연 회차 반영)

- 추가 감사에서 성공 RPC가 scalar 인자만으로 `success_streak`를 증가시키고 candidate 서버가 `accepted/activated`만 확인하던 경계를 확인했습니다. 신규 additive migration은 현재 live lease/run/job identity와 동일 `claim_id`의 group→tracker claim→tracker commit→snapshot 전 체인을 묶고, 모든 member가 checked300·official collector·organic-only·adExcluded 증거를 가진 경우에만 성공을 기록합니다. candidate API는 raw 응답이 exact `accepted=true/activated=true/mode=candidate/minutes=8`일 때만 200으로 인정합니다.
- 첫 SQL 모델은 같은 `run_id`의 모든 group을 한 성공으로 묶어 두 번째 group을 거부하는 P0가 RED로 발견됐습니다. 대표 `tracker_committed`에서 `claim_id`·`group_fingerprint`를 도출해 group별로 제한했고, 동일 run의 A·B group이 각각 1회 성공하는 회귀를 추가했습니다. 이어 단일 `last_collection_id`만으로 A→B→A 지연 재전송을 막지 못하는 P1도 RED로 고정한 뒤, `current_job_kind=tracker`·`current_tracker_id=p_tracker_id`가 아니면 fail-closed하도록 보완했습니다. 즉시 B→B 재시도는 streak 불변 idempotent 응답입니다.
- 최종 집중 검증은 durable/local-worker/ledger 107/107, rank handler 71/71, server contract 70/70, release baseline `ok=true`, 보호 lock 23함수·100파일·49 migration과 self-test, `git diff --check`가 통과했습니다. P1 보완 뒤 전체 `npm run check:release`도 core1025/1025·place51/51·shopping64/64·Production auth18/18, public build10파일·inline6·CSP hash4로 exit0입니다. commit `8d99566e4565` push 뒤 Production health/ready도 같은 release·Supabase ready로 확인했습니다.
- migration 직전 `2026-08-24T14:16:03Z` SELECT-only 값은 exact runtime/fingerprint, heartbeat 정상, anchor `05:31:17.200373Z`, streak62, baseline10·candidate false, circuit closed·reason/cooldown null, tracker/lookup processing0·lane/run/lease/stage/job/tracker/probe null인 완전 idle이었습니다. 이 상태에서 `20260824141622_naver_shopping_atomic_success_proof_hardening`을 transactional 적용해 운영 PostgreSQL compile을 확인했고 anchor/streak/last-good은 변하지 않았습니다.
- `pg_get_functiondef` 기준 success/candidate 함수 모두 SECURITY INVOKER·빈 search_path·service-role-only입니다. 각각 coordination `FOR UPDATE` 위치1351/631 뒤에 `v_now := clock_timestamp()` 위치1365/645가 있어 잠금 뒤 freshness 표본 순서를 확인했습니다. success 함수의 current job/tracker·claim-scoped commit guard와 candidate 함수의 exact1.1.12/fingerprint도 실제 정의에서 true입니다. 적용 후 advisor는 security16=INFO14/WARN2, performance63=INFO40/WARN23이고 대상 함수 항목0·WARN 증가0입니다.
- 배포 후 첫 자연 claim `f2f642ba-3bc3-4ae2-8304-7c2b876ef39a`는 event9868→9869→9870, run `bbe06f33-5ab5-4d7b-8584-5d8b5289d783`로 group/tracker/commit 각1·failure0·동일 worker/fingerprint입니다. collection `pw-chrome-1787581100624-48e9eb37cbce49e8049c` snapshot1은 checked300·official source·collection 일치·organic target/policy/evidence·adExcluded 모두1, excludedAdCount30·topItems5·위반0·rank33입니다. success streak는 62→63으로 1회만 증가했습니다.
- terminal 뒤 `2026-08-24T14:19:38Z` exact identity·heartbeat6.49초·anchor 불변·baseline10·candidate false, closed/null, tracker/lookup processing0, lane worker/token/lease/run/stage/job/tracker/probe null·page0입니다. cycle36 group29=distinct claim29·fingerprint 중복0, tracker42=distinct42·중복0이고 active76·paused0·quarantine3입니다. candidate8 RPC는 anchor+24시간 전이라 0회입니다.
- event9872→9874의 두 번째 post-migration run `063af0d5-b542-4476-a0ea-837684072bd4`도 group/tracker/commit 각1·failure0입니다. collection `pw-chrome-1787581438278-412a5f97707022515ca5` snapshot1은 checked300·official source·collection 일치·organic target/policy/evidence·adExcluded 모두1, excluded30·top5 위반0·rank8이며 streak63→64 정확히1회입니다. `14:24:56Z` cycle36은 group30=distinct30·fingerprint duplicate0, tracker43=distinct43·duplicate0, commit43·failure0이고 circuit closed·processing/lane/run/lease null입니다. wake row `rank-cron-cycle`가 claim 6.436초 전 요청·소비되고 0.775초 전 updated돼 remote-wake handoff의 강한 증거지만 ledger trigger가 없어 확정하지 않으며 candidate8 scheduled 표본에서 제외합니다.
- event9877→9881 정시-compatible grouped run은 claim1·tracker2·commit2·failure0이며 앞 정시 event9868과 600.211초 간격입니다. collection `pw-chrome-1787581746657-9bbf7a0f007c09cadc2e` snapshot2/2는 tracker distinct2·checked300·official·collection match·organic target/policy/evidence·adExcluded 모두2, excluded30·top-item 위반0·ranks1/22입니다. streak64→65는 group당 정확히1회이고 cursor는 동일 sort1200의 `(2026-06-26T14:51:22.956194Z,8991…)→(2026-07-10T06:04:35.817547Z,037b…)` strict forward입니다. `14:29:42Z` cycle group31=distinct31·fingerprint duplicate0, tracker45=distinct45·duplicate0·commit45·failure0이고 processing/lane/run/lease/stage/job/tracker/probe null·closed/null·baseline10·candidate false입니다.
- cycle36 event9639 roster는 active76·eligible73·quarantined3이고 ledger `cycle_rostered` 76 tracker/60 distinct fingerprint group입니다. claim31 뒤 잔여는 29 group/31 tracker, current eligible26·ineligible3입니다. 대상 `1114…`·`12f5…`는 event9676·9674에서 각각 sort600/100·quarantined로 roster됐고 현재 cycle claim/terminal0, 만료는 `15:33:02.119249Z`·`19:18:58.276397Z`입니다. 세 번째 ineligible은 이미 자연 typed failure를 확인한 `c0cc…` 94/300이며 `2026-08-25T07:29:00.724542Z`까지 재격리됐습니다. cycle selector의 실제 SQL은 미래 격리를 기다리지 않고 현재 eligible 미claim seed만 cursor 뒤→전체 fallback 순으로 고르므로, 두 대상의 회복 시각은 projection으로 확정하지 않고 실제 ledger terminal만 판정합니다.
- event9883→9885 정시-compatible run은 앞 정시 event9877과 `599.934초` 간격이고 group/tracker/commit 각1·failure0입니다. collection `pw-chrome-1787582304839-fb6f9d1e0cf8bd5678a7` snapshot1은 checked300·official·collection match·organic target/policy/evidence·adExcluded 모두1, excluded45·top-item 위반0·rank8입니다. streak65→66, cursor sort1200→1300이고 cycle group32=distinct32·group duplicate0, tracker46=distinct46·tracker duplicate0·commit46·failure0입니다. terminal 뒤 processing0·closed/null·lane/run/lease/stage/job/tracker/probe null·baseline10·candidate false입니다.
- migration 이후 전체 집계의 첫 진단 SQL은 grouped tracker claim2×commit2를 일반 join해 4로 부풀리는 집계 오류가 있어 즉시 폐기했습니다. corrected correlated-subquery 집계는 group4·distinct claim/run/fingerprint4, tracker claim5·commit5·snapshot5, complete group4/4·incomplete0·failure0·proof 위반0입니다. grouped claim은 정확히 tracker2/commit2/collection1이고 streak delta `66-62=4`가 group4와 일치합니다. 개별 terminal duration은 41.688·85.165·87.510·45.758초이며 진단 join 오류를 운영 중복으로 해석하지 않습니다.
- activation 경로 재감사는 Production handler의 owner/primary-agency 검증 뒤 `supabaseAdmin.rpc('mi_set_naver_shopping_worker_cadence',{p_mode:'candidate'})` 호출과 exact accepted/activated/mode=candidate/minutes=8 검증을 확인했습니다. automation은 사용자 세션을 발명하지 않고 동일 canonical DB 함수의 service-controlled SELECT를 딱1회 호출하며, 외부 requestStart/responseEnd와 raw 함수 JSON을 캡처한 뒤 즉시 read-only operations SELECT를 수행합니다. timeout·network·raw 결과 불완전은 committed-unknown으로 분류해 재호출하지 않고 DB 관측 상태도 raw 성공 응답을 대체하는 성공 증거로 쓰지 않습니다.
- event9887→9889 정시-compatible run은 직전 정시 event9883과 `600.398초` 간격이고 group/tracker/commit 각1·failure0입니다. snapshot1은 collection `pw-chrome-1787582901664-75995b9ab8099b08287c`·checked300·official source·collection match·matched=false·organic policy/evidence·adExcluded·excluded30·top-item 위반0입니다. streak66→67, cursor sort1300→1400, cycle group33=distinct33·duplicate0, tracker47=distinct47·duplicate0·commit47·failure0이며 terminal 뒤 processing/lane/run/lease/stage/job/tracker/probe null·closed/null·baseline10·candidate false입니다.
- `14:51:17.501Z` 운영 함수 원문은 runtime1.1.12/fingerprint exact, primary heartbeat `14:50:31.719Z`, success streak67, last success `14:48:22.329Z`, last collection `pw-chrome-1787582901664-75995b9ab8099b08287c`·checked300·official, baseline10, closed/null, processing_count0, lane/run/stage/job/tracker/probe null, candidate_eligible=false입니다. 동일 시각 수동 predicate의 exact identity/fresh heartbeat/recent success/atomic proof/streak6/closed/cooldown null/processing0/완전 idle은 모두 true이고 anchor24h만 false(age9.333419812h)라 DB 판정과 일치합니다. 이 SELECT는 setter를 호출하지 않았습니다.
- event9891→9893 정시-compatible run은 직전 event9887과 `599.352초` 간격이고 group/tracker/commit 각1·failure0·claim/run/fingerprint distinct1입니다. snapshot `519d7041…`은 collection `pw-chrome-1787583499686-c8b7912765ae46eae36f`·checked300·official source/item source·collection 일치·matched=false·organic policy/evidence·adExcluded·excluded45·top5 위반0이며 claim→terminal `40.855초`입니다. streak67→68, cursor sort1400→1500 strict-forward, cycle36 group34=distinct34·duplicate0, tracker48=distinct48·duplicate0·commit48·failure0입니다. 잔여 roster26그룹/28트래커 중 collectable23·격리3이고 terminal 뒤 processing/lane/run/lease/stage/job/tracker/probe null·closed/null·baseline10입니다.
- `15:00:46.438Z` 독립 manual gate는 29개 predicate 중 anchor24h=false만 미충족입니다. anchor age09:29:29, heartbeat age14.493초, recent success age2분26초이며 exact runtime/fingerprint·recent official atomic300·streak68·closed/reason/cooldown null·processing0·완전 idle은 모두 true입니다. `candidate_eligible=false`, earliest `2026-08-25T05:31:17.200373Z`가 일치하고 setter 및 wake/cursor/order/quarantine/lease 변경은 0회입니다.
- 잔여 partial `1114f3af…`·`12f5330a…`는 각각 `2026-08-24T15:33:02.119249Z`·`19:18:58.276397Z` 자연 만료 전이며 processing null, legacy rank/check/found를 보존합니다. wake/cursor/order/quarantine/lease는 변경하지 않았고 candidate8은 anchor+24시간 전이라 호출0회입니다.

## 2026-08-24 N쇼핑 v1.1.12 partial-window cadence-proof 격리 체크포인트 (운영 DB·Windows·첫 자연 회차 반영)

- RED: strict tracker partial window에서 DB `cadenceProofPreserved` 승인과 Chrome `trackerPartialWindowFailures` 집계가 없어서 candidate proof가 초기화되는 실패를 고정했습니다. DB additive migration 부재 2건과 local/Chrome 보존 계약 실패를 실제 RED로 확인했습니다.
- GREEN targeted: `node --test scripts/naver-shopping-local-worker.test.mjs scripts/naver-shopping-native-host.test.mjs` 124/124 PASS, local-worker/rank handler 묶음 exit0, durable+transient migration 묶음 exit0(단독 isolation 14/14), server contract 68/68, release baseline `ok:true`, `git diff --check` PASS입니다. 전체 `npm run check:release`도 core1012/1012·place51/51·shopping64/64·Production auth18/18, public build10파일·inline6·CSP hash4로 exit0입니다. 보호 lock 23함수·99파일·48 migration, self-test 및 fresh `--print-current` exact-match도 PASS입니다. commit `d655eb080d55016349ea4bda38007e947971c4ca`와 Production release `d655eb080d55`까지 일치합니다.
- DB 보존 predicate는 exact `^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$`, tracker scope, runtime1.1.12/fingerprint `862b3779…e8e`, Windows primary heartbeat, closed circuit/no cooldown/probe, existing atomic300 proof를 요구합니다. 실제 quarantine update 1행과 같은 run의 `job_failed` event가 필요하며, grouped tracker는 대표 claim과 같은 `claim_id`·`group_fingerprint`·worker인 경우에만 후속 per-tracker 승인을 허용합니다. 함수는 SECURITY INVOKER·빈 search_path·service-role-only이고 cursor/wake/order/last-good DML은 없습니다.
- runtime1.1.12 migration은 1.1.11 계약에서 version만 바뀌며 적용 시 기존 anchor/streak를 fail-closed 초기화합니다. exact candidate gate는 새 fingerprint를 두 predicate에 고정하고 완전 idle·24시간·6회·최근15분 atomic success를 유지합니다. 운영 DB·Windows heartbeat는 exact1.1.12/fingerprint로 전환됐지만 candidate8은 비활성입니다.
- commit `d655eb080d55016349ea4bda38007e947971c4ca` push 뒤 Production `/health`·`/ready`는 release `d655eb080d55`, live·Supabase ready를 반환했습니다. 적용 직전 old runtime claim 2건의 tracker lease가 `2026-08-24T05:12:32.191Z`까지 남아 04:38:58Z SELECT-only `processing_count=2`였습니다. lane/run/stage/probe/cooldown은 null이고 circuit closed지만 완전 idle이 아니므로 migration·Windows update를 진행하지 않았으며, 강제 lease 해제도 하지 않았습니다.
- `2026-08-24T05:15:45.111Z` 자연 만료 뒤 processing0·lane/run/lease/stage/probe null·circuit closed/cooldown null을 확인하고 migration 3개를 순서대로 적용했습니다. 운영 migration version은 `20260824051736`·`20260824051739`·`20260824051741`이고, 대상 함수 4개 모두 SECURITY INVOKER·빈 search_path·ACL `{postgres=X/postgres,service_role=X/postgres}`·PUBLIC/anon/auth 실행 불가입니다. Security advisor16=INFO14/WARN2, performance64=INFO41/WARN23이며 기존 대비 WARN 증가는 0, 대상 함수 advisor 항목은 0입니다.
- Windows updater의 최종 합격 출력은 `MI_EXTENSION_UPDATE_OK`, exact release, version1.1.12, syntax13, loaded extension/native registry 동기화 true, runtime fingerprint `862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e`입니다. 설치경로 updater 부재와 process 실행정책 차단의 두 실패 출력은 성공에서 제외했습니다. exact commit updater SHA-256 `fbd11aad98c5b4c9567e171652187186dc266c5f5c4de0ac635c6c772c19345e`를 검증하고 process-local Bypass로 실행했으며 영구 실행정책은 변경하지 않았습니다.
- updater 예약작업 복구 뒤 수동 wake 없이 발생한 첫 정상 run `0ac338d3-905b-4326-aabc-c5655bf14402`는 event9487 group claim → 9488 tracker claim → 9489 tracker commit, collection `pw-chrome-1787549476269-b0a0995cb5ec84c118d4`입니다. snapshot은 checked300·source `naver_shopping_results_collector`·rankEvidence `naver_shopping_organic_list`·rankPolicy `organic_only`·adExcluded true·excludedAdCount45·rank64이며 capture/pass/collision digest 저장은 0입니다. event cursorBefore600·tracker sort700과 terminal cursor700이 일치합니다. ledger는 trigger명을 저장하지 않아 updater 직후 복구 시작과 정시 trigger는 구분하지 않습니다.
- cycle #35 누적 group24=distinct24=run24, tracker36=distinct36, commit34·failure0·deferred0이고 최신 run은 group/tracker/commit 각1·failure0입니다. terminal 상태는 active74·paused0·quarantine3·processing0, circuit closed·cooldown/lane/run/lease/stage/probe null입니다. updater 뒤 `worker_wakes.requested_at` 신규 행은 0이며 첫 anchor는 `2026-08-24T05:31:17.200373Z`, streak1·baseline10·candidate false입니다. 따라서 가장 이른 candidate 판정은 `2026-08-25T05:31:17.200373Z` 이후에도 새 성공6회와 모든 idle gate를 충족한 경우뿐입니다.
- run `13c47ff5-c080-4d3a-8afc-5081a0c70fec`은 event9491→9493, collection `pw-chrome-1787549943784-9856f3cb2f29096ce37a`로 checked300·official source·organic evidence/policy·adExcluded true·excludedAds30·stable-full-window·rank29를 commit했습니다. cursorBefore700·tracker sort800·terminal cursor800이 일치합니다. cycle 누적 group25=distinct25=run25, tracker37=distinct37, commit35·failure/deferred0이며 terminal 뒤 processing0·lane/run/lease/stage/probe null·circuit closed입니다. anchor 불변·streak2·baseline10·candidate false입니다.
- strict partial tracker 3건은 ID별 격리 만료 `2026-08-24T07:19:56.817985Z`·`15:33:02.119249Z`·`19:18:58.276397Z`이고 모두 current cycle claim0입니다. cursor sort800 뒤 현재 eligible group 9개가 남아 있어 partial 보존 경로의 실제 운영 증거는 아직 없으며, 강제 만료·재큐·cursor 이동 없이 자연 순번을 기다립니다.
- candidate8 activation evidence는 완전 idle에서 실행한 단일 canonical RPC의 requestStartUtc·responseEndUtc·raw accepted/activated/mode/minutes와 응답 직후 SELECT의 candidate/8·updated_at·exact identity·heartbeat·circuit/cooldown·processing/lane/run/lease를 같은 checkpoint로 캡처합니다. timeout·network·JSON 불완전 또는 결과 불일치는 ambiguous로 분류해 재시도0·성공 판정0으로 두고 DB 관측값과 불확실성만 기록합니다.
- candidate8 처리량은 DB 전환 updated_at부터 checkpoint까지 fixed-wall ≥60분, remote-wake 단독 조기 claim을 제외한 scheduled-compatible fully-terminal distinct group ≥6, open/duplicate0을 동시에 요구합니다. fully-terminal은 같은 run의 모든 tracker가 commit 또는 typed failure로 끝난 group만 인정합니다. strict `provider_partial_window:<1..299>_300`은 tracker-only 격리·proof·last-good 보존 확인 시 terminal 예외로만 포함하고 atomic300 success에서 제외합니다. remote-wake 요청/소비/claim 시각·건수와 포함/제외 민감도 값을 함께 공개하며 주 처리량 <8.75는 성공0, 8.75~8.77은 기준선 동등으로 기록합니다.
- run `6a6823a4-7923-4c24-8f65-5e40d200b30c`은 event9495→9497, collection `pw-chrome-1787550503430-51044388e8d8a43fe510`으로 checked300·official source·organic evidence/policy·adExcluded true·excludedAds30·rank27을 commit했습니다. cursorBefore800·tracker sort900·terminal cursor900이 일치합니다. cycle 누적 group26=distinct26=run26, tracker38=distinct38, commit36·failure/deferred0이고 terminal 뒤 processing0·lane/run/lease/stage/probe null·circuit closed·cooldown null입니다. 업데이트 뒤 wake0, anchor 불변·streak3·baseline10·candidate false입니다.
- `2026-08-24T05:53:46Z` SELECT-only checkpoint에서 event9497 이후 0건, heartbeat `05:53:31Z`, exact runtime1.1.12/fingerprint, anchor `05:31:17.200373Z`, streak3·baseline10·candidate false를 재확인했습니다. active74·paused0·quarantine3·processing0, circuit closed·cooldown/lane/run/lease/stage/probe null, cycle group26=distinct26=run26·tracker38=distinct38·commit36·failure/deferred0입니다. partial-window 3건은 anchor 뒤 claim/failure/snapshot 0건이며 상태 변경은 하지 않았습니다.
- run `4b50752a-9153-4747-b318-186b101e88ba`는 event9499→9501, collection `pw-chrome-1787551142509-7e45fed6d5c996f4bfdf`으로 checked300·official source·organic-only/evidence·adExcluded true·excludedAds30·stable-full-window·rank27을 commit했습니다. top5 광고/비오가닉 위반0, cursor sort900→1000 순방향입니다. cycle group27=distinct27=run27·tracker39=distinct39·commit37·failure/deferred0이고 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `05:59:31Z`, exact identity와 anchor가 유지되고 streak4·baseline10·candidate false입니다. partial-window 3건의 anchor 뒤 claim/failure/commit/snapshot은 0입니다.
- run `8e97fa6b-e299-40a2-9dc2-09ceaa12b4dc`는 event9503→9505, collection `pw-chrome-1787551245117-324adf2a00eb021016d3`으로 checked300·official source·organic-only/evidence·adExcluded true·excludedAds30·rank33을 commit했습니다. top5 광고/비오가닉 위반0, cursor sort1000→1100 순방향이며 cross-page proof marker null을 stable proof로 세지 않습니다. cycle group28=distinct28=run28·tracker40=distinct40·commit38·failure/deferred0이고 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:02:32Z`, exact identity·anchor 유지, streak5·baseline10·candidate false이고 partial-window 경로는 아직 미실증입니다.
- run `00616e1a-af66-4dda-a73b-d9d786fd6d46`은 event9507→9509, collection `pw-chrome-1787551637738-15fc524ae50d3d5f5aa2`로 checked300·official·organic-only/evidence·adExcluded true·excludedAds30·rank7·top5 위반0을 commit했고 cursor sort1100→1200입니다. cross-page proof 값은 null입니다.
- grouped run `a5e15aaf-d2c3-4018-8c7c-1855dbd3078c`은 앞 terminal 21초 뒤 event9512→9516으로 시작·종료돼 실행 겹침0입니다. collection `pw-chrome-1787551749474-1d0ac01af2c58ec68485`의 tracker/snapshot2행 모두 checked300·official·organic·adExcluded true·excludedAds30, rank1·22, top10 위반0, `stable-full-window-v1`입니다. 대표 cursor는 sort1200 내 created_at 순방향이고 두 번째 sort1500 tracker는 같은 collection 멤버입니다. cycle group30=distinct30=run30·tracker43=distinct43·commit41·failure/deferred0, terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:13:32Z`, exact identity·anchor 유지, streak7·baseline10·candidate false입니다. 성공6회 gate는 충족했지만 24시간 gate와 partial-window 실증은 남았습니다.
- run `f3f6db46-7880-4fb5-ba44-feff8b7710e1`은 event9518→9520, collection `pw-chrome-1787552306189-759e36c7713137580259`로 checked300·official·organic-only/evidence·adExcluded true·excludedAds45·rank7·top5 위반0을 commit했습니다. cross-page proof 실제 값은 null이고 cursor sort1200→1300 순방향입니다. cycle group31=distinct31=run31·tracker44=distinct44·commit42·failure/deferred0이며 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:18:31Z`, exact identity·anchor 유지·streak8·baseline10·candidate false이고 partial-window 3건은 아직 격리 중입니다.
- run `837521a2-d870-4eba-b0b7-15a26cdfa193`은 event9522→9524, collection `pw-chrome-1787552902160-6e9a1df7e21fc53982a5`로 checked300·official·organic-only/evidence·adExcluded true·excludedAds30·top5 위반0을 commit했습니다. 결과는 matched false·rank null·tracking source `not_found`, cross-page proof null입니다. cursor sort1300→1400 순방향, cycle group32=distinct32=run32·tracker45=distinct45·commit43·failure/deferred0이고 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:28:31Z`, exact identity·anchor 유지·streak9·baseline10·candidate false이며 partial-window 3건은 아직 격리 중입니다.
- run `7143c260-ba8c-4dc0-9587-e26e95ce5b6a`은 event9526→9528, collection `pw-chrome-1787553505441-caf04304c21d163f16d2`로 checked300·official·organic-only/evidence·adExcluded true·excludedAds45·top5 위반0을 commit했습니다. matched false·rank null·tracking source `not_found`, cross-page proof null이며 cursor sort1400→1500 순방향입니다. cycle group33=distinct33=run33·tracker46=distinct46·commit44·failure/deferred0이고 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:38:31Z`, exact identity·anchor 유지·streak10·baseline10·candidate false이며 partial-window 3건은 아직 격리 중입니다.
- run `8b3276a7-3fe7-47c5-ad2d-28b6f0ef1064`는 event9530→9532, collection `pw-chrome-1787554101574-d52ef97b9305331ebd4b`로 checked300·official·organic-only/evidence·adExcluded true·excludedAds30·top5 위반0을 commit했습니다. matched false·rank null·tracking source `not_found`, cross-page proof null이며 cursor는 sort1500 내 created_at `2026-07-08→2026-08-14` 순방향입니다. cycle group34=distinct34=run34·tracker47=distinct47·commit45·failure/deferred0이고 terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:48:31Z`, exact identity·anchor 유지·streak11·baseline10·candidate false이며 partial-window 3건은 아직 격리 중입니다.
- run `ff91859f-5285-4398-8b58-c9a57480bc55`는 event9534→9536, collection `pw-chrome-1787554696338-ab5293b9b7560680fcae`로 checked300·official·organic·adExcluded true·excludedAds60·top5 위반0·matched false·rank null·not_found·proof null을 commit했고 cursor sort1500→1600입니다.
- run `ba34d540-1715-4297-a7f7-6bbbb083426e`는 앞 terminal 8초 뒤 비중첩 시작해 event9538→9540, collection `pw-chrome-1787554746845-8dd863906a3b19f3d778`로 checked300·official·organic·adExcluded true·excludedAds45·top5 위반0·matched true·exact rank19·proof null을 commit했고 cursor sort1600→1700입니다. cycle group36=distinct36=run36·tracker49=distinct49·commit47·failure/deferred0, terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null입니다. heartbeat `06:59:31Z`, exact identity·anchor 유지·streak13·baseline10·candidate false이며 partial-window 3건은 아직 격리 중입니다.
- run `104e3511-418c-487e-bb4e-e89e1167c87a`는 event9542→9544, checked300·official source·organic-only/evidence·adExcluded true·excludedAds45·상위 광고/비오가닉 위반0·matched false·rank null·not_found·proof null을 commit했습니다. cursor는 sort1700 내 `(created_at,id)`가 `2026-07-10…/2c78…→2026-08-14…/524e…` 순방향입니다. cycle 중복/failure0, terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe/current tracker/job null입니다. heartbeat `07:09:31Z`, exact identity·anchor 유지·streak14·baseline10·candidate false입니다.
- partial `c0cc…`는 `2026-08-24T07:19:56.817985Z` 자연 만료 예정이고 07:10Z 기준 앞선 신규 group0·현 cycle 미claim입니다. 만료 전 claim/commit/failure/신규 snapshot0이며, 미래 claim을 선보고하지 않고 자연 회차를 기다립니다. 나머지 만료는 `2026-08-24T15:33:02.119249Z`·`19:18:58.276397Z`입니다.
- run `b5d4e261-79bf-4d39-b25c-4f35d2218de7`은 event9546→9548, collection `pw-chrome-1787555877229-201e38a109e2cf7360b6`으로 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded45·not_found·top5 위반0·`stable-full-window-v1`을 commit했고 cursor tuple `(1700,524e…)→(1800,2026-07-10…,f384…)`로 전진했습니다. run `446f6524-5b3f-47d8-8898-9d425dcd6a9e`은 event9550→9552, collection `pw-chrome-1787555928421-84afa5742848c05c3f33`으로 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded30·not_found·top5 위반0을 commit했고 proof 필드는 없으며 cursor tuple `(1800,f384…)→(1800,2026-08-14…,c7c…)` 순방향입니다. Run1 뒤 직접 idle 표본은 없지만 Run2 비중첩 claim, Run2 뒤 `07:19:36.668Z` lane/run/lease/stage/job/tracker null을 직접 확인했습니다.
- partial `c0cc…`는 자연 만료 뒤 eligible-new1·position1에서 run `573c3945-ca8e-4154-93f8-5c837bb074bb` event9554 group(new)→9555 tracker→9556 `job_failed provider_partial_window:94_300`→9557 quarantine_set으로 단1회 terminal됐습니다. 다음 격리 `2026-08-25T07:29:00.724542Z`, retry8이고 target snapshot 총0·신규0, rank/history/check/found 변조0입니다. global last-good은 collection `pw-chrome-1787555928421-84afa5742848c05c3f33`의 checked300·official·organic-only/evidence·adExcluded true·excluded30을 보존했습니다.
- `job_failed.details`에는 `{retryCount:8}`만 있어 raw RPC response는 비지속입니다. 같은 failure RPC의 DB failure/quarantine 갱신, 배포 함수의 exact predicate·return branch, anchor `05:31:17.200373Z`·streak16·baseline10·last-good 불변을 함께 대조해 `cadenceProofPreserved` branch 적용을 확인했습니다. cycle group40=distinct40·tracker53=distinct53, c0 group/claim/terminal 각1, terminal 뒤 processing0·circuit closed·cooldown/lane/run/lease/stage/probe null, exact runtime/fingerprint·heartbeat 정상입니다.
- post-partial run `1afb3b60-9fcd-48cb-b83c-ff0fa7b450e4`는 event9559 `priority=resume`·resumeCursorBefore true·cursor `(1800,c7c…)` →9560 tracker sort1900 →9561 commit으로 terminal됐습니다. collection `pw-chrome-1787557145976-3288ac6e9775777e996b`은 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded45·not_found·`stable-full-window-v1`·top5 위반0이고 cursor는 `(1900,2026-07-10…,720f…)`, resume=false로 복귀했습니다. cycle group41=distinct41·tracker54=distinct54·commit51·failure1, c0cc 재claim0, anchor 유지·streak17·baseline10, last-good 정상 갱신입니다. `07:39:39Z`·`07:40:02Z` 직접 표본에서 processing0·circuit closed·cooldown null·run/lane/lease/stage/job/tracker/probe null·exact runtime/fingerprint를 확인했습니다.
- run `75e81855-9b9c-442d-a1b6-80521352cd73`은 event9563→9565, collection `pw-chrome-1787557397706-39d484a6b400e293ecbc`으로 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded30·not_found·proof null을 commit했습니다. cursor는 sort1900 내 `(2026-07-10…,720f…)→(2026-08-14…,0f2e…)` 순방향, resume=false입니다. cycle group42=distinct42·tracker55=distinct55·commit52·failure1이며 `07:46:07.834Z` terminal 표본에서 processing0·circuit closed·cooldown null·run/lane/lease/stage/page/job/tracker/probe 해제를 확인했습니다. streak18·candidate false입니다.
- `2026-08-24T07:44:46.016394Z` fixed-wall 진단: anchor→checkpoint terminal distinct18(성공17/실패1)/2.2246711169h=`8.0910836046 group/h`, 첫 post-anchor claim→last terminal 동일18/2.0940661111h=`8.5957171574 group/h`, duplicate terminal claim0입니다. active-duration은 사용하지 않았고 둘 다 baseline10 pre-candidate 수치로 8분 성능·속도 향상 증거가 아닙니다. exact identity·heartbeat13.846초·closed/null/processing0/완전 idle·last atomic300는 충족하고 anchor age<24h만 candidate gate 미충족입니다.
- run `4c61901b-076b-4794-81fb-ca3cb0e2b353`은 event9567→9569, collection `pw-chrome-1787557746293-ddf4c7e567d5060fbb3c`으로 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded30·matched true·exact rank246·`stable-full-window-v1`을 commit했습니다. cursor/resume `(1900,0f2e…,false)→(2000,8589…,false)` 순방향, cycle group43=distinct43·tracker56=distinct56·commit53·failure1, streak19입니다.
- event9571 new target은 partial3가 아닌 registeredAfterCycleStart 신규 tracker `5f2e2b4d-e8ca-427f-8e18-838079d3e3be`·keyword `당뇨`입니다. run `941c4b0d-273c-4e29-88e2-98f987c0a189`은 event9571→9573, collection `pw-chrome-1787557854370-d019e9871f151b43a7ba`으로 snapshot1·checked300·official·organic-only/evidence·adExcluded true·excluded45·not_found·`stable-full-window-v1`을 commit했습니다. new 우선순위라 cursor `(2000,8589…)` 유지·resume false→true, partial3 재claim0입니다. anchor 유지·streak20·last-good 갱신, cycle group44=distinct44·tracker57=distinct57·commit54·failure1이고 `07:51:41Z` final processing0·circuit closed·cooldown null·run/lane/lease/stage/page/job/tracker/probe null입니다.
- run `409c110f-6bda-4909-bf69-fedc4112b26b`은 event9575 `priority=resume` `07:57:38.911Z`→9576 기존 tracker `09e8b580…` sort2100→9577 commit `07:58:23.450Z`으로 끝나 신규 tracker 뒤 기존 cursor 복귀를 실증했습니다. collection `pw-chrome-1787558303450-15a698be1728ba7d244c`은 snapshot1·checked300·official collector·organic-only/evidence·adExcluded true·excluded30·not_found·상단 위반0이고 cross-page proof 실제 값은 null입니다. cursor/resume `(2000,8589d7f7…,true)→(2100,2026-07-08T05:07:31.121866Z,09e8b580…,false)` 순방향, partial3 재claim 각0입니다. anchor 유지·streak21·baseline10·candidate false·last-good 갱신, cycle group45=distinct45·tracker58=distinct58·commit55·failure1이며 `07:59:22Z` processing0·circuit closed·cooldown null·run/lane/lease/stage/page/job/tracker/probe null입니다.
- `2026-08-24T08:02:34Z` 독립 SELECT-only candidate 판정은 exact runtime1.1.12/fingerprint, heartbeat2.404초, anchor `05:31:17.200373Z` age2시간31분, streak21, latest atomic300 age4분10초, baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/probe null입니다. 유일한 미충족은 anchor age<24h이며 earliest candidate는 `2026-08-25T05:31:17.200373Z`입니다. `08:03:46Z` 기준 partial `1114…`(retry27, error30_300, quarantine `15:33:02.119249Z`)와 `12f5…`(retry17, error138_300, quarantine `19:18:58.276397Z`)는 active·processing null이지만 quarantine_ok=false라 eligible=false이고 cycle35 미claim·anchor 이후 claim/commit/failure/snapshot0입니다. max event9577 이후 신규 terminal0이며 wake/cursor/order/quarantine 쓰기는 하지 않았습니다.
- event9578 `cycle_rostered`와 9579 `tracker_deferred`는 cycle35 시작 뒤 등록된 tracker `4a544e31-b514-4d8d-b9c0-1c5948041b25`·keyword `당뇨쌀`의 same-cycle duplicate-group remainder입니다. 기존 동일 normalized keyword tracker `bc1411c6…`는 event9423→9424에서 이미 atomic300 commit됐고 active 동일 그룹은 총2개입니다. 따라서 raw details `reason=group_claim_limit,claimLimit=100`은 공통 audit label이지 실제 100 tracker overflow가 아닙니다. 신규 row는 active·neverChecked·retry0·error/quarantine/processing null, claim/snapshot0, cursor sort2100 불변이며 roster/deferred 각1·unique입니다.
- run `fe16b2b1-41d6-4441-9f1f-bf5d8acb9398`은 event9581 `08:17:39.032Z` group(normal)→9582 tracker `7bdef95c…`→9583 `08:19:07.477Z` commit으로 defer 뒤 자연 진행을 확인했습니다. collection `pw-chrome-1787559547477-5538a040fde549b602aa`, snapshot `f8e4dddd…`는 checked300·official collector·organic-only/evidence·adExcluded true·excluded45·matched true·rank39·`stable-full-window-v1`입니다. cursor/resume `(2100,2026-07-08…,09e8…,false)→(2100,2026-07-10…,7bde…,false)` 순방향, cycle group46=distinct46=run46·tracker59=distinct59·commit56·failure1·deferred1로 중복0입니다. `08:20:41~57Z` exact identity·heartbeat·anchor 유지·streak22·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다. deferred tracker의 cycle36 실제 claim은 아직 미관측입니다.
- run `e6f6b55e-7f8f-4e99-b761-26229e8e77f0`은 event9585 `08:27:39.540Z` group(normal)→9586 tracker `e0e42318…`→9587 `08:29:03.328Z` commit으로 끝났습니다. collection `pw-chrome-1787560143328-22c92ea5712c4b8dc2d2`, snapshot `6050de4c…`는 checked300·official collector·organic-only/evidence·adExcluded true·excluded45·matched true·rank14·`stable-full-window-v1`입니다. cursor/resume `(2100,2026-07-10…,7bde…,false)→(2200,2026-07-10…,e0e4…,false)` 순방향, cycle group47=distinct47=run47·tracker60=distinct60·commit57·failure1·deferred1로 중복0입니다. event9579 target 재claim0이고 `08:29:30~40Z` streak23·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- fixed-wall checkpoint `2026-08-24T08:29:31.052294Z`: anchor→checkpoint는 terminal distinct group23(성공22·실패1)/2.9705144225h=`7.7427666487 group/h`, 첫 post-anchor claim `05:37:39.068Z`→last terminal `08:29:03.328Z`는 동일23/2.8567388889h=`8.0511383415 group/h`입니다. deferred1은 실제 수집이 아니므로 분자에서 제외했고 terminal group claim·tracker terminal event 중복0입니다. 둘 다 baseline10 pre-candidate이며 8.75~8.77 대비 향상 증거가 아닙니다.
- run `12368750-ad44-45c3-a7af-07bbc40c7b37`은 event9589 `08:37:38.972Z` group(normal)→9590 tracker `14aca089…`→9591 `08:39:06.962Z` commit으로 끝났습니다. collection `pw-chrome-1787560746962-a8eafa464d233a1f2051`, snapshot `5226bdbc…`는 checked300·official collector·organic-only/evidence·adExcluded true·excluded45·matched true·rank22·`stable-full-window-v1`입니다. cursor/resume `(2200,2026-07-10…,e0e4…,false)→(2300,2026-07-10…,14ac…,false)` 순방향, cycle group48=distinct48=run48·tracker61=distinct61·commit58·failure1·deferred1로 중복0입니다. event9579 target 재claim0이고 `08:40:20~29Z` streak24·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- `2026-08-24T08:45:40.621888Z` cycle35 snapshot에서 cursor 뒤 eligible은 12 tracker/10 normalized group, wrap-around 잔여0입니다. quarantine3 group과 event9579 deferred1 group은 현재 제외되며 partial2는 만료 시각까지 cycle35가 active면 재진입할 수 있어 skip 수를 확정하지 않습니다. 현 상태 기준 cycle completion 표식까지 최소 terminal10회+no-seed1회이고 `4a544e31…`은 cycle36 비격리 neverChecked 1순위이나 실제 claim 전에는 예상값입니다.
- run `7be37526-ff54-4a83-b838-dcfa45f4c9f4`는 event9593 `08:47:38.809Z` group(normal)→9594 tracker `026c45d1…`→9595 `08:49:04.223Z` commit으로 끝났습니다. collection `pw-chrome-1787561344223-356557852af2c4a0aeef`, snapshot `d26ee764…`은 checked300·official collector·organic-only/evidence·adExcluded true·excluded45·matched true·rank27·`stable-full-window-v1`입니다. cursor/resume `(2300,2026-07-10…,14ac…,false)→(2400,2026-07-10…,026c…,false)` 순방향, cycle group49=distinct49=run49·tracker62=distinct62·commit59·failure1·deferred1로 중복0입니다. event9579 target 재claim0이고 `08:50:20~29Z` streak25·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- run `1b61aa06-4f63-4620-a416-2f6d677cd431`은 event9597 `08:57:39.442Z` group(normal)→9598 tracker `15f48bae…`→9599 `08:58:24.600Z` commit으로 끝났습니다. collection `pw-chrome-1787561904600-6688be950ae986376a11`, snapshot `85db65dc…`은 checked300·official collector·organic-only/evidence·adExcluded true·excluded30·matched true·rank52이고 cross-page proof 실제 값은 null입니다. cursor/resume `(2400,2026-07-10…,026c…,false)→(2600,2026-07-10…,15f4…,false)` 순방향, cycle group50=distinct50=run50·tracker63=distinct63·commit60·failure1·deferred1로 중복0입니다. event9579 target 재claim0이고 `08:59:16~26Z` streak26·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- run `1ad0d2c0-0438-4c5b-a433-f5c60deb7d04`는 event9601 `09:07:39.535Z` group(normal)→9602 tracker `5ae9aa5b…`→9603 `09:08:22.620Z` commit으로 끝났습니다. collection `pw-chrome-1787562502620-8d1fd9a10fcea5919a6d`, snapshot `7a6bf7cc…`은 checked300·official collector·organic-only/evidence·adExcluded true·excluded30·matched true·rank10이고 cross-page proof 실제 값은 null입니다. cursor/resume `(2600,2026-07-10…,15f4…,false)→(2700,2026-08-10…,5ae9…,false)` 순방향, cycle group51=distinct51=run51·tracker64=distinct64·commit61·failure1·deferred1로 중복0입니다. event9579 target 재claim0이고 `09:09:25~34Z` streak27·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- 최근 normal group claim event9581·9585·9589·9593·9597·9601 시각은 `08:17:39.032Z`·`08:27:39.540Z`·`08:37:38.972Z`·`08:47:38.809Z`·`08:57:39.442Z`·`09:07:39.535Z`이고 간격은 600.508·599.432·599.837·600.633·600.093초입니다. 평균600.1006초(10.0016767분), 최소599.432·최대600.633초, 고유 run/group6·중복0·실행 겹침0이며 coordination baseline/10과 일치합니다. candidate8 성능 표본으로 사용하지 않습니다.
- `2026-08-24T09:12:05.684880Z` cycle35 snapshot에서 cursor 뒤 eligible은 9 tracker/7 normalized group이고 wrap/new 잔여0입니다. 최소 자연 기회는 group7+no-seed1이며 uninterrupted baseline10 산술 완료 범위 10:22~10:32Z는 partial1114 만료15:33:02Z보다 약5시간 이릅니다. repair/new/failure/lane 중단을 반영하지 않은 추정이라 보장하지 않고, event9579 target은 현재값 기준 cycle36 비격리 neverChecked 1순위입니다.
- grouped run `107f0c2f-79d2-4cc8-900a-ac48ed9aacdf`는 event9607 `09:17:38.847Z` group(member3)→9608~9610 tracker3→9611~9613 `09:18:23.439Z` commit3으로 끝났습니다. shared collection `pw-chrome-1787563103439-5d66484002e1d57a8e75`의 snapshot3/3은 checked300·official collector·organic-only/evidence·adExcluded true·excluded30·위반0, ranks18/7/71이고 proof3건 모두 null입니다. cursor/resume `(2700,2026-08-10…,5ae9…,false)→(2800,2026-08-10…,fae8…,false)` 순방향이며 sort2900/3000 멤버도 같은 group terminal입니다. cycle group52=distinct52=run52·tracker67=distinct67·commit64·failure1·deferred1, streak28(group당+1), event9579 재claim0이고 `09:19:43Z` processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null입니다.
- run `b52cf06c-2581-47da-9120-08cc488c73d1`은 event9615 `09:27:39.427Z`→9616 tracker `1346924b…`→9617 `09:28:26.898Z` commit, collection `pw-chrome-1787563706898-939026a3e0f6060a949f`, snapshot `07c3f3e3…`입니다. checked300·official collector·organic-only/evidence·adExcluded true·excluded30·not_found·proof null이고 cursor sort2800→3100입니다.
- 첫 terminal 5.239초 뒤 handoff run `c566b09f-8c61-499d-aad4-17b711101dfe`가 event9619 `09:28:32.137Z`→9620 tracker `8128f1ac…`→9621 `09:29:14.095Z` commit, collection `pw-chrome-1787563754095-9d695ad977bf00bd379a`, snapshot `a1a72e0b-09a2-4cfa-85a5-2d01dc6150f4`로 끝났습니다. checked300·official collector·organic-only/evidence·adExcluded true·excluded30·not_found·proof null이고 cursor sort3100→3200 순방향입니다. 두 run은 run/claim/group/tracker/collection이 달라 중복0·실행 겹침0입니다.
- mutable wake row의 source `rank-cron-cycle`, request `09:27:39.337Z`, consume/updated `09:28:31.714Z`과 코드의 remote maxJobs1은 두 번째가 별도 remote-wake handoff였다는 강한 증거입니다. 다만 append-only ledger에 trigger명이 없어 exact trigger를 영구 확정하지 않습니다. fixed-wall에는 terminal distinct group2로 포함하되 5.239초를 cadence 분모나 candidate8 성능으로 사용하지 않습니다. `09:30:41.728875Z` cycle group54=distinct54·tracker69=distinct69·commit66·failure1·deferred1, streak30·baseline10·candidate false, processing0·circuit closed·cooldown null·lane/run/lease/stage/page/job/tracker/probe null, event9579 재claim0입니다.
- run `7d336b89-c0f9-4599-bb94-cf41769acc90`은 event9623 `09:37:38.919Z` group(normal, cursorBefore sort3200 tracker8128…) →9624 tracker `b6b91032…` sort3300 →9625 `09:38:19.467Z` commit으로 종료됐습니다. collection `pw-chrome-1787564299467-601ced5de9cb36155f5b`, snapshot `e2ec91ea-ea32-49bc-8ffe-568663fc4a0c`는 checked300·official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·matched false·rank null·proof null이며 top5 광고/비오가닉0입니다. coordination cursor는 sort3300/같은 tracker, resume false입니다. cycle35 group55=distinct claim/group/run55, tracker70=distinct70, commit67·failure1·deferred1이고 anchor 이후 tracker claim34건의 terminal 미대응은0입니다. 전체 cycle에 남은 미대응2건은 전환 전 old-runtime event9484/9485로 새 lane 결함이 아니며 현재 processing0·run/lane/lease/stage/job/tracker/probe null·page0·circuit closed·cooldown null입니다.
- `2026-08-24T09:38:47.410371Z` candidate predicate 재현값은 runtime1.1.12/fingerprint exact, Windows heartbeat15.695초, anchor `05:31:17.200373Z` age4.125058h, streak31, 최근 atomic300 age27.195초, baseline10, circuit closed/reason null, cooldown null, processing0, lane/run/lease/stage/job/tracker/probe null·page0입니다. 유일한 미충족은 anchor age<24h이고 earliest `2026-08-25T05:31:17.200373Z`까지 19.874942h 남아 candidate false이며 RPC0회입니다. `09:42:01.711315Z` 기준 anchor 뒤 terminal group31(성공30·failure1)/4.179030817h=`7.417986 group/h`, 첫 claim `05:37:39.068Z`→last terminal `09:38:19.467Z`=`7.728318 group/h`입니다. snapshot33/collection30의 checked300·official source·pw-chrome·organic policy/evidence·adExcluded 위반0, top-item 위반0이며 baseline10 사전값이라 속도 향상으로 세지 않습니다.
- `09:43Z` partial/defer SELECT-only 감사에서 `1114f3af…`는 active·error30_300·retry27·quarantine `15:33:02.119249Z`, `12f5330a…`는 active·error138_300·retry17·quarantine `19:18:58.276397Z`이며 둘 다 최근 실패 뒤 claim/commit/failure/snapshot0입니다. last-good은 각각 legacy checked41/rank null과 checked40/rank1·current/best/worst1로 불변입니다. `4a544e31…`은 cycle35 defer 뒤 claim/terminal/snapshot0, active·neverChecked·retry0·error/quarantine/processing null이고 cycle35 active/cursor3300이라 cycle36 reclaim0입니다. 현재 neverChecked eligible 1순위라는 projection은 실제 다음-cycle terminal 전까지 회복 증거로 사용하지 않습니다.
- run `db345422-68d7-4c20-a072-90fea023e261`은 event9627 `09:47:38.985Z` group(normal, cursorBefore sort3300) →9628 tracker `c0be23ff…` sort3500 →9629 `09:48:22.091Z` commit으로 종료됐습니다. collection `pw-chrome-1787564902091-1ec46d65ff423a292598`, snapshot `83d7bc9c-d26e-4266-a3e3-b1688bea4c21`은 checked300·official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·matched/rank18·proof null이며 top5 위반0입니다. coordination cursor sort3500/같은 tracker/resume false, cycle35 group56=distinct claim/group/run56·tracker71=distinct71·commit68·failure1·deferred1입니다. `09:49:52.201Z` processing0·lane lease worker/token/until null·run/stage/job/tracker/probe null·page0·circuit closed/reason null·cooldown null, streak32·baseline10을 재확인했습니다.
- `09:50:08.023613Z` 기준 post-anchor terminal group32(성공31·failure1)/4.314117567h=`7.417503 group/h`, first claim `05:37:39.068Z`→last terminal `09:48:22.091Z`=`7.658035 group/h`입니다. snapshot34/collection31의 atomic/source/pw-chrome/organic/adExcluded 위반0·top-item 위반0이고 baseline10 사전값이라 8분 성능으로 세지 않습니다.
- `09:48:50.134Z` current-value queue 감사에서 cycle35 cursor 뒤 collectable은 sort3600·3700의 tracker/group 각2, wrap/new0, processing0입니다. current-cycle deferred는 `4a544e31…` 1건, unrostered quarantine는 `1114…`·`12f5…` 2건입니다. 최소 자연 기회3회(terminal2+no-seed1)라는 계산은 interruption 없는 projection이며, cycle36의 `4a…` new-priority group claim과 partial 자연 만료 재진입은 실제 event 전까지 미검증으로 유지합니다.
- run `86c06f0e-1e6a-4346-a885-595f87a89393`은 event9631 `09:57:38.956Z` group(normal, cursorBefore sort3500) →9632 tracker `95987fe5…` sort3600 →9633 `09:58:22.914Z` commit으로 종료됐습니다. collection `pw-chrome-1787565502914-6371771fbe1c949c6e3e`, snapshot `48ccdc05-2023-4ffd-bff8-d317ae3d515a`는 checked300·official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded17·matched/rank40·proof null이며 top5 위반0입니다. coordination cursor sort3600/같은 tracker/resume false, cycle35 group57=distinct claim/group/run57·tracker72=distinct72·commit69·failure1·deferred1입니다. `09:59:03.595628Z` processing0·lease worker/token/until null·run/stage/job/tracker/probe null·page0·circuit closed/reason null·cooldown null, streak33·baseline10을 재확인했습니다.
- `09:59:50.831156Z` 기준 post-anchor terminal group33(성공32·failure1)/4.476008551h=`7.372533 group/h`, first claim `05:37:39.068Z`→last terminal `09:58:22.914Z`=`7.594040 group/h`입니다. snapshot35/collection32의 atomic/source/pw-chrome/organic/adExcluded/top-item 위반0이며 baseline10 사전값입니다. current cursor 뒤 collectable은 sort3700 1 group이고 이후 no-seed cycle completion 판정이 남았습니다.
- run `faaa6d7b-7b92-4aa6-8af7-fd72f4021fe7`은 event9635 `10:07:38.953Z` group(normal, cursorBefore sort3600) →9636 tracker `89fec545…` sort3700 →9637 `10:08:18.828Z` commit으로 종료됐습니다. collection `pw-chrome-1787566098828-f7ac37338d4e43718551`, snapshot `7f2c6cd8-06e7-4827-b19e-840390d0aef2`는 checked300·official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·matched/rank3·proof null이며 top5 위반0입니다. coordination cursor sort3700/같은 tracker/resume false, cycle35 group58=distinct claim/group/run58·tracker73=distinct73·commit70·failure1·deferred1입니다. `10:09:18Z` processing0·tracker lease/error null·retry0, lane lease worker/token/until null·run/stage/job/tracker/probe null·page0·circuit closed/cooldown null, streak34·baseline10입니다. collectable0이나 cycle status active·cycle_completed event0이라 완료는 미확인입니다.
- `10:09:54.358412Z` 기준 post-anchor terminal group34(성공33·failure1)/4.643655011h=`7.321739 group/h`, first claim `05:37:39.068Z`→last terminal `10:08:18.828Z`=`7.537057 group/h`입니다. snapshot36/collection33의 atomic/source/pw-chrome/organic/adExcluded/top-item 위반0이며 baseline10 사전값입니다.
- event9638 `2026-08-24T10:17:38.879Z`는 cycle35 `dde692d9…`의 단일 `cycle_completed`입니다. coordination status=`completed`, completed_at 동일, cursor sort3700 유지, processing0·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 최종 roster76=distinct76, group58=distinct58, tracker claim73=distinct73, commit70·failure1·deferred1·completed1입니다. details scheduled/distinct claimed73/73·committed70·failed1·repair0이며 terminal 미대응2는 전환 전 event9484/9485로 한정됩니다. `10:19:54.728Z`까지 후속 event0, cycle36/`4a544e31…` reclaim0이고 해당 tracker는 active·neverChecked·snapshot0·claimed_at null·deferred_at `08:07:38.964Z`·processing/error/quarantine null·retry0 상태를 유지합니다.
- cycle36 `f8e661b9-2307-464d-b585-4e560ee99138`은 event9639 `10:20:32.140Z` 시작(active76/eligible73/quarantine3)입니다. target `4a544e31…` event9650 eligible/neverChecked/sort200과 동일 keyword companion `bc1411c6…` event9713 eligible/sort400은 같은 fingerprint `e98fa…`입니다. event9718 `10:20:32.404Z` group(new/member2/cursorBefore null) →9719·9720 동일 claim/run/fingerprint tracker2 →9721·9722 `10:21:58.234Z` commit 순서입니다. shared collection `pw-chrome-1787566918234-6aa3b5e8981a372a13b7`, snapshot `52930376…`·`e87c0241…`은 checked300·official collector·organic-only/evidence·adExcluded true·excluded37·top5 위반0, rank10/26입니다. event proof는 둘 다 `stable-full-window-v1`, snapshot item proof는 null입니다.
- target tracker는 `last_checked_at=10:21:58.234Z`, current/best/worst10, check/found1, retry0, error/quarantine/processing/deferred null, cycle36 claimed_at `10:20:32.374Z`로 회수 완료됐습니다. `10:23:05.958888Z` cycle36 group1=distinct claim/group/run1·tracker2=distinct2·commit2·failure/deferred0, cursor null/resume true, processing0·lease worker/token/until null·run/stage/job/tracker/probe null·page0·circuit closed/cooldown null, streak35·baseline10입니다. `10:23:40.141521Z` post-anchor terminal group35(성공34·failure1)의 fixed-wall `7.182305 group/h`, claim→terminal `7.386059 group/h`, snapshot38/collection34 계약 위반0입니다.
- 신규 우선 회수 뒤 첫 자연 후속 run `7a9f15fc-91d2-4a51-96d0-842662ed8f60`은 event9725 `10:27:38.876Z` group(`priority=resume`, member2, resumeBefore=true, cursorBefore null) →9726 sort100 tracker `02d03a4d…`·9727 sort200 tracker `2be44fb5…` →9728·9729 `10:28:19.593Z` commit으로 종료됐습니다. shared collection `pw-chrome-1787567299593-73b3ec169d3e54f34851`, snapshot `3f79eeed…`·`ea1ffb1b…`는 checked300·official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·top5 광고/비오가닉 위반0이며 둘 다 matched false·rank/proof null입니다. cycle36 누적 group/claim/run2=distinct2, tracker claim4=distinct4·commit4·failure/deferred0으로 중복0입니다. coordination cursor는 null/resume=true에서 sort100/`02d03a4d…`로 진입해 resume=false가 됐고, `10:29:51.845191Z` runtime1.1.12/fingerprint exact·heartbeat age19.802초·streak36·baseline10·candidate false, processing0·lease worker/token/until null·run/stage/job/tracker/probe null·page0·circuit closed/reason/cooldown null입니다. 운영 쓰기·RPC·wake/cursor/quarantine 조작은0입니다.
- `2026-08-24T10:33:00.592919Z` 독립 candidate predicate 감사는 runtime/fingerprint exact·heartbeat28.745초·anchor age18103.393초·streak36·최근 atomic 약4분40초·baseline10·closed/null·processing0·완전 idle이었고 유일한 false predicate는 anchor<24h입니다. earliest `2026-08-25T05:31:17.200373Z`, candidate false·RPC0회입니다. partial `1114…`·`12f5…`는 cycle36 event9676/9674 quarantined roster 외 claim/terminal/current-cycle snapshot0이며 만료 `15:33:02.119249Z`·`19:18:58.276397Z` 전입니다. 실패 뒤 신규 snapshot0, 기존 rank/last_checked/이력 수 보존을 확인했으나 최신 과거 snapshot은 각각 legacy checked41/source `naver_shopping_search_api`·checked40/source `naver_integrated_search_mobile_top_fallback`이므로 atomic300 last-good이 아닙니다. Production `10:33:42Z` `/health`·`/ready`는 release `d655eb080d55`, live·Supabase ready입니다.
- run `2deb1ed4-7951-483b-b755-86c037162c1f`은 event9732 `10:37:38.827Z` group(normal/member2, cursorBefore sort100 tracker `02d03a4d…`) →9733·9734 tracker2 →9735·9736 `10:38:20.227Z` commit으로 종료됐습니다. shared collection `pw-chrome-1787567900227-e13e1dfc6bf8c357f19d`, snapshot `91ce513a…` rank241·`19f0606f…` rank104는 모두 checked300·official collector/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·top5 organic1~5/explicit ad0·proof null입니다. cursor tuple은 같은 sort100의 created_at `2026-06-26T01:08:18.538194Z`→`2026-06-26T14:47:57.900053Z` strict forward, resume false입니다. cycle36 누적 group3=distinct group/claim/run3·tracker6=distinct6·commit6·failure/deferred0, 해당 run group1/tracker2/terminal2/open0/collection1입니다. `10:40:12.316461Z` streak37·baseline10, processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T10:44:06.420938Z` fixed-wall 감사는 anchor 뒤 fully-terminal distinct group37=성공36+event9556 partial1, distinct claim/run37/37·open0입니다. anchor→관측5.213672379h=`7.096725170 group/h`, first claim `05:37:39.068Z`→latest terminal `10:38:20.227Z`5.011433056h=`7.383117681 group/h`입니다. snapshot42/collection36의 checked300·official source·pw-chrome·organic 계약·adExcluded·top-item 위반0, same-cycle scheduled group/tracker duplicate excess0입니다. baseline10 pre-candidate라 8.75~8.77 대비 개선 증거가 아닙니다.
- run `946f8dae-36a6-478b-aca0-5cb042e8a0af`은 event9738 `10:47:38.856Z` group(normal/member1, cursorBefore sort100 `c037bbf6…`) →9739 tracker `099e1cd0…` →9740 `10:48:20.256Z` commit으로 종료됐습니다. collection `pw-chrome-1787568500256-c425b34a232b8ed390bd`, snapshot `0badd30b…`은 checked300·source/item source official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·top5 organic1~5/explicit ad0·rank48·proof null입니다. cursor tuple은 `(100,2026-06-26T14:47:57.900053Z,c037…)→(100,2026-06-29T04:07:14.953018Z,099e…)` strict forward, resume false입니다. cycle36 누적 group4=distinct group/claim/run4·tracker7=distinct7·commit7·failure/deferred0, 해당 run group1/tracker1/terminal1/open0/collection1입니다. `10:50:18.940996Z` streak38·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- cycle36 code/live 순번 감사에서 `2026-08-24T10:55:07.016583Z` cursor 뒤 collectable53그룹/66트래커, duplicate-defer 후보0·pending repair0입니다. roster trigger는 quarantined event만 남기고 worker_last_cycle_id를 바꾸지 않으며 claim function은 last_checked non-null인 두 partial을 만료 전 제외하고 만료 후 cursor 뒤 또는 wrap의 normal/resume에서만 선택합니다. `10:55:39Z` 두 대상은 cycle36 rostered=quarantined1, claim/terminal/snapshot0, processing null, worker_last_cycle_id=cycle33, same-key current-cycle0입니다. 변동 없는 baseline10 조건부 projection은 `12f5…` #54 약19:47Z·`1114…` #55 약19:57Z wrap claim, #56 약20:07Z no-seed completion이지만 신규/repair/remote wake/failure/cooldown/delay/priority 변화 시 무효입니다.
- run `7115b2eb-0aa9-45ca-8e19-7bbae6d40bcb`은 event9742 `10:57:38.889Z` group(normal/member1, cursorBefore sort100 `099e1cd0…`) →9743 tracker `7f84a275…` →9744 `10:59:03.389Z` commit으로 종료됐습니다. collection `pw-chrome-1787569143389-060e416dcffe13499d0c`, snapshot `f3f1066a…`는 checked300·source/item source official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded60·top5 organic1~5/explicit ad0·matched false/rank null·`stable-full-window-v1`입니다. cursor tuple `(100,2026-06-29T04:07:14.953018Z,099e…)→(100,2026-06-29T09:40:01.786604Z,7f84…)` strict forward, resume false입니다. cycle36 누적 group5=distinct group/claim/run5·tracker8=distinct8·commit8·failure/deferred/open0, 해당 run group1/tracker1/terminal1/open0/collection1입니다. `11:00:09.733Z` streak39·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- cycle36 event9725→9732→9738→9742 group claim 간격은 599.951·600.029·600.033초입니다. 다음 event9747은 직전 claim 뒤473.480초이며 mutable `naver_shopping_worker_wakes` row가 source `rank-cron-cycle`, requested/consumed `11:04:33.646427Z`, consume updated_at `11:05:31.897507Z`로 event9747 `11:05:32.369Z` 0.472초 전 handoff와 일치합니다. append-only ledger에는 trigger명이 없어 exact trigger는 미확정입니다. 전체 baseline fixed-wall에는 terminal group1건으로 포함하고, 이 짧은 간격 자체만 candidate8 cadence 증거로 인정하지 않습니다.
- run `8f2e0210-210a-4741-9b78-35bf7f0de078`은 event9747 `11:05:32.369Z` group(normal/member2) →9748·9749 tracker2 →9750·9751 `11:06:15.960Z` commit으로 종료됐습니다. collection `pw-chrome-1787569575960-c48aa7309463d8ed84cc`, snapshot `d103a699…` rank84·`47a6a481…` rank183은 checked300·source/item source official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·top5 organic1~5/explicit ad0·proof null입니다. 대표 cursor tuple `(100,2026-06-29T09:40:01.786604Z,7f84…)→(100,2026-07-01T07:58:47.711363Z,ef3c…)` strict forward, resume false이고 다른 member sort3400도 동일 collection terminal입니다. cycle36 누적 group6=distinct group/claim/run6·tracker10=distinct10·commit10·failure/deferred/open0, 해당 run group1/tracker2/terminal2/open0/collection1입니다. `11:06:58.110Z` streak40·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- 정규 run `ce507ab4-b1cc-4d0f-864e-19e1e7f8f59a`는 앞 run terminal `11:06:15.960Z` 뒤82.735초인 event9753 `11:07:38.695Z` group(normal/member1) →9754 tracker `1e712fd1…` →9755 `11:09:02.134Z` commit으로 종료되어 overlap0입니다. collection `pw-chrome-1787569742134-802bdbe55b44b5182b51`, snapshot `15799fae…`는 checked300·source/item source official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic1~5/explicit ad0·matched false/rank null·`stable-full-window-v1`입니다. cursor tuple `(100,2026-07-01T07:58:47.711363Z,ef3c…)→(100,2026-08-11T06:32:49.851713Z,1e71…)` strict forward, resume false입니다. cycle36 누적 group7=distinct group/claim/run7·tracker11=distinct11·commit11·failure/deferred/open0, 해당 run terminal1/open0입니다. `11:09:48.084888Z` streak41·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T11:12:41.099081Z` event9755 상한 fixed-wall은 fully-terminal distinct group41=성공40+partial1, distinct claim/run41/41·open0입니다. anchor→관측5.689971863h=`7.205659533 group/h`, first claim→latest terminal5.523073889h=`7.423402407 group/h`입니다. snapshot47/collection40 atomic/source official/pw-chrome/organic/adExcluded/top-item 위반0, same-cycle group/tracker duplicate excess0입니다. rank-cron-cycle mutable wake 영향 포함 baseline10 사전값이라 candidate8 개선값이 아닙니다.
- run `bca8140a-3e56-47e7-9ad3-03984e05879c`은 앞 run terminal 뒤516.889초, claim-to-claim600.328초인 event9757 `11:17:39.023Z` group(normal/member1) →9758 tracker `5f2e2b4d…` →9759 `11:19:02.874Z` commit으로 overlap0 종료됐습니다. collection `pw-chrome-1787570342874-5b0a88b1b49fb2c84693`, snapshot `f97f663a…`는 checked300·source/item source official collector·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic1~5/explicit ad0·matched false/rank null·`stable-full-window-v1`입니다. cursor tuple `(100,2026-08-11T06:32:49.851713Z,1e71…)→(100,2026-08-24T07:48:46.077570Z,5f2e…)` strict forward, resume false입니다. cycle36 누적 group8=distinct group/claim/run8·tracker12=distinct12·commit12·failure/deferred/open0, 해당 run terminal1/open0입니다. `11:20:02.545Z` streak42·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T11:24:26.959634Z` 독립 candidate predicate는 runtime/fingerprint exact·heartbeat age55.148초·최근 성공 age323.432초·last collection checked300/official/excluded45·streak42·baseline10·circuit closed/reason/cooldown null·processing0·lane/run/lease/stage/page/job/tracker/probe null·page0를 반환했고 유일한 false predicate는 anchor age5.886044239h<24h입니다. earliest `2026-08-25T05:31:17.200373Z`, candidate false·RPC0회입니다. event9759 상한 fully-terminal group42=success41+`provider_partial_window:94_300`1, distinct group/claim/run42/42/42·open0, snapshot48/collection41의 checked300·official source·pw-chrome·organic 계약·adExcluded·top-item 위반0·same-cycle group/tracker 중복0입니다. anchor→observed `7.139991027 group/h`, first claim→latest terminal `7.381440734 group/h`이며 remote wake 영향 포함 baseline10이라 candidate8 성능 증거가 아닙니다.
- `11:24:39.454089Z` 두 잔여 partial은 격리 만료 전입니다. `1114…`는 quarantine `15:33:02.119249Z`, 실패 event8780 `provider_partial_window:30_300`→8781 뒤 roster8975/9322/9676 외 claim/terminal/snapshot/collection0이고 legacy snapshot checked41/rank null·tracker last-good/total58을 보존합니다. `12f5…`는 quarantine `19:18:58.276397Z`, 실패 event8937 `provider_partial_window:138_300`→8938 뒤 roster8974/9319/9674 외 claim/terminal/snapshot/collection0이고 legacy snapshot checked40/rank1·tracker last-good/total71을 보존합니다. 둘 다 processing null·worker_last_cycle=cycle33이며 자연 회복 또는 새 typed failure는 아직 미발생입니다.
- run `b84cc226-650e-44dd-98d1-ccfd70f4191d`은 event9759 terminal 뒤516.537초인 event9761 `11:27:39.411Z` group(normal/member1) →9762 tracker `2dd39f10…` sort200 →9763 `11:28:21.311Z` commit으로 overlap0 종료됐습니다. collection `pw-chrome-1787570901311-518caa26bd4702aae80c`, snapshot `0d6d99b2…`는 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·rank59·contract valid입니다. cursor tuple `(100,2026-08-24T07:48:46.077570Z,5f2e…)→(200,2026-06-26T14:48:06.757674Z,2dd3…)` strict forward, resume false입니다. cycle36 누적 group/claim/run9=distinct9·tracker13=distinct13·commit13·failure/open0, 해당 run group1/tracker1/terminal1/open0/collection1입니다. `11:29:32.428871Z` streak43·baseline10, tracker/lookup processing0·circuit closed·cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T11:30:48.188588Z` event9763 상한 fully-terminal group43=success42+typed partial1, distinct group/claim/run43/43/43·open0입니다. anchor→observed5.991941171h=`7.176305437 group/h`, first claim→latest terminal5.8450675h=`7.356630184 group/h`입니다. snapshot49/collection42의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. remote wake 영향 포함 baseline10 사전값이라 candidate8 성능으로 사용하지 않습니다.
- run `25c3b786-7b0b-40d1-b606-0a81030560a5`은 event9761 claim 뒤599.442초인 event9765 `11:37:38.853Z` group(normal/member1) →9766 tracker `c7095689…` →9767 `11:39:00.061Z` commit으로 claim→terminal81.208초·overlap0 종료됐습니다. collection `pw-chrome-1787571540061-8aea0eb7389643d4c90f`, snapshot `3517fe07…`은 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic rank1~5/explicit ad0·matched false/rank null·`stable-full-window-v1`입니다. cursor tuple `(200,2026-06-26T14:48:06.757674Z,2dd3…)→(200,2026-06-29T03:29:57.201268Z,c709…)` strict forward, resume false입니다. cycle36 누적 group/claim/run10=distinct10·tracker14=distinct14·commit14·failure/open0, 해당 run group1/tracker1/terminal1/collection1입니다. `11:41:22.258584Z` streak44·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T11:42:19.332597Z` event9767 상한 fully-terminal group44=success43+typed partial1, distinct group/claim/run44/44/44·open0입니다. anchor→observed6.183925618h=`7.115221418 group/h`, first claim→latest terminal6.022498056h=`7.305938432 group/h`입니다. snapshot50/collection43의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- run `4f8d493d-9389-4d75-8979-704f3ff8178d`은 event9765 claim 뒤599.969초인 event9769 `11:47:38.822Z` group(normal/member1) →9770 tracker `3296e4e6…` →9771 `11:49:01.706Z` commit으로 claim→terminal82.884초·overlap0 종료됐습니다. collection `pw-chrome-1787572141706-7f68443074234c7363d9`, snapshot `84c0b6b1…`은 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic rank1~5/explicit ad0·matched false/rank null·`stable-full-window-v1`입니다. cursor tuple `(200,2026-06-29T03:29:57.201268Z,c709…)→(200,2026-07-04T06:23:03.409082Z,3296…)` strict forward, resume false입니다. cycle36 누적 group/claim/run11=distinct11·tracker15=distinct15·commit15·failure/open0, 해당 run group1/tracker1/terminal1/collection1입니다. `11:50:03.416299Z` streak45·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T11:50:46.751259Z` event9771 상한 fully-terminal group45=success44+typed partial1, distinct group/claim/run45/45/45·open0입니다. anchor→observed6.324875246h=`7.114764837 group/h`, first claim→latest terminal6.189621667h=`7.270234341 group/h`입니다. snapshot51/collection44의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- run `f8e92f54-aae1-47fa-baf9-cce0399fe6a9`은 event9769 claim 뒤600.034초인 event9773 `11:57:38.856Z` group(normal/member1) →9774 tracker `bbc35960…` →9775 `11:58:23.046Z` commit으로 claim→terminal44.190초·overlap0 종료됐습니다. collection `pw-chrome-1787572703046-41a17c10b93506756ec5`, snapshot `fb98d013…`은 checked300·official source/item source·organic-only/evidence·adExcluded true·excluded45·top5 organic rank1~5/explicit ad0·matched false/rank null입니다. cursor `(200,2026-07-04T06:23:03.409082Z,3296…)→(300,2026-06-26T14:48:13.489923Z,bbc3…)` strict forward입니다.
- 직후 run `986eba85-18f5-4fae-bfb5-659b1ca158a1`은 event9775 terminal 뒤9.038초인 event9777 `11:58:32.084Z` group(normal) →9778 tracker `6623318b…` →9779 `11:59:12.862Z` commit으로 overlap0 종료됐습니다. collection `pw-chrome-1787572752862-4e8cc8fc8bc64c5e361f`, snapshot `cc594f3c…`은 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded6·top5 organic rank1~5/explicit ad0·rank1·proof null입니다. cursor tuple `(300,2026-06-26T14:48:13.489923Z,bbc3…)→(300,2026-06-29T04:31:17.324506Z,6623…)` strict forward, resume false입니다. cycle36 누적 group/claim/run13=distinct13·tracker17=distinct17·commit17·failure/open0이고 `12:02:02.232616Z` streak47·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. mutable wake row rank-cron-cycle requested/consumed `11:58:15.030796Z`·updated `11:58:31.722398Z`가 claim 0.362초 전 handoff와 강하게 일치하지만 ledger에 trigger 필드가 없어 exact trigger로 단정하지 않습니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T12:01:59.310795Z` event9779 상한 fully-terminal group47=success46+typed partial1, distinct group/claim/run47/47/47·open0입니다. anchor→observed6.511697339h=`7.217780181 group/h`, first claim→latest terminal6.359387222h=`7.390649186 group/h`입니다. snapshot53/collection46의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. remote wake 영향 포함 baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- 원격 wake follow-on 뒤 run `b393e2d1-4234-4fea-ab6f-a1718912c607`은 원래 scheduled event9773 claim 뒤600.070초인 event9781 `12:07:38.926Z` group(normal) →9782 tracker `385aa03f…` →9783 `12:08:22.653Z` commit으로 claim→terminal43.727초·overlap0 종료돼 정규 10분 anchor/순서 복귀를 확인했습니다. collection `pw-chrome-1787573302653-a433c9e83e926ea76e83`, snapshot `96b79fcb…`은 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded60·top5 organic rank1~5/explicit ad0·rank2·proof null입니다. cursor tuple `(300,2026-06-29T04:31:17.324506Z,6623…)→(300,2026-07-06T03:17:39.223733Z,385a…)` strict forward, resume false입니다. cycle36 누적 group/claim/run14=distinct14·tracker18=distinct18·commit18·failure/open0, 해당 run group1/tracker1/terminal1/collection1입니다. `12:09:16.016636Z` streak48·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T12:10:00.830029Z` event9783 상한 fully-terminal group48=success47+typed partial1, distinct group/claim/run48/48/48·open0입니다. anchor→observed6.645452682h=`7.222984241 group/h`, first claim→latest terminal6.512106944h=`7.370886321 group/h`입니다. snapshot54/collection47의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. 앞선 remote wake 영향 포함 baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- run `02470238-4fbb-4ba8-8835-8859ba7b1183`은 event9781 claim 뒤600.161초인 event9785 `12:17:39.087Z` group(normal) →9786 tracker `bf0e733f…` →9787 `12:18:18.970Z` commit으로 claim→terminal39.883초·overlap0 종료됐습니다. collection `pw-chrome-1787573898970-6f598d222c4e01eaac94`, snapshot `41954f70…`은 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic rank1~5/explicit ad0·rank82·proof null입니다. cursor tuple `(300,2026-07-06T03:17:39.223733Z,385a…)→(400,2026-06-26T14:48:41.643037Z,bf0e…)` strict forward, resume false입니다. cycle36 누적 group/claim/run15=distinct15·tracker19=distinct19·commit19·failure/open0, 해당 run group1/tracker1/terminal1/collection1입니다. `12:19:10.306701Z` streak49·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T12:19:56.366909Z` event9787 상한 fully-terminal group49=success48+typed partial1, distinct group/claim/run49/49/49·open0입니다. anchor→observed6.810879593h=`7.194371788 group/h`, first claim→latest terminal6.677750556h=`7.337800296 group/h`입니다. snapshot55/collection48의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item snapshot/row 위반0, same-cycle group/tracker duplicate excess0입니다. 앞선 remote wake 영향 포함 baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- `2026-08-24T12:22:11.339297Z` queue 감사는 cycle36 cursor sort400 뒤 collectable42그룹/54트래커를 확인했습니다. `1114…`는 quarantine `15:33:02.119249Z`까지 11,450.780초·가상 해제 시 after-cursor 8번째, `12f5…`는 `19:18:58.276397Z`까지25,006.937초·가상 해제 시 wrap 1번째이나 둘 다 실제 queue 미포함입니다. cycle36 claim/terminal·실패 뒤 신규 snapshot/collection0, legacy last-good와 check_count58/71 보존입니다. 신규/remote wake/repair/실패/cooldown/지연 없는 조건부 projection만 wrap 후 약19:27Z/19:37Z이며 자연 회복/새 typed failure는 아직 없습니다.
- run `28ea195a-ba49-409b-914d-a5245ae4e250`은 event9785 claim 뒤599.850초인 event9790 `12:27:38.937Z` group(normal/member2) →9791·9792 tracker2 →9793·9794 `12:28:21.317Z` commit2로 claim→terminal42.380초·overlap0 종료됐습니다. shared collection `pw-chrome-1787574501317-9decc4a524ad55d6b0ab`, snapshot `5ee0ade1…` rank146·`498b91be…` rank null은 모두 checked300·official source/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·top5 organic rank1~5/explicit ad0·proof null입니다. 대표 cursor tuple `(400,2026-06-26T14:48:41.643037Z,bf0e…)→(400,2026-07-08T02:08:19.493670Z,74fb…)` strict forward, resume false이고 companion sort1200도 같은 group/collection terminal입니다. cycle36 누적 group/claim/run16=distinct16·tracker21=distinct21·commit21·failure/open0, 해당 run group1/tracker2/terminal2/collection1입니다. `12:29:20.101835Z` streak50·baseline10, tracker/lookup processing0·circuit closed/reason/cooldown null·lease worker/token/until null·run/stage/job/tracker/probe null·page0입니다. 운영 쓰기·RPC·큐 조작0입니다.
- `2026-08-24T12:30:05.843684Z` event9794 상한 fully-terminal group50=success49+typed partial1, distinct group/claim/run50/50/50·open0입니다. anchor→observed6.980178698h=`7.163140396 group/h`, first claim→latest terminal6.845069167h=`7.304528089 group/h`입니다. snapshot57/collection49의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item 위반0, same-cycle group/tracker duplicate excess0입니다. 앞선 remote wake 영향 포함 baseline10 사전값이며 candidate8 성능으로 사용하지 않습니다.
- run `38368b08-2f54-4f56-a0e2-4fdf67111ca2`은 event9799 `12:37:39.181Z` group(normal/member4) →9800~9803 tracker4 →9804~9807 `12:38:21.341Z` commit4로 끝났습니다. shared collection `pw-chrome-1787575101341-b9710ade3a0645690992`의 snapshot4는 checked300·official collector/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·top5 organic1~5/광고0입니다. 직전 claim 간격600.244초·claim→terminal42.160초·overlap0, cursor tuple은 sort400 내 strict forward이고 resume=false입니다. cycle36 group/claim/run17=distinct17·tracker25=distinct25·commit25·failure/open0, `12:39:22.185400Z` streak51·baseline10·processing0·closed/null·lane/run/lease/stage/job/tracker/probe null입니다.
- `2026-08-24T12:41:46.823746Z` event9807 상한 fully-terminal group51=success50+typed partial1, distinct group/claim/run51/51/51·open0입니다. anchor→observed7.174895381h=`7.108117581 group/h`, first claim→latest terminal7.011742500h=`7.273512968 group/h`입니다. snapshot61/collection50의 checked300·official source·pw-chrome·organic contract·adExcluded·top-item 위반0, same-cycle group/tracker duplicate excess0입니다. baseline10 pre-candidate 수치라 속도 향상 증거가 아닙니다.
- run `7997d9da-b325-4f8b-992e-e6a2f9aa5f80`은 event9809 `12:47:38.975Z` group(normal/member1) →9810 tracker →9811 `12:48:24.738Z` commit으로 끝났습니다. collection `pw-chrome-1787575704738-8bd8fae82bb052301b85`, snapshot `3d143878-ba61-4afa-8d0c-f3c2f12d5ac4`는 checked300·official collector/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·rank115·top5 organic1~5/광고0입니다. claim interval599.794초·overlap0, cursor sort400→500 strict forward·resume false입니다. cycle36 group/claim/run18=distinct18·tracker26=distinct26·commit26·failure/open0이고 `12:49:23.351996Z` processing0·closed/null·lane/run/lease/stage/job/tracker/probe null·streak52·baseline10입니다.
- `2026-08-24T12:48:51.786423Z` operations는 runtime/fingerprint exact·heartbeat20.104초·last atomic26.265초·anchor age7.293h·streak52·baseline10, circuit closed/reason/cooldown null·processing0·완전 idle이며 `candidate_eligible=false`의 유일한 false predicate는 anchor<24h입니다. RPC0회입니다. `12:50:10.600766Z` event9811 상한 fully-terminal group52=success51+typed partial1, distinct group/claim/run52/52/52·open0, anchor→observed7.314833443h=`7.108842656 group/h`, first claim→latest terminal7.179352778h=`7.242992733 group/h`입니다. snapshot62/collection51의 checked300·official/pw-chrome·organic/adExcluded/top-item/terminal 위반과 same-cycle group/tracker duplicate excess는 모두0입니다. baseline10 pre-candidate라 candidate8 성능이 아닙니다.
- `2026-08-24T12:53:43.410048Z` 독립 predicate 29개 중 false는 `anchor_24h` 하나입니다. anchor age7.373947132h·remaining16.626052868h, streak52이며 exact identity·heartbeat·최근 atomic300·baseline10·closed/null·processing0·lane/run/lease/page/job/probe null은 모두 true입니다. `12:55:30.645479Z` partial 감사에서 `1114…`·`12f5…`는 quarantine까지2:37:31·6:23:27, cycle36 roster event 외 claim/terminal/snapshot/collection0입니다. 각각 legacy checked41/rank null/check58·checked40/rank1/check71과 전체 snapshot58/71을 보존했고 아직 실제 claim 순번·회복·typed failure는 없습니다.
- run `b9584877-959d-41c8-9e63-19f350c57f87`은 event9813 `12:57:38.828Z` group(normal/member1) →9814 tracker →9815 `12:59:01.658Z` commit으로 끝났습니다. collection `pw-chrome-1787576341658-23b17c8f258c796c158f`, snapshot `9b20407a-a012-4ce4-9b01-63899d7068c0`은 checked300·official collector/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded45·not_found·`stable-full-window-v1`·top5 위반0입니다. scheduled claim interval599.853초·claim→terminal82.830초·overlap0, cursor sort500 내 strict forward·resume false입니다. cycle36 group/claim/run19=distinct19·tracker27=distinct27·commit27·failure/open0이고 `13:00:18.074283Z` processing0·closed/null·lane/run/lease/stage/job/tracker/probe null·streak53·baseline10입니다. `13:00:50.316520Z` event9815 상한 fully-terminal group53=success52+typed partial1·open0, anchor→observed7.492532263h=`7.073709947 group/h`, first claim→latest terminal7.356275h=`7.204733374 group/h`, snapshot63/collection52 품질 위반·same-cycle duplicate excess0입니다. baseline10 pre-candidate라 candidate8 성능이 아닙니다.
- Production `13:03~13:04Z` 재검증은 `/health`·`/ready` 200, release `d655eb080d55`, live/ready·Supabase ready·missing0입니다. 운영 runtime/fingerprint exact, migration `20260824051736/39/41` 존재, 관련 함수4개 모두 `prosecdef=false`·`search_path=""`·ACL `{postgres,service_role}`·anon/auth execute false입니다. `13:04:48.094236Z` event9815 상한 cycle36 group/run/claim19/19/19·tracker27/27로 duplicate excess0, open/orphan/duplicate terminal/member mismatch/non-forward cursor0, coordination cursor exact·processing/lane/run/lease null입니다.
- run `0bcbbdb8-fe3a-4d77-9b04-9d592160c5d1`은 event9818 `13:07:39.171Z` group(normal/member2) →9819·9820 tracker2 →9821·9822 `13:09:01.497Z` commit2로 끝났습니다. shared collection `pw-chrome-1787576941497-d8391adcb4fbf8b1b208`의 snapshot2는 checked300·official collector/item source·organic-only·`naver_shopping_organic_list`·adExcluded true·excluded30·rank85/not_found·`stable-full-window-v1`·top5 위반0입니다. scheduled claim interval600.343초·claim→terminal82.326초·overlap0, 대표 cursor sort500 내 strict forward·resume false이고 companion sort1400도 같은 collection terminal입니다. cycle36 group/claim/run20=distinct20·tracker29=distinct29·commit29·failure/open0이고 `13:09:59.801290Z` processing0·closed/null·lane/run/lease/stage/job/tracker/probe null·streak54·baseline10입니다.
- `2026-08-24T13:12:50.223061Z` event9822 상한 fully-terminal distinct group/claim/run54/54/54=success53+typed partial1·open0입니다. anchor→observed7.692506302h=`7.019818753 group/h`, first claim→latest terminal7.522896944h=`7.178085836 group/h`, snapshot65/collection53입니다. checked300·official source/item·pw-chrome·organic policy/evidence·adExcluded·matched/top5 위반과 same-cycle group/tracker duplicate excess는 모두0입니다. remote wake 영향 포함 baseline10 pre-candidate라 candidate8 성능이 아닙니다.
- event9827 `13:17:38.853Z` group(normal/member4) →9828~9831 tracker4 →9832~9835 `13:18:22.268Z` commit4는 run `d501c3e6-f4f2-4138-9f96-f849f47048c0`, collection `pw-chrome-1787577502268-c706b1f44a66ffa81a6a`입니다. 직전 claim 간격599.682초·claim→terminal43.415초·overlap0입니다. snapshot4는 checked300·official collector/item source·organic-only/evidence·adExcluded true·excluded45·rank8/48/5/22이고 top-item20개의 광고/비오가닉 위반0입니다. cursor `(500,2026-07-08…,97e5…)→(500,2026-07-10…,4722…)` strict forward·resume false, cycle36 group/claim/run21/21/21·tracker/commit33/33·failure/open/중복/orphan0, terminal 뒤 processing/lane/run/lease/stage/job/tracker/probe null입니다.
- `2026-08-24T13:25:10Z` event9835 고정벽은 fully-terminal55=atomic success54+typed partial1·open0, anchor→observed `6.963775 group/h`, first claim→observed `7.058576 group/h`입니다. 최신 terminal 기준도 `7.065103`·`7.162702 group/h`로 baseline10 사전값이며 8.75~8.77보다 낮습니다. exact identity·streak55·closed/null·processing0·완전 idle이지만 anchor24h가 false라 candidate8 RPC는0회입니다. 잔여 partial 2건은 각각 `15:33:02.119249Z`·`19:18:58.276397Z` 격리 만료 전이고 post-anchor claim/terminal0·legacy snapshot58/71 보존 상태입니다.

## 2026-08-22 N쇼핑 v1.1.11 오류 분류·raw 경계 배포 체크포인트

- RED 재현: page timeout·commit unavailable의 bounded half-open 누락, half-open release의 tracker-only terminal 불일치, lookup submit/reconcile ambiguity의 system scope, submit 전후 Supabase raw 오류와 outer catch 누출을 각각 실패 테스트로 고정했습니다.
- GREEN: N30 집중 289/289, collector 64/64, worker 68/68(line 90.94%, branch 69.21%, functions 89.47%), handler 77/77(line 89.99%, branch 65.70%, functions 95.92%), migration/cycle 27/27, server contract 65/65, release baseline `ok:true`, syntax·diff 검사가 통과했습니다. 전체 `npm run check:release`도 core743·place51·shopping64·Production auth18 전부 PASS, public build 9파일·6 inline script·4 CSP hash PASS입니다. 기존 파일 전체 branch 80%라고 과장하지 않습니다.
- `20260821180001_naver_shopping_error_taxonomy_hardening.sql`은 claim/block/failure/release 4 RPC를 `security invoker`, 빈 `search_path`, service-role-only로 유지합니다. `20260821180002_naver_shopping_runtime_1_1_11.sql`은 1.1.10의 atomic300·processing0·identity reset·24시간+6회 계약을 version 외 byte-for-byte 보존합니다. 보호 잠금 23함수·95파일·44 migration 및 self-test 통과를 확인했습니다.
- 운영 SELECT-only 2026-08-22 12:17:48 KST: runtime1.1.10/fingerprint `70b5ce8d…a297ba`, primary heartbeat 11초, active74·paused0·quarantine3·processing0, circuit closed·cadence10·candidate false, lane/run/lease null입니다. event7121 `native_host_input_closed` 뒤 event7123~7125와 7127~7129가 각각 checked300 commit으로 끝났고 snapshot 미확인 상태를 성공으로 쓰지 않았습니다.
- 검증된 commit `eeba518ecfa2398b085ce26a73623d13b62c95f9`을 GitHub `main`에 push했고 Production `/health`·`/ready`의 release `eeba518ecfa2`와 Supabase ready 일치를 확인했습니다. migration `20260821180001_naver_shopping_error_taxonomy_hardening`과 `20260821180002_naver_shopping_runtime_1_1_11` 적용도 각각 성공했습니다.
- migration 후 최초 SELECT-only 값은 runtime1.1.10, `stability_started_at=null`, success streak0, cadence baseline10, candidate false, circuit closed, processing0, lane/run/lease null이었습니다. 과거 proof를 상속하지 않는 fail-closed 초기화를 확인한 뒤 Windows updater를 실행했습니다.
- Windows 실기 검증은 version `1.1.11`, service-worker SHA-256 exact=true(`a0ef00195d6f573fd9ef418ed8e47f5b322365b707764372bdb599d279cc713c`), native host `co.kr.momentinsight.naver_shopping`, registry exact=true, 예약 작업 enabled/running을 반환했습니다. 운영 heartbeat도 runtime1.1.11과 fingerprint `6461e835e840ff873711f38a223ab1a7a06b3e2945822a92cce49e50a295cf00`을 정확히 보고했습니다.
- 첫 자연 run `01fceb68-4557-48ac-8c9c-4d7ff964a4eb`은 event7131 group claim → 7132 tracker claim → 7133 commit으로 종료됐습니다. collection `pw-chrome-1787374619637-b90cb4f65cbd4d4926ad`과 snapshot 1행은 checked300·official collector·organic_only·adExcluded=true·excludedAds45·stable-full-window이고 tracker processing/lease·last_error·retry·quarantine는 모두 해제됐습니다. 이 성공이 새 anchor `2026-08-22T04:57:00.265984Z`를 만들었습니다.
- 두 번째 run `a327119e-4b09-48f8-b613-8dd914fdf52b`은 event7135→7137로 terminal 완료됐습니다. collection `pw-chrome-1787374867874-72715ebda704213a085c`, snapshot `c623fd5d-13c2-4664-9c8c-e96f14d556f4`는 checked300·official collector·organic_only·adExcluded=true·excludedAds45·stable-full-window이며 rank22입니다. cycle #28 group 46/46·tracker 59/59 distinct, terminal 중복0, cursor sort2200→2300 순방향, terminal 뒤 circuit closed·cooldown null·processing/lane/run/lease null입니다. 당시 streak2·candidate false·baseline10이고, anchor+24시간인 `2026-08-23 13:57:00.265984 KST` 전에는 candidate8을 활성화하지 않습니다. 업데이트 전 과거 ledger 미완결 2건 때문에 cycle 전체 terminal linkage가 완전하다고 확대하지 않습니다.
- 세 번째 run `9220f034-8ec3-472a-bd15-831d5de2711a`은 event7139→7141로 종료됐고 collection `pw-chrome-1787375100179-465541e9cd8ad74dd994`, snapshot `8210a75c-81f4-4100-bcc7-83635ad9681a`가 checked300·official collector·organic_only·adExcluded=true·excludedAds45·stable proof·rank28을 기록했습니다. cycle group47/47·tracker60/60 distinct, cursor sort2300→2400 순방향, terminal 뒤 processing0·lane/run/lease null·circuit closed, streak3·candidate false입니다.
- 2026-08-22 14:40 KST SELECT-only 재검증은 runtime1.1.11/fingerprint exact, heartbeat 정상, anchor `04:57:00.265984Z`, streak7, baseline10, candidate false를 반환했습니다. latest run `58d01a9a…`는 event7161 group claim → 7162 tracker claim → 7163 commit, collection `pw-chrome-1787377221042-46d7650de64fff03193a`, checked300·official collector·organic_only·adExcluded=true·excludedAds30·rank57입니다. anchor 뒤 snapshot8의 non300/source/adExcluded/matched-organic 위반은 모두0이고 cycle group51=distinct51·tracker66=distinct66, terminal 뒤 circuit closed·cooldown null·processing/lane/run/lease null입니다. active74·paused0·격리3이며 partial 자연 만료는 16:00·18:50·19:00 KST라 실재수집은 아직 미확인입니다.
- docs checkpoint `267a9c21ed5e` push 뒤 15:08 KST Production `/health`와 `/ready`는 같은 release·live·Supabase ready를 반환했습니다. 기능 변경 commit `eeba518`은 이 release의 ancestor이며 docs-only 후속 커밋에서 런타임 파일 변경은 없습니다.
- 15:25 KST SELECT-only 재검증은 runtime1.1.11/fingerprint exact, heartbeat 12초, anchor `2026-08-22T04:57:00.265984Z`, streak12, baseline10·candidate false를 반환했습니다. anchor 뒤 snapshot13/collection11/commit13, checked300·official source·organic-only·adExcluded 위반0, failure0입니다. cycle #28 group56=distinct56·tracker71=distinct71로 중복0이고 active74·paused0·격리3·processing0, circuit closed·cooldown null·lane/run/lease null입니다. anchor 이전의 input-close 1건과 만료 claim 1건을 숨기지 않으며 anchor 뒤에는 열린 claim이 없습니다.
- 새 candidate DB gate는 먼저 exact fingerprint/완전 idle/heartbeat/최근 성공/baseline10 요구 테스트를 RED로 고정한 뒤 `20260822061741_naver_shopping_candidate_exact_identity_gate.sql`로 GREEN을 만들었습니다. `mi_get_naver_shopping_worker_operations`와 `mi_set_naver_shopping_worker_cadence`만 SECURITY INVOKER·빈 search_path·service-role-only로 교체하며, setter는 coordination `FOR UPDATE` 뒤 processing lease를 세어 candidate 전환을 원자화합니다. exact runtime fingerprint `6461e835…95cf00`, Windows primary 3분, 최근 atomic success 15분, 24시간·6회, baseline10, circuit/reason/cooldown/probe/run/stage/lease 전부 해제를 두 predicate에 동일하게 요구하고 anchor/streak DML은 없습니다.
- 실행값: 의도한 RED 0/1 → GREEN targeted1/1, durable migration16/16, 관련 N30 집중290/290, server contract66/66, release baseline true, 보호 잠금23함수·96파일·45 migration+self-test PASS, `git diff --check` PASS입니다. 전체 `npm run check:release`도 main744/744·place51/51·shopping64/64·public build 4 unique CSP hash·production auth18/18로 PASS했습니다. Production에서 같은 SQL을 먼저 `ROLLBACK`으로 실행해 PostgreSQL 구문/함수 생성/권한 구문을 검증했고 영구 변경0을 확인한 뒤 적용했습니다.
- commit `ea27672`(RED)·`f8a8ce8`(GREEN)을 push했고 Production `/health`·`/ready` release `f8a8ce8eed0e`, live·Supabase ready를 확인했습니다. 적용 직전 06:33:03Z exact runtime/fingerprint·heartbeat27초·processing0·lane/run/lease null이었고, migration `naver_shopping_candidate_exact_identity_gate` 적용 성공 및 운영 migration 목록 존재를 확인했습니다. 운영 함수는 exact fingerprint/heartbeat/최근성공/baseline/완전 idle gate 포함, `prosecdef=false`, `search_path=""`, anon/auth execute=false, service_role=true입니다. 적용 후 anchor `04:57:00.265984Z`·streak13이 그대로이고 cadence baseline10·candidate false이며, 새 24시간 증거를 초기화하지 않았습니다. Supabase advisors는 기존 security15·performance66으로 신규 WARN0입니다.
- 적용 후 첫 자연 run `39a02312…`/claim `344b2e0b…`은 06:39:42→06:40:27Z event group1→tracker2→commit2로 terminal 됐습니다. shared collection `pw-chrome-1787380827140-d8b0a5b42e090c8690e5`, snapshot2/2 모두 checked300·official collector·organic_only·naver_shopping_organic_list·adExcluded=true·excludedAds30이며 rank85/125입니다. cycle29 group/tracker/terminal 중복0, open claim/failure0, same-sort cursor 순방향입니다. terminal 뒤 processing0·lane/token/lease/run/stage/job/tracker/probe null·circuit closed/cooldown null, anchor 불변·streak14·baseline10·candidate false를 SELECT-only로 확인했습니다.
- partial#1 `c0ccded2…`(아이쉘 차량용 거치대)은 16:00:03.261 KST 자연 만료 후 event7290 group_claimed(priority=new, 16:09:42.018)→7291 tracker_claimed→7292 job_failed `provider_partial_window:94_300`(16:10:56.651)→7293 quarantine_set(다음날 16:10:56.766)으로 종료됐습니다. claim→terminal 74.631초, target snapshot 총0/신규0, current/best/worst·last_checked null, check_count/found_count0이라 partial 저장·rank/history 변조0입니다. cycle29 target claim1/group1, 전체 group37=distinct37·tracker50=distinct50로 중복0입니다. 후속 event7295 resume 및 7299 normal sort200 commit으로 cursor 연속성과 lane 해제를 확인했고 circuit closed·cooldown null·processing/lane/run/lease null입니다. runtime 코드상 첫 partial은 폐기 후 full1..8을 1회 재수집하지만 운영 ledger에 pass marker가 없으므로 이번 실운영 증거는 “2-pass 경로와 일치”까지만 판정합니다.
- failure 뒤 첫 정상 atomic300이 안정성 증거를 새로 시작해 운영 coordination의 정확한 anchor는 `2026-08-22T07:19:05.344010Z`, streak32, baseline10, candidate false입니다. earliest candidate는 anchor+24h인 `2026-08-23 16:19:05.344010 KST`로 이동했습니다. anchor 뒤 group/terminal32·tracker/commit42, failure/deferred/open0; snapshot42/collection32의 원자300/source/organic/adExcluded 위반0, 중복·순서 역행·run overlap0입니다. 처리시간 avg57.67초·p50 45.36초·p90 89.30초·max91.15초, fixed-wall 처리량7.08 group/hour로 측정되어 기존 8.75~8.77 대비 향상 증거가 아니며 candidate8 성과로 사용하지 않습니다.
- 20:46 KST SELECT-only 기준 잔여 partial 2건은 격리 만료 뒤에도 claim/terminal0·신규 snapshot0입니다. cycle #29 시작 때 quarantined roster로 고정됐고 현재 cursor sort1700 이후 자연 순번을 기다립니다. `칼슘단백쌀`은 기존 legacy checked40/rank1, `키크는쌀`은 checked41/rank null을 그대로 유지하며 processing/lane/run/lease/stage/probe null·circuit closed·cooldown null입니다. 아직 실행되지 않았으므로 2-pass 회복으로 세지 않습니다.
- 20:55 KST SELECT-only checkpoint: exact runtime/fingerprint·heartbeat 정상, anchor `16:19:05 KST`, streak34, candidate false입니다. anchor 이후 snapshot43/collection33의 checked300·official source·pw-chrome·organic policy/evidence·adExcluded·matched/top-item 위반0, cycle #29 group40=distinct40·tracker53=distinct53·run/terminal 중복0·미종료 claim0·cursor 역행0입니다. fixed-wall 34group/4.596h=`7.397 group/hour`로 기준선 미달입니다. 잔여 partial 2건은 만료 후 event/snapshot0이며 cursor 앞 17개 group terminal/defer 뒤 fallback 1·2번째로 진입할 현재 조건입니다.
- 21:02 KST SELECT-only 재검증은 exact identity·heartbeat, anchor 경과4.723h·streak35·baseline10·candidate false를 반환했습니다. anchor 뒤 snapshot44/collection34·group34·tracker/commit44·failure0이며 checked300/source/pw-chrome/organic/adExcluded/top-item 위반0입니다. cycle #29 group41=distinct41·tracker54=distinct54·terminal54=distinct54·run41=distinct41, open claim/overlap/cursor 역행0입니다. terminal 뒤 processing0·lane/run/lease/stage/probe null, circuit closed·cooldown null입니다. fixed-wall `7.410507 group/hour`로 개선 증거가 아니며 두 잔여 partial은 v1.1.11 claim/terminal/snapshot0 상태입니다.
- 다음 자연 run event7465 group→7466 tracker→7467 commit은 21:09:42~21:10:26 KST에 terminal 됐습니다. snapshot `e921114c…`/collection `pw-chrome-1787400626274-7de87eabe25409afe615`은 checked300·official collector·organic_only·organic evidence·adExcluded=true·excludedAds30, top5 isOrganic=true/isAd=false입니다. cursor는 같은 sort1900의 더 최신 tracker로 전진했고 cycle29 group42=distinct42·run42=distinct42·tracker55=distinct55, 해당 claim event 각1입니다. terminal 뒤 processing0·lane/run/lease/probe/cooldown null·circuit closed, streak36·candidate false입니다.
- event7469→7471은 21:19:42~21:21:10 KST에 snapshot `8e729f87…`/collection `pw-chrome-1787401270198-122004826fc8ef0d10b3`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·excludedAds30, top5 광고/비오가닉0으로 commit했습니다. cursor sort1900→2000, cycle29 group/run43=distinct43·tracker/terminal56=distinct56, failure0입니다. terminal 뒤 processing0·lane/run/lease/probe/cooldown null·circuit closed, streak37·candidate false입니다. 미처리 group16 중 partial 2건은 wrap1·2, 전체15·16번째이며 아직 claim/terminal/snapshot0입니다.
- event7473→7475는 21:29:43~21:30:24 KST collection `pw-chrome-1787401824933-c000972ef91c68832ad7`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·excludedAds30으로 commit했습니다. cursor sort2000→2100이고 cycle group/claim/run/tracker/terminal 중복0입니다. terminal 뒤 tracker/lookup processing0·lane/run/lease/stage/probe null·circuit closed, streak38·candidate false입니다. 미처리 group15=`ahead13+fallback2`; partial은 전체14·15번째이며 claim/terminal/snapshot0입니다.
- event7477→7479는 21:39:43~21:41:07 KST snapshot1/collection `pw-chrome-1787402467184-719f38bdd93f560145a4`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·stable proof로 commit했습니다. cursor는 sort2100 내 created_at 순방향, cycle group45=distinct45·tracker58=distinct58·terminal58=distinct58·open0입니다. terminal 뒤 processing0·lane/run/lease/probe null·circuit closed, streak39·candidate false입니다. 잔여 group14=`ahead12+fallback2`; partial은 전체13·14번째이고 여전히 claim/terminal/snapshot0입니다.
- event7481→7483은 21:49:43~21:51:15 KST snapshot1/collection `pw-chrome-1787403075058-59872a060c9b0f8f2946`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·stable proof·excludedAds45로 commit했습니다. cursor sort2100→2200 순방향, cycle group46=distinct46·tracker59=distinct59·terminal59=distinct59·open0입니다. terminal 뒤 processing0·lane/run/lease/stage/tracker null·circuit closed·cooldown null, streak40·baseline10·candidate false입니다. 잔여 group13=`ahead11+fallback2`; partial은 전체12·13번째이며 claim/terminal/snapshot0입니다.
- event7485→7487은 21:59:43~22:01:12 KST snapshot1/collection `pw-chrome-1787403672031-b3e5ef45117c7b185a02`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·stable proof·excludedAds45로 commit했습니다. cursor sort2200→2300 순방향, cycle group47=distinct47·tracker60=distinct60·terminal60=distinct60·open0입니다. 22:00:29 KST 중간 관측은 page7·processing1·lane/run/lease 활성이라 terminal 해제 증거로 사용하지 않았고, 22:02:03 KST 재조회에서 processing0·lane/run/lease/stage/tracker null·circuit closed·cooldown null을 확인했습니다. streak41·baseline10·candidate false이며 잔여 group12=`ahead10+fallback2`; partial은 전체11·12번째로 claim/terminal/snapshot0입니다.
- event7489→7491은 22:09:43~22:11:07 KST snapshot1/collection `pw-chrome-1787404267275-af4bc4b30de0fc3f106e`을 checked300·official collector·organic_only·organic evidence·adExcluded=true·stable proof·excludedAds45로 commit했습니다. cursor sort2300→2400 순방향, cycle group48=distinct48·tracker61=distinct61·terminal61=distinct61·open0입니다. terminal 뒤 processing0·lane/run/lease/stage/tracker null·circuit closed·cooldown null, streak42·baseline10·candidate false입니다. 잔여 group11=`ahead9+fallback2`; partial은 전체10·11번째로 claim/terminal/snapshot0입니다.

## 2026-08-21~22 N쇼핑 v1.1.10 partial 재수집·input-close 복구 로컬 증거

- 운영 v1.1.9 cycle #27은 roster74, group claim59=distinct59, tracker claim74=distinct74, commit70, typed failure4, deferred0으로 완료됐고 같은 cycle 중복은 0입니다. 네 실패는 `native_host_input_closed` 1건과 `provider_partial_window` 92·137·30건이며 실패 snapshot은 0입니다. 뒤 cycle #28은 21:40 KST까지 group18=distinct18·tracker25=distinct25·commit25·failure0으로 진행했습니다.
- `native_host_input_closed`는 실제 1회 사건 뒤 11분 만에 다른 tracker atomic300이 이어졌지만, 기존 자동 복구 allowlist에는 없어 연속 2회 circuit open 시 영구 정지 위험이 있었습니다. 신규 additive migration은 이 정확한 code만 기존 eligibility IF와 guarded UPDATE 두 곳에 추가하며 primary-only·30분 quiet·최대2회·service-role-only를 유지합니다. 전용 RED 6/7→GREEN 7/7, 함수 exact-delta와 security/network 제외를 확인했습니다.
- partial-window 재수집 신규 4개는 기존 코드에서 모두 RED였고, 구현 뒤 4/4 GREEN입니다. 첫 partial pass 폐기, 독립 full 1..8 1회, 두 번째 strict300만 반환, double-partial 최신 count, partial→overlap page-budget, deadline guard, no-third를 실행했습니다. native/local/migration/handler/Windows 결합 집중 회귀는 264/264 PASS이며 native core line 90.36%·function 94.74%입니다.
- runtime `1.1.10` additive migration은 적용 시 및 identity 변경 시 cadence10·stability null·streak0으로 초기화하고 exact1.1.10·atomic300·processing0·24시간+성공6회를 새로 요구합니다. immutable 1.1.9 migration을 1.1.10으로만 치환한 exact clone이며 기존 1.1.9 SHA는 불변입니다. 관련 240/240, Windows 11/11, server contract 63/63, release baseline, 보호 잠금 23함수·93파일·42 migration+self-test가 통과했습니다. 전체 `check:release`도 core 694/694·place 51/51·shopping 62/62·Production auth 18/18, public build 9파일·인라인 6개·고유 CSP hash 4개, diff-check PASS입니다.
- 정확 commit `cdcd6c2c21e6`의 clean worktree에서 전체 release exit0을 재확인하고 Production·두 migration·Windows updater를 순서대로 반영했습니다. 운영 heartbeat는 runtime `1.1.10`, 저장소 재계산과 같은 fingerprint `70b5ce8d…a297ba`입니다.
- 첫 자연 run `d92641ae…`는 event 7034 normal group claim → 7035 tracker claim → 7036 tracker commit으로 terminal 완료했습니다. snapshot `pw-chrome-1787319166244-359a9497dd9e9af25c62`은 checked300·official source·adExcluded true·excludedAds30·organic evidence·stable proof이고, terminal 뒤 cadence10·stability 22:32:47 KST·streak1·circuit closed·processing/lane/run/lease 0입니다. partial 격리 3건의 실제 재수집 성공은 아직 증거가 없어 완료로 보고하지 않습니다.
- 후속 run `64becc7b…`는 event 7039→7043에서 tracker 2건을 같은 collection `pw-chrome-1787319604352-3087bb267719dd130a14`로 각각 atomic300 commit했고, `4b795457…`는 event 7045→7047·collection `pw-chrome-1787319778128-9d21d7bc648bd9807dde`로 atomic300 commit했습니다. 22:50 KST `tracker-sync-due` wake 뒤 추가 run도 atomic300으로 terminal 완료했습니다. 누적 streak4, same-cycle 중복0, circuit closed·processing/lane/run/lease 0입니다. claim 간격은 8분05초·2분53초·8분09초였으나 DB는 baseline10·candidate false이고 trigger 장부가 완전하지 않아 8분 후보 작동 증거로 사용하지 않습니다.
- 2026-08-22 00:09:45 KST cycle #28은 roster74, group claim37=distinct37, tracker claim50=distinct50, commit50, failure/deferred0이며 group·tracker·terminal 중복과 claim/terminal 누락·선행은 모두 0입니다. 9/9 agency가 commit됐고 cursor는 sort1700 안의 다음 tracker입니다. stability anchor 뒤 normal group15·tracker commit17·snapshot17/collection15의 checked300/source/pw-chrome/organic evidence/policy/adExcluded 위반은 0입니다. success streak16이나 24시간은 미경과라 `candidate_eligible=false`, cadence baseline10이며 terminal 뒤 circuit closed·processing/lane/run/lease null입니다.
- 과거 `native_host_input_closed` tracker `9baddbf8…`는 event 7084 normal group claim → 7085 tracker claim → 7086 commit으로 자연 회복했습니다. collection `pw-chrome-1787322915600-2306f6e54b9d9e5e36ea`은 checked300·official source·adExcluded true·광고30개 제외·organic_only이며, matched=false를 정상 terminal로 저장했습니다. 실패 기간의 기존 atomic300 snapshot은 보존됐고 성공 뒤 `last_error=null`, retry0, processing/quarantine null, lane/run/lease null입니다. 이는 단일 input-close의 순서 재진입·회복 증거이며 연속 2회 뒤 half-open 전이 실증으로 확대하지 않습니다. partial 3건은 2026-08-22 16:00:03·18:50:02·19:00:00 KST까지 격리돼 v1.1.10 이후 claim·commit·failure·snapshot·quarantine clear가 모두 0입니다. 두 건의 과거 snapshot은 checked40·41인 legacy 자료이므로 atomic300 회복 증거가 아니며 2-pass 실운영 회복은 아직 미확인입니다.
- 후속 event 7088→7090은 대상 재claim 없이 다음 `맥세이프 거치대` tracker `1c050467…`를 collection `pw-chrome-1787323510299-44e1b333ca6591876be7`로 checked300 commit했습니다. 대응 snapshot 1행, group·tracker·terminal 중복 0, failure/deferred 0이며 cursor는 같은 sort1500의 더 최신 tracker로 전진했습니다. 종료 뒤 global lane/run/stage/current tracker와 tracker processing lease는 모두 null이고 circuit closed입니다.
- event 7092→7094는 직전 group claim에서 정확히 10분 뒤 다음 normal tracker를 claim해 collection `pw-chrome-1787324113299-685403082e12870e63b8`을 checked300·official source·organic_only·adExcluded true·광고60개 제외로 commit했습니다. snapshot 1행, run group/tracker/commit 각1·failure0이며 terminal 뒤 success streak14·processing/lane/run/lease null입니다.
- event 7096→7098은 직전 claim에서 600.249초 뒤 시작해 `스팀청소기`를 collection `pw-chrome-1787324756951-a553acbb91ec99d0458d`로 checked300·official source·organic_only·adExcluded true·광고45개 제외·14위 commit했습니다. 첫 trigger명은 장부에 없어 간격만 baseline10 증거로 사용합니다. 앞 terminal 뒤 `rank-cron-cycle` wake가 요청·소비된 event 7100→7102도 `차량용 핸드폰 거치대`를 별도 collection `pw-chrome-1787324828563-70b4eedce9bb5d8bcda2`로 checked300 commit했습니다. 두 run은 겹치지 않았고 group/tracker/commit 각1·failure0, 최종 streak16·processing/lane/run/lease null입니다.
- 배포 후 Supabase advisor는 security ERROR0/WARN2, performance ERROR0/WARN23으로 기존 전역 WARN 수와 같고 이번 두 N30 migration의 신규 WARN은 0입니다. N30 service-role-only 테이블의 no-policy 항목과 새 조회 인덱스의 미사용 항목은 INFO이며 배포 차단으로 세지 않습니다.

## 2026-08-21 N쇼핑 v1.1.9·5차 속도 개선 운영 초기 증거

- 개선 전 운영 SELECT-only: runtime `1.1.8` exact fingerprint, heartbeat 정상, circuit closed, lane·run·lease null, active 74·paused 0·processing 0·격리 3입니다. 최근 24시간 258 snapshot의 checked300/source/organic/adExcluded 위반은 0이고 group 처리시간 avg 58.11초·p50 44.95초·p90 86.90초·max 91.22초, wall 처리량 8.75~8.77 group/hour입니다.
- TDD focused 실행은 163/163 PASS입니다. 여기에는 >100 tracker 동일 keyword의 cycle당 수집 1회·회전 deferred, submit 응답 유실 exact reconcile, transient timeout/deadline half-open 최대2회, remote no-wake probe 보존, claim-response-loss 장부 guard, runtime 1.1.9 gate와 candidate 승격 시 active processing lease 0 조건이 포함됩니다.
- cadence/init 87/87 PASS입니다. 실패 뒤 첫 explicit atomic success부터 24시간+6회, idle 증가 0, storage/alarm read·write·create·clear 실패, 서비스워커 새 VM, 강제종료·stale running·generic failure overwrite, old 1.1.8 proof와 same-version 다른 SHA 거부를 동적으로 실행했습니다.
- `node --check` 관련 6개, server contract 61/61, release baseline 171/171, `git diff --check`가 통과했습니다. 변경 범위 cadence/init branch-range coverage는 117/144=81.25%, 함수 11/11입니다. 기존 local-worker 전체 파일은 line 89.24%·branch 67.56%·function 89.19%라 전체 branch 80%로 과장하지 않습니다.
- 보호 잠금 23함수·91파일·40 migration과 self-test, 전체 `npm run check:release`가 정확한 commit `628e4ae0b2a9`의 깨끗한 worktree에서 exit 0으로 통과했습니다. 같은 commit이 Production `/health`·`/ready`와 Windows updater release로 일치합니다.
- 운영 migration 목록에 `naver_shopping_cycle_keyword_overflow`, `naver_shopping_transient_system_half_open`, `naver_shopping_runtime_1_1_9`가 모두 존재합니다. runtime migration 직후 exact fingerprint `b89dcd5b…b9832`, cadence10, stability null, streak0, candidate false, circuit closed, processing0, lane/run/lease null을 확인해 1.1.8 proof 상속이 없음을 증명했습니다.
- 기준 뒤 별도 wake 요청이 없던 첫 `normal` run `a5d6f1a1-b17c-407c-b261-1ca4b67162ba`는 event 6701 group claim → 6702 tracker claim → 6703 commit으로 종료됐습니다. collection `pw-chrome-1787291671198-58f940f60934ff318d08`, 공식 collector, organic evidence/policy, adExcluded=true, 광고 30개 제외, checkedCount 300, rank 27이며 snapshot·ledger가 일치합니다. ledger에는 알람 trigger명이 없어 trigger 종류 자체는 단정하지 않습니다. 종료 뒤 stability 14:54:31 KST·streak1·candidate false·cadence10, processing/lane/run/lease null입니다.
- 15:00:00~15:01:28 KST run `4460c552-afb1-40d7-8463-ca1011f6e0dc`는 event 6705 group claim → 6706 tracker claim → 6707 commit으로 종료됐습니다. collection `pw-chrome-1787292087822-95262b63bfac50c24be7`은 checkedCount 300, 공식 collector·organic/adExcluded=true, 광고 30개 제외, `stable-full-window-v1`이며 민감 proof 세부값은 저장하지 않았습니다. 종료 뒤 streak2·candidate false·cadence10, circuit closed, processing/lane/run/lease null입니다.
- 15:02:39~15:03:25 KST run `c8f01d0b-3de4-4ffa-9d3c-658d2f07d6da`는 같은 keyword group의 tracker 2개를 collection `pw-chrome-1787292205331-e8530fcbae4a3f45aa89` 하나로 각각 checked300 commit했습니다. 15:03:46~15:05:13 KST run `123bdacc-8b60-46da-8406-e433d221ea44`도 stable proof·광고45 제외·checked300으로 끝났습니다. 두 run은 시간상 겹치지 않았고 마지막 terminal 뒤 90초 동안 새 run 0건이었습니다. cycle #27 group 31=distinct31, tracker 44=distinct44, commit44, failure0, streak4이며 terminal 상태는 circuit closed·processing/lane/run/lease null입니다.
- runtime 이후 cycle #27 최종 장부는 roster74, group claim59=distinct59, tracker claim74=distinct74, commit70, typed failure4, deferred0, cycle complete1입니다. 네 실패는 15:19 `native_host_input_closed`, 16:00 `provider_partial_window:92_300`, 18:50 `:137_300`, 18:59 `:30_300`이며 실패 tracker의 새 snapshot은 없습니다. cycle #28은 19:09 시작 뒤 21:40까지 group18=distinct18·tracker25=distinct25·commit25·failure0입니다.
- 21:47 KST 기준 runtime 이후 snapshot 56행/46 collection은 non300·source·rankEvidence·rankPolicy·adExcluded 위반이 모두 0이고 stable proof 18행, capture/pass/collision digest 저장 0입니다. ops는 runtime/fingerprint exact, cadence10, stability 19:10:08 KST, streak18, candidate false, circuit closed, processing0, lane/run/lease null입니다. active74·paused0·quarantine3이며 partial tracker 3건은 last-good 또는 미검증 상태를 보존한 채 다음날 재시도 대기입니다.
- 이번 v1.1.9 migration 관련 새 security advisor WARN은 없고, service-role-only RLS 테이블의 no-policy INFO와 아직 실행되지 않은 복구용 index unused INFO만 있습니다.
- 24시간+성공6회 이후 candidate8 활성화와 실제 8분 처리량 비교는 아직 미확인입니다. 이 조건 전에는 속도 개선 완료로 판정하지 않습니다.

## 2026-08-21 N쇼핑 30일 추적 비활성 재발 방지 Production 증거

- 운영 SELECT-only: Windows heartbeat 정상, runtime `1.1.8`, fingerprint `182cc973…d49902`, circuit closed, cooldown 없음, lane·run·lease null입니다. 최근 24시간 snapshot 262건은 모두 광고 제외·공식 collector·오가닉 `checked_count=300`이며 위반 0입니다.
- 비활성은 정확히 tracker `1346924b-eb83-45e3-b8bb-4432083a4142` 1건입니다. agency `alstj4492`, keyword `자외선차단마스크`, product `13656510327`, 2026-08-12 17:13 KST부터 paused, `last_checked_at` null, snapshot 0, 동일 활성 대상 0입니다.
- updater native-host 불일치 테스트는 수정 전 11개 중 정확히 1개 실패했고, canonical `co.kr...` 1줄 수정 뒤 11/11 PASS했습니다. paused 동일 대상 재등록은 수정 전 신규 insert 응답 201로 RED였고, 수정 뒤 handler 70/70에서 기존 ID·insert 0·순서/격리/cycle 불변·wake 1회를 확인했습니다. 보호 잠금 23함수·88파일·37 migration, self-test, server contract 58/58, release baseline, 전체 `check:release` 코어 651/651·플레이스 51/51·쇼핑 62/62·Production 인증 18/18이 통과했습니다.
- commit `19756f2` 배포 뒤 `/health`·`/ready`는 release `19756f21ed51`·Supabase ready로 일치했습니다. paused 행 update는 정확히 1행의 `status`만 변경했고 `next_check_at`·sort 3100·cycle/quarantine/lease 값은 그대로였습니다.
- 운영 ledger event 6049 roster→6051 tracker_claimed(`new`)→6052 tracker_committed가 이어졌습니다. collection `pw-chrome-1787242738280-bc36ecf87170e0430f12`, checked 300, 광고 30개 제외, 공식 collector·organic evidence·adExcluded=true이며 snapshot 1개입니다. 미발견 rank null, `last_error=null`, `retry_count=0`, processing/lane/run/lease null, circuit closed, cursor sort 1700 불변을 SELECT-only로 확인했습니다.
- Windows 관리자 PowerShell 실기에서 updater가 `MI_EXTENSION_UPDATE_OK release=981c4fe9cec58c94339042fc20f2ca17ae6990a1 version=1.1.8 loaded_extension_synced=true native_host_registry_synced=true`와 runtime fingerprint `182cc973be96d27a56ba05b50865c57540b5aab8df321f43f22827c269d49902`를 반환했습니다. Chrome 재시작 뒤 heartbeat도 동일 version/fingerprint로 이어졌습니다.
- updater 후 event 6427~6429가 10:28:16~10:29:42 KST 자연 `normal` claim→commit을 기록했습니다. collection `pw-chrome-1787275782763-cb919aa1aeb31aeb178d`는 checkedCount 300, 광고 45개 제외, 공식 collector·organic evidence·adExcluded=true입니다. terminal 뒤 circuit closed, cooldown null, lane·run·lease/current tracker null, paused 0이며 DB·wake·cursor·격리는 조작하지 않았습니다.

## 2026-08-21 매월 반복 종료 방식 Production 증거

- TDD 대상 57/57, 결합 coverage 73/73 PASS입니다. `calendar-domain.mjs` line 96.95%·branch 84.95%·function 100%, `work-items.mjs` line 99.40%·branch 83.85%·function 100%입니다. 유한 종료일 필수, no-end 정확 60회, 월말·윤년, strict boolean, 모순 입력 저장 0, request ID 중복 0을 실행했습니다.
- 전체 `npm run check:release`는 깨끗한 commit worktree에서 코어 636/636, 플레이스 51/51, 쇼핑 62/62, Production 인증 18/18로 exit 0입니다. server contract 58/58, 공개 build 9파일·인라인 6개·고유 CSP hash 4개, N30 보호 잠금 23함수·88파일·37 migration도 통과했습니다.
- 운영 Supabase migration `schedule_monthly_no_end_mode`를 적용했습니다. `recurrence_no_end boolean not null default false`와 일관성 CHECK가 존재하고, 기존 2행·반복 0행·no-end 0행·CHECK 위반 0입니다. 이번 migration이 만든 신규 security advisor WARN은 없습니다.
- commit `a086666` 배포 뒤 `/health`·`/ready`가 release `a086666f62ae`·Supabase ready로 일치했습니다. 로그인된 총관리자 대표실의 실제 등록 패널에서 초기 반복 영역 hidden, 월 반복 ON 뒤 종료일 enabled+required, no-end ON 뒤 종료일 disabled+not-required+빈 값과 60회 한계 문구를 확인했습니다.
- 운영 일정을 임의 생성·수정·삭제하지 않았으므로 Production의 60행 실제 저장·새로고침 보존을 실데이터 E2E로 주장하지 않습니다. 현재 자동 연장 엔진도 없으므로 문자 그대로 무기한 생성된다고 보고하지 않습니다.

## 2026-08-21 대표실 달력 7:3·월 선택 Production 증거

- UI 계약은 기존 4개에서 6개로 확장해 6/6 PASS입니다. 정확한 `7fr:3fr`, 1180px 이하 1열, 월 제목 dialog semantics, 12개월 렌더, 연도 이동, 선택 월 재조회, ESC·포커스 이탈 닫힘을 고정했습니다.
- 전체 `npm run check:release`는 코어 631/631, 플레이스 51/51, 쇼핑 62/62, Production 인증 18/18로 exit 0입니다. server contract 58/58, 공개 build 9파일·인라인 6개·고유 CSP hash 4개, N30 보호 잠금 23함수·88파일·37 migration도 통과했습니다.
- 기능 commit `a451d0a` 배포 뒤 `/health`와 `/ready`가 release `a451d0ac803f`·Supabase ready로 일치했습니다. 로그인된 총관리자 Production 화면에서 실제 너비 달력 773px/가까운 업무 331px, 비율 0.700/0.300을 측정했습니다.
- 월 제목을 눌러 2026년 12개월 팝업을 실제 표시했고, 이전 연도로 2025년 표시→다음 연도→2026년 10월 이동→8월 복귀→ESC 뒤 `aria-expanded=false`를 확인했습니다. 마지막 상태 문구는 `저장된 업무 2개를 불러왔습니다.`이며 일정 저장·수정·삭제는 실행하지 않았습니다.

## 2026-08-20 대표실 개인 일정표 전환 Production 반영

- UI·handler 대상 실행 73/73 PASS: 왼쪽 목록·색상·공유·코드 연결 UI 0, 2열 달력+agenda, 날짜/추가 클릭 개인 등록 패널, 상세 필드·광고주 공개·월간 반복 유지, 공유 action·shared ID 쓰기 0을 검증했습니다.
- `work-items.mjs` 결합 실행은 56/56 PASS, line 99.69%·branch 83.28%·function 100%입니다. 개인 tenant 범위, 서울 날짜, 유한 월간 반복, request ID 중복 방지, optimistic lock, client-safe 공개 응답을 유지합니다.
- 전체 `npm run check:release`는 코어 629/629, 플레이스 51/51, 쇼핑 62/62, Production 인증 18/18로 exit 0입니다. 공개 build는 9개 파일·인라인 script 6개·고유 CSP hash 4개가 일치했고 private artifact·secret signature는 0건입니다.
- N상품·N플레이스 30일 보호 잠금은 23함수·88파일·37 migration으로 통과했습니다. 이번 변경 파일에는 순위 수집기·작업기·스케줄러·순위 migration이 없습니다.
- 운영 Supabase SELECT-only 결과는 calendar 0, membership 0, invite 0, `calendar_id IS NOT NULL` schedule 0, 개인 schedule 2입니다. DB drop·migration rollback·일정 데이터 수정은 수행하지 않았습니다.
- 기능 commit `5ee9907` 배포 뒤 `/health`·`/ready`가 release `5ee99078a22c`·Supabase ready로 일치했습니다. 로그인된 총관리자 대표실 실화면에서 2열 달력+agenda, `내 일정표`·공유 코드·에메랄드 0건, `일정 추가` 팝업과 8월 8일 셀 클릭 시작값 `2026-08-08T09:00`, 매월 반복 1·광고주 공개 1·calendar selector 0, browser warning/error 0을 확인했습니다.
- 확인 과정에서 저장·수정·삭제 버튼은 누르지 않았고 DB 재조회 전후 공유 0행·개인 2행 계약을 유지했습니다. 따라서 레이아웃·팝업은 실증했지만 새 반복 일정을 실제 저장한 Production mutation E2E로 확대 보고하지 않습니다.

## 2026-08-20 대표실 공유 일정표 Production 반영

- 도메인 실행 커버리지는 line 96.30%·branch 81.82%·function 100%입니다. 서울 날짜의 불가능한 날짜 거부, 월말 보정, 윤년, 포함 종료일, 최대 60회·5년 제한, 128-bit 초대 코드와 digest를 실행했습니다.
- handler 결합 회귀는 70/70 PASS이며 `work-items.mjs` coverage는 line 99.82%·branch 80.21%·function 100%입니다. 공유 생성·수정·음성 완료·삭제가 atomic RPC를 사용하고, membership 해제·viewer·광고주 완료 우회·stale timestamp·다른 tenant를 거부하며, 동일 월간 요청의 unique race는 1개 시리즈로 수렴함을 확인했습니다.
- 목록 조회는 현재 월 그리드 42일만 요청하고 한도보다 1건 더 읽어 `truncated`를 명시합니다. 일정이 많을 때 조용히 숨기지 않고 화면에 최대 300개 표시 경고를 냅니다.
- `npm run build:vercel`은 공개 파일 9개, 인라인 script 6개, 고유 SHA-256 4개를 모두 CSP allowlist와 일치시켰고 private artifact·secret signature 0건으로 통과했습니다. 로그인된 Production 총관리자 일정표 실화면도 browser log 0건으로 확인했습니다.
- 전체 `npm run check:release`는 코어 635/635, 플레이스 51/51, 쇼핑 62/62, Production 인증 18/18로 exit 0이며 release baseline·server contract 58/58·역할 parity·N30 보호 잠금/self-test·CSP를 포함합니다.
- 운영 migration 적용 뒤 기존 schedule 2행은 유지되고 새 3테이블은 모두 0행입니다. 새 테이블 RLS는 enabled+forced, anon/authenticated의 4종 DML은 모두 false, 5개 RPC는 definer false·`search_path=""`·service-role execute true·anon/authenticated execute false입니다. 새 calendar 관련 security advisor WARN은 0이며 no-policy INFO는 service-role-only deny-by-default 계약입니다.
- commit `7506f3c` 푸시 뒤 Production `/health`·`/ready`가 release `7506f3c2fa75`, Supabase `ready`로 일치했습니다. 총관리자 로그인 후 대표실의 일정표 목록·공유·월간 그리드·날짜 클릭 등록 패널·매월 반복 포함 종료일을 실제 DOM에서 확인했고 browser log는 0건입니다.
- 운영 calendar/event를 임의 생성하지 않았으므로 총관리자→운영팀 연결 코드 수락, viewer 쓰기 차단, 반복 저장 개수·새로고침 보존은 아직 Production mutation E2E로 주장하지 않습니다. 해당 경계는 로컬 handler·migration 회귀로만 통과했습니다.

## 2026-08-19 N 30일 추적 동결 후보

- 동결 기준 commit은 `bb3c86c6f6f1`이며 N 상품·N 플레이스 30일 핵심 함수 4개, 핵심 파일·작업기·스케줄러와 모든 순위 migration을 hash 잠금합니다.
- `n30Freeze.active=true`·`requires=explicit-user-request`를 release baseline에서 요구하고, 정책·필수 함수·필수 파일 제거를 잠금 self-test가 각각 차단합니다.

## 2026-08-19 N쇼핑 `probe_incomplete` 자동 복구 운영 증거

- 11:20 KST Production SELECT-only: primary heartbeat age 8초, runtime `1.1.8`, fingerprint `182cc973be96d27a56ba05b50865c57540b5aab8df321f43f22827c269d49902`, cycle #20 active·cursor sort 100·resume false, lane/run/current job null이지만 circuit은 `open/probe_incomplete`였습니다. `circuit_opened_at=2026-08-18 22:51:01 KST`, last failure `naver_page_navigation_failed`, 마지막 성공은 22:20:54 KST 원자 300입니다.
- 활성 tracker 집계는 73, stale24 2, stale48 2, never 1, 현재 격리 1, processing 0, expired processing 0입니다. 마지막 정상 snapshot은 source `naver_shopping_results_collector`·오가닉 evidence/policy·광고 제외·checkedCount 300이며 실패 뒤 부분 snapshot 저장 근거는 없습니다.
- 신규 SQL 회귀는 `probe_incomplete`·`probe_interrupted`를 무조건 열지 않고 last failure base가 navigation failure인 primary·lease 없음·10분 경과 조건을 모두 요구합니다. SQL에는 tracker/cursor/quarantine/wake/next_check 변경이 없고 SECURITY INVOKER·빈 search path·service-role-only입니다.
- 로컬 검증: durable migration 10/10, server contract 57/57, release baseline, 보호 잠금 23함수·88파일·37 migration, 잠금 self-test, 전체 `npm run check:release`, `git diff --check` PASS. Production `426637d6b6fa` health/ready·Supabase ready와 migration 목록 반영을 확인했습니다.
- event 4151~4154는 11:26:56 KST normal group/tracker claim 뒤 `provider_partial_window:138_300` fail-closed·snapshot 0·격리입니다. circuit은 `open/probe_incomplete → half_open/auto_navigation_probe → closed`로 복구되고 lane/run/lease를 해제했습니다.
- event 4155~4158의 다음 normal tracker는 11:34:47 KST collection `pw-chrome-1787106886313-64193b6f265405015f18`을 commit했습니다. snapshot 1건은 checkedCount 300, source `naver_shopping_results_collector`, evidence `naver_shopping_organic_list`, policy `organic_only`, adExcluded true, excludedAdCount 30으로 위반 0입니다.
- 복구 뒤 group claim 2=distinct 2, tracker claim 2=distinct 2, commit 1·failure 1이므로 같은-cycle 중복은 0입니다. terminal heartbeat 1.8초, circuit closed, lane/run/current job null이고 cursor가 다음 tracker로 전진했습니다.
- 운영 함수 권한은 SECURITY INVOKER·`search_path=""`, PUBLIC/anon/authenticated execute false·service_role true입니다.

## 2026-08-18 `mml93-a01` 자비스 운영 비서 canary

- 원본 `dashboard/jarvis.html`을 다시 실행해 13명 캐릭터의 자리 호흡, 휴게 이동, 2~3인 회의, 대표의 직원 방문과 대화, 클릭 담당 연결을 확인했습니다. 이 동작을 데이터 없이 정적인 카드만 보여준 이전 배포는 원본 표현 충족으로 보지 않습니다.
- 수정 후보의 실제 로컬 owner 화면에서 비서실장과 광고 담당이 협업 허브로 이동해 대화한 뒤 6명 모두 지정 좌표로 복귀했습니다. 다음 장면의 담당 2인 대화도 확인했고 보고서 담당 클릭은 입력창을 `다음 주 월요일 오전 10시 월간 보고서 최종 검수`로 채웠습니다.
- 390×844 실제 브라우저에서 조직 운영실 299×650, 6명, 이동 상태, document scrollWidth 375로 가로 넘침 0을 확인했습니다. 화면은 모먼트 인사이트 딥네이비 조직 연결선·협업 허브·부서 좌석으로 렌더됐고 console warning/error는 0입니다.
- 대상 owner tool 9/9, API·서버 551/551, 플레이스 51/51, 쇼핑 62/62, role-state·role-query-parity, server contract 56/56, Production 인증 18/18, release baseline, 보호 잠금, public build/CSP, 전체 `npm run check:release`, `git diff --check`가 통과했습니다. 이 문장은 로컬 후보 증거이며 Production 배포나 실제 마이크 권한 허용 증거가 아닙니다.
- 기능 commit `7b7f6c5ee44a` 배포 뒤 Production `/health`·`/ready`가 같은 release·Supabase ready를 반환했습니다. `/admin`·`/client` 200, 비인증 owner tool 401, 정적 owner assistant markup 0, 새 admin inline CSP hash, microphone self·camera disabled를 확인했습니다. 로그인된 Production exact owner의 실제 움직임·마이크 권한은 확인하지 않았습니다.
- 원본 폴더는 README·사용설명서·`dashboard/jarvis.html`·`serve.py`·캐릭터/배경 이미지로 구성되어 있고, 원본 HTML에서 `업무 조직도`, `SpeechRecognition|webkitSpeechRecognition`, `speechSynthesis`, `비서실 사무실`을 확인했습니다. 이전 canary에는 이 조직·음성 DOM과 동작이 없어 전체 이식이 아니었다는 사용자 지적이 사실입니다.
- 보완 후보는 서버 전달 exact-owner HTML에 비서실장 1명+담당 5명 조직도, 마이크·30초 호출 대기·브리핑 읽기 버튼을 포함합니다. 정적 admin/client에는 owner 전용 DOM이 없고, 로그아웃 시 recognition·TTS를 정지하며 텍스트 초안 저장은 계속 명시적 `window.confirm` 뒤 한 번만 수행합니다.
- `Permissions-Policy`는 카메라·위치·결제·USB·화면 공유를 계속 차단하고 마이크만 same-origin 사용자 허용으로 좁혔습니다. 음성 입력은 브라우저 제공 서비스가 처리할 수 있음을 UI에 고지하고, 텍스트 일정 parser에는 외부 AI 호출을 추가하지 않았습니다.
- 검증은 owner assistant 8/8, API·서버 550/550, 플레이스 51/51, 쇼핑 62/62, 역할 상태·query parity, server contract 56/56, Production 인증 18/18, 공개 build/CSP 9파일·인라인 6개·고유 해시 4개, 보호 잠금 22함수·86파일·36 migration, 전체 `npm run check:release`와 `git diff --check`를 통과했습니다. localhost 실화면은 앱 Browser의 `ERR_BLOCKED_BY_CLIENT`로 열리지 않아 조직도 육안 렌더와 실제 마이크 입력은 미검증이며, 자동검사를 실화면 증거로 대체하지 않습니다.
- 고정 시각 `2026-08-18 12:00 KST`에서 `내일 오후 2시 광고주 미팅 1시간`은 8월 19일 14:00~15:00 미팅 초안, `다음 주 월요일 오전 10시 월간 보고서 최종 검수`는 8월 24일 10:00 보고서 초안으로 변환됩니다. 날짜 없는 문장은 저장 초안이 아니라 확인 필요 목록에 남습니다.
- 초안 payload는 `planned`·`internal`만 반환하고 저장 성공 필드를 반환하지 않습니다. exact `mml93-a01` owner는 200, 다른 owner 코드와 non-owner는 403이며 handler에는 OpenAI·Claude·Anthropic 호출이나 새 DB 쓰기가 없습니다.
- 서버 전달 HTML은 script/iframe/object/inline handler 0건이며 admin/client 정적 markup의 `owner-assistant` 메뉴·view는 0건입니다. 실제 저장 버튼은 `window.confirm` 뒤 기존 tenant-scoped `/api/work-items` POST를 정확히 한 번 호출하는 계약으로 고정했습니다.
- 검증: owner tool 7/7, API·서버 549/549, 플레이스 51/51, 쇼핑 62/62, role-state, role-query-parity, server contract 56/56, Production 인증 18/18, release baseline, rank feature lock, Vercel build·공개 CSP 9파일/인라인 6개/고유 해시 4개, 전체 `npm run check:release`, `git diff --check` 통과.
- 기능 commit `782e9f6a7e20` 배포 뒤 2026-08-18 18:46 KST `/health`·`/ready`가 같은 release와 Supabase ready를 반환했습니다. `/admin`·`/client`는 200, 비인증 `/api/owner/tool`은 401이고 두 정적 페이지의 owner-assistant DOM은 0입니다. 이는 배포·비노출·인증 경계 증거이며, 로그인된 `mml93-a01`에서 초안과 내부 일정 1건 저장·새로고침 보존을 확인한 증거는 아닙니다.
- 조직·음성 보완 commit `df4089405a77` 배포 뒤 2026-08-18 19:06 KST `/health`·`/ready`가 같은 release와 Supabase ready를 반환했습니다. `/admin`·`/client` 200, 비인증 `/api/owner/tool` 401, 정적 owner-assistant DOM 0이며 Production 응답은 `microphone=(self)`와 `camera=()`를 함께 반환합니다. 이는 다른 역할 비노출·인증·헤더 경계 증거이며, 로그인된 exact owner의 실제 마이크 권한 허용·음성 결과·조직도 육안 렌더를 확인한 증거는 아닙니다.

## 2026-08-15 v1.1.8 운영 반영·실증

- cycle #9 event 591~602와 완료 집계는 roster 57 group/72 tracker/9 agency, 시작 시 격리 1 tracker, 실제 claim 56 distinct group/71 tracker/9 agency, group claim event 56=distinct 56을 기록합니다. 성공 31 group/42 snapshot/31 collection은 atomic300 위반 0이며 실패 25 group은 duplicate 23·navigation 2, snapshot 0입니다. terminal은 circuit closed·processing 0·lane/run/lease null입니다.
- stable full-window 회귀는 첫 full 1~8페이지와 독립 second full 1~8페이지의 절대 순위 1~300, 강한 identity, product type, linked catalog digest가 일치할 때만 cross-page 반복 슬롯을 그대로 승인합니다. 한 슬롯 drift·capture replay·proof 누락/위조·17번째 페이지·deadline 초과는 submit 없이 fail-closed하고 skip·dedupe·rank compression은 0입니다.
- 서버는 HMAC submit 뒤 proof schema와 window/collision digest를 독립 재계산합니다. 성공 snapshot·ledger에는 `stable-full-window-v1` 버전만 남고 capture ID·pass digest·collision digest는 남지 않는 테스트를 통과했습니다. proof 불일치는 tracker 범위·30분 quarantine이며 half-open global circuit은 닫힌 상태를 유지합니다.
- 관련 회귀 270/270, local/server worker 93/93, server contract 55/55, baseline, 보호 잠금 22함수·86파일·36 migration, 전체 `npm run check:release`와 `git diff --check`가 통과했습니다. 이 문장은 11:31 KST 실운영 proof가 생기기 전 배포 기준입니다.
- 기능 release `68e6200ad826` 반영 뒤 11:35 KST Production `/health`·`/ready`는 당시 증거 문서 release `9816cfa3c645`·Supabase ready로 일치했습니다. 이후 증거 문서 커밋은 `/health` 식별을 이동시킬 수 있으므로 기능 바이트는 Windows fingerprint로 별도 검증합니다. migration 목록은 runtime/ledger/quarantine 세 건을 기록하며, pg_proc 검증은 public 5함수 SECURITY INVOKER·빈 search path·postgres/service_role 전용, internal snapshot trigger SECURITY DEFINER·빈 search path·postgres 전용을 확인했습니다.
- Windows updater 이후 DB heartbeat는 runtime `1.1.8`, fingerprint `182cc973be96d27a56ba05b50865c57540b5aab8df321f43f22827c269d49902`이며 저장소의 service worker+12 runtime 파일 재계산값과 같습니다. 첫 natural collection `pw-chrome-1786760448382-cfebd786a0e78f00d434`은 checkedCount 300·광고 30개 제외·terminal lane/lease null입니다.
- 11:24 KST 당시 cycle #10 SELECT-only 집계는 5 claim event=5 distinct group, 6 agency, snapshot 5/collection 3, atomic violation 0이었습니다. active 72·stale24 20·stale48 18·never 1·quarantine 2·processing 0이며 그 시점 stable proof snapshot은 0이었습니다.
- event 705~708은 11:30:00 KST normal group claim·tracker claim 뒤 11:31:32 KST tracker commit(300)·quarantine clear 순서입니다. collection `pw-chrome-1786761092364-8d83d6311c99da4190d7`은 checkedCount 300, source/evidence/policy 일치, adExcluded true·excludedAdCount 60, `crossPageProofVersion=stable-full-window-v1`입니다. snapshot JSON과 ledger에는 capture ID·pass digest·collision digest가 없고 terminal circuit closed·lane/run/lease null입니다.
- 11:37:40 KST SELECT-only 재집계는 cycle #9의 eligible 56 group/71 tracker/9 agency claim 1회씩·중복 0·격리 roster 1건 claim 0을 확인했습니다. cycle #10은 6 distinct group/8 tracker·중복 0이고 신규→resume→normal 순서입니다. cycle #9~#10 commit snapshot 48/48과 감사 기준 전체 snapshot 85건/62 collection의 checkedCount/source/evidence/adExcluded/rankPolicy 위반은 0입니다. runtime `1.1.8` heartbeat 40초 이내, circuit closed, processing·expired lease·lane/run 0입니다.
- 11:45:56 KST cycle #10은 roster 57 group/72 tracker/9 agency, eligible 56/71, 시작 격리 1/1 중 7 group/10 tracker/8 agency를 claim했고 같은-cycle group·tracker 중복은 0입니다. commit 8건/5 collection의 snapshot 8/8은 checkedCount 300·source/evidence/policy·adExcluded 위반 0이며, 마지막 11:40:53 KST collection도 atomic300입니다. stable proof 이후 새 proof 실패는 0, runtime heartbeat 정상·circuit closed·processing/lane/run/lease 0입니다.
- 11:20~11:52:49 KST v1.1.8 구간은 group claim 5=distinct 5, tracker 6/6 commit, collection 5/snapshot 6이며 page_overlap·stable_unproven·duplicate_row·partial·navigation·clock/requestId/body/lease/circuit 신규 오류가 모두 0입니다. snapshot 6/6은 원자 300·공식 collector·organic evidence/policy·adExcluded 조건을 충족했습니다. nonce 179건의 최대 간격 60.9초, circuit closed·failure streak 0·lane/run/lease/current job null입니다.
- 13:09:05 KST cutoff의 v1.1.8 구간은 normal group 14/14 distinct, tracker claim 19=commit 19, open claim·job_failed 0입니다. collection 14건(일반 10·stable proof 4), snapshot 19건의 checkedCount/source/evidence/policy/adExcluded 위반과 proof 민감 필드 저장은 0입니다. cycle #10 누적 group 18=distinct 18·tracker 25·commit 23·fail 2·중복 0, 현재 cursor sort 500 앞 pending 47(eligible 46·quarantine 1), behind/equal 0입니다. heartbeat 4초·success streak 14·circuit closed·processing/lane/run/stage null입니다.
- 13:12:47 KST DB 집계는 runtime `1.1.8` fingerprint 일치·heartbeat 47초, success streak 15, circuit closed·failure streak 0·cooldown/processing/lane/run/lease 0입니다. cycle #10은 roster 57 group/72 tracker/9 agency 중 19 group/26 tracker/9 agency claim, commit 24·fail 2(모두 11:20 전), group·tracker 중복 0입니다. v1.1.8 이후 snapshot 19/14 collection은 atomic 위반 0, stable proof 5·민감정보 0이며 마지막 event 778 commit(300, stable proof)→779 quarantine clear로 끝났습니다. pending 46건은 ahead 46·behind/equal 0, stale24 원인은 과거 page-overlap 15·partial 1입니다.
- 13:23:39 KST DB 집계는 runtime `1.1.8` fingerprint 일치·heartbeat 37.7초, success streak 16, circuit closed·failure streak 0·cooldown/processing/lane/run/lease 0입니다. cycle #10은 20 group/28 tracker/9 agency claim, commit 26·fail 2, group·tracker 중복 0이며 `new 1 → resume 1 → normal 18` 순서를 유지합니다. v1.1.8 이후 15 distinct group/21 tracker는 failure 0·전부 commit, snapshot 21건/15 collection은 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 7건·민감정보 0입니다. event 787 quarantine clear 뒤 pending 44건은 ahead 44·behind/equal 0, stale24 13·stale48 11·never 1·현재 partial 격리 1입니다.
- event 792~800은 13:30:07~13:30:55 KST `group_claimed(normal) → tracker_claimed×4 → tracker_committed(300)×4` 순서이며 네 tracker가 collection `pw-chrome-1786768255133-3dde14b9fe04774cacee` 하나를 공유합니다. 13:32:22 KST cycle #10은 21 distinct group/32 distinct tracker/9 agency, commit 30·fail 2·중복 0이고 pending 40건은 ahead 40·behind 0입니다. v1.1.8 이후 snapshot 25건/16 collection은 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 7건·민감정보 0이며 failure 0입니다. runtime heartbeat 21.9초·success streak 17·circuit closed·processing/lane/run/stage null입니다.
- event 802~804는 13:40:08~13:40:55 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786768855262-ee75e6a14f5ba82eb91a`입니다. 13:42 KST cycle #10은 22 distinct group/33 distinct tracker/9 agency, commit 31·fail 2·중복 0, cursor sort 600이며 pending 39건은 ahead 39·behind 0입니다. v1.1.8 이후 17 distinct group/26 tracker는 failure 0·전부 commit했고 snapshot 26건/17 collection의 checkedCount/source/evidence/policy/adExcluded 위반과 proof 민감정보 저장은 0입니다. success streak 18·circuit closed·processing/lane/run/stage null입니다.
- event 806~809는 13:50:08~13:50:52 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786769451798-1ded6bcb4c6ca3e4df61`입니다. 13:52 KST cycle #10은 23 distinct group/34 tracker/9 agency, commit 32·fail 2·중복 0이며 v1.1.8 이후 18 group/27 tracker는 failure 0·전부 commit했습니다. pending 38건은 ahead 37·behind 1인데, behind 항목은 roster_state `quarantined`이고 `provider_partial_window:37_300` 재시도 시각이 20:10:47 KST라 현 cycle claim 0인 의도적 skip입니다. snapshot 27건/18 collection의 원자 계약 위반 0, success streak 19·circuit closed·processing/lane/run/stage null입니다.
- event 812~821은 14:00:00~14:02:24 KST 첫 `normal` group의 tracker 2건을 stable proof collection `pw-chrome-1786770091632-09cdcd5bf1f622bd6789`로 commit(300)×2·quarantine clear한 뒤, handoff된 다음 `normal` group도 collection `pw-chrome-1786770144536-d136456beb36186815a2`로 commit(300)한 순서입니다. cycle #10은 25 distinct group/37 distinct tracker, commit 35·fail 2·중복 0입니다. v1.1.8 이후 snapshot 30건/20 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 9건·민감정보 0·failure 0이며 success streak 21·circuit closed·processing/lane/run/stage null입니다. active stale24 11·stale48 9, pending 35건은 eligible ahead 34·partial 격리 behind 1입니다.
- event 823~826은 14:10:08~14:10:52 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786770651385-b1aba05e97f51cec8b1f`입니다. 14:12 KST cycle #10은 26 distinct group/38 tracker, commit 36·fail 2·중복 0·cursor sort 800입니다. v1.1.8 이후 snapshot 31건/21 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 9건·민감정보 0·failure 0이며 success streak 22·circuit closed·processing/lane/run/stage null입니다. pending 34건은 eligible ahead 33·partial 격리 behind 1입니다.
- event 828~831은 14:20:08~14:21:36 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786771295620-94ae1fe3e4cbc41eda76`입니다. 14:22 KST cycle #10은 27 distinct group/39 tracker, commit 37·fail 2·중복 0·cursor sort 900입니다. v1.1.8 이후 snapshot 32건/22 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 10건·민감정보 0·failure 0이며 success streak 23·circuit closed·processing/lane/run/stage null입니다. pending 33건은 eligible ahead 32·partial 격리 behind 1입니다.
- event 833~835는 14:30:07~14:31:35 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1)` 순서이고 collection은 `pw-chrome-1786771895357-8bc42a99e9228a94d128`입니다. 14:32 KST cycle #10은 28 distinct group/40 tracker, commit 38·fail 2·중복 0·cursor sort 1000입니다. v1.1.8 이후 snapshot 33건/23 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 11건·민감정보 0·failure 0이며 success streak 24·circuit closed·processing/lane/run/stage null입니다. pending 32건은 eligible ahead 31·partial 격리 behind 1입니다.
- event 837~839는 14:40:08~14:41:33 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1)` 순서이고 collection은 `pw-chrome-1786772493859-1f064889f300d319038f`입니다. 14:42 KST cycle #10은 29 distinct group/41 tracker, commit 39·fail 2·중복 0·cursor sort 1100입니다. v1.1.8 이후 snapshot 34건/24 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 12건·민감정보 0·failure 0이며 success streak 25·circuit closed·processing/lane/run/stage null입니다. pending 31건은 eligible ahead 30·partial 격리 behind 1입니다.
- event 841~844는 14:50:08~14:51:36 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786773096179-9cd9ba66aaaf7ee3cf2a`입니다. 14:52 KST cycle #10은 30 distinct group/42 tracker, commit 40·fail 2·중복 0·cursor sort 1200입니다. v1.1.8 이후 snapshot 35건/25 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 13건·민감정보 0·failure 0이며 success streak 26·circuit closed·processing/lane/run/stage null입니다. stale24 10, pending 30건은 eligible ahead 29·partial 격리 behind 1입니다.
- event 847~860은 14:57:00~15:02:26 KST `normal` 3개 group의 tracker 2·1·1건을 collection `pw-chrome-1786773506738-693d8be7eefda73bfb46`, `pw-chrome-1786773694165-5e42157db6339d76fb51`, `pw-chrome-1786773746144-f51acaa322dff498d84e`로 commit(300)한 장부입니다. 앞 두 collection은 stable proof이고 마지막은 handoff된 일반 window입니다. cycle #10은 33 distinct group/46 tracker, commit 44·fail 2·중복 0·cursor sort 1400입니다. v1.1.8 이후 snapshot 39건/28 collection의 원자 계약 위반 0, stable proof 16건·민감정보 0·failure 0이며 success streak 29·circuit closed·processing/lane/run/stage null입니다. stale24·stale48 각 9, pending 26건은 eligible ahead 25·partial 격리 behind 1입니다.
- event 862~864는 15:10:08~15:10:51 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786774251791-13e60ebe40d19694c5a9`입니다. 15:12 KST cycle #10은 34 distinct group/47 tracker, commit 45·fail 2·중복 0·cursor sort 1500입니다. v1.1.8 이후 snapshot 40건/29 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 16건·민감정보 0·failure 0이며 success streak 30·circuit closed·processing/lane/run/stage null입니다. pending 25건은 eligible ahead 24·partial 격리 behind 1입니다.
- event 866~868은 15:20:07~15:20:51 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786774851817-6b0ae6da270ee17ecbba`입니다. 15:22 KST cycle #10은 35 distinct group/48 tracker, commit 46·fail 2·중복 0입니다. v1.1.8 이후 snapshot 41건/30 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 16건·민감정보 0·failure 0이며 success streak 31·circuit closed·processing/lane/run/stage null입니다. pending 24건은 eligible ahead 23·partial 격리 behind 1입니다.
- event 870~872는 15:30:07~15:30:53 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786775453043-e4384a21c56d08c1d4fe`입니다. 15:32 KST cycle #10은 36 distinct group/49 tracker, commit 47·fail 2·중복 0·cursor sort 1600입니다. v1.1.8 이후 snapshot 42건/31 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 16건·민감정보 0·failure 0이며 success streak 32·circuit closed·processing/lane/run/stage null입니다. pending 23건은 eligible ahead 22·partial 격리 behind 1입니다.
- event 874~876은 15:40:08~15:41:34 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1)` 순서이고 collection은 `pw-chrome-1786776094067-10d21d25c0454f0d6cc6`입니다. 15:42 KST cycle #10은 37 distinct group/50 tracker, commit 48·fail 2·중복 0·cursor sort 1700입니다. v1.1.8 이후 snapshot 43건/32 collection의 checkedCount/source/evidence/policy/adExcluded 위반 0, stable proof 17건·민감정보 0·failure 0이며 success streak 33·circuit closed·processing/lane/run/stage null입니다. pending 22건은 eligible ahead 21·partial 격리 behind 1입니다.
- event 878~880은 15:50:08~15:50:52 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786776652706-535a984d595ca113f3f5`입니다. 15:53 KST cycle #10은 38 distinct group/51 tracker, commit 49·fail 2·중복 0입니다. v1.1.8 이후 snapshot 44건/33 collection의 checkedCount/source/evidence/policy/adExcluded 위반과 민감 proof 저장·failure는 모두 0이며 success streak 34·circuit closed·processing/lane/run/stage null입니다. pending 21건은 eligible 20·partial 격리 1입니다.
- event 882~885·887~890은 15:54:01~16:00:53 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 두 묶음입니다. collections는 `pw-chrome-1786776926673-b13f80e6214bd7e2ef59`(stable-full-window-v1)·`pw-chrome-1786777253128-0d106413bcbb9d9b5c49`입니다. 16:03 KST cycle #10은 40 distinct group/53 tracker, commit 51·fail 2·중복 0·cursor sort 1800입니다. v1.1.8 이후 snapshot 46건/35 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 36·circuit closed·processing/lane/run/stage null입니다. pending 19건은 eligible 18·partial 격리 1입니다.
- event 892~895·897~899는 16:10:01~16:12:21 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 두 묶음이며 첫 묶음은 stable proof와 quarantine clear까지 기록됐습니다. collections는 `pw-chrome-1786777889788-d719d4e02098384ee428`·`pw-chrome-1786777941855-e390b61be3f8b0ad649a`입니다. 16:12 KST cycle #10은 42 distinct group/55 tracker, commit 53·fail 2·중복 0·cursor sort 1900입니다. v1.1.8 이후 snapshot 48건/37 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 38·circuit closed·processing/lane/run/stage null입니다. pending 17건은 eligible 16·partial 격리 1입니다.
- event 901~904는 16:20:08~16:21:37 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786778497076-d452d0861e7a5bd0b71d`입니다. 16:22 KST cycle #10은 43 distinct group/56 tracker, commit 54·fail 2·중복 0·cursor sort 2000입니다. v1.1.8 이후 snapshot 49건/38 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 39·circuit closed·processing/lane/run/stage null입니다. pending 16건은 eligible 15·partial 격리 1입니다.
- event 906~908은 16:30:08~16:30:54 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786779054102-d046097bcabf4738c6fb`입니다. 16:32 KST cycle #10은 44 distinct group/57 tracker, commit 55·fail 2·중복 0·cursor sort 2100입니다. v1.1.8 이후 snapshot 50건/39 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 40·circuit closed·processing/lane/run/stage null입니다. pending 15건은 eligible 14·partial 격리 1입니다.
- event 910~913은 16:40:07~16:41:33 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786779693130-6182b9dbbbc9a208a227`입니다. 16:42 KST cycle #10은 45 distinct group/58 tracker, commit 56·fail 2·중복 0입니다. v1.1.8 이후 snapshot 51건/40 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 41·circuit closed·processing/lane/run/stage null입니다. pending 14건은 eligible 13·partial 격리 1입니다.
- event 915~918은 16:50:08~16:51:38 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786780297405-ab1ff00041e9c2ccd454`입니다. 16:52 KST cycle #10은 46 distinct group/59 tracker, commit 57·fail 2·중복 0·cursor sort 2200입니다. v1.1.8 이후 snapshot 52건/41 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 42·circuit closed·processing/lane/run/stage null입니다. pending 13건은 eligible 12·partial 격리 1입니다.
- event 920~923·925~928은 16:56:00~17:00:53 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 두 묶음입니다. collections는 `pw-chrome-1786780648643-c7bf2f714efe9de4162f`(stable-full-window-v1)·`pw-chrome-1786780852044-d54c93cd9ca8e16ce82a`입니다. 17:01 KST cycle #10은 48 distinct group/61 tracker, commit 59·fail 2·중복 0·cursor sort 2400입니다. v1.1.8 이후 snapshot 54건/43 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 44·circuit closed·processing/lane/run/stage null입니다. pending 11건은 eligible 10·partial 격리 1입니다.
- event 930~932는 17:10:08~17:11:36 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300, stable-full-window-v1)` 순서이고 collection은 `pw-chrome-1786781496380-f3d7ad9a529899eb72f0`입니다. 17:11 KST cycle #10은 49 distinct group/62 tracker, commit 60·fail 2·중복 0·cursor sort 2600입니다. v1.1.8 이후 snapshot 55건/44 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 45·circuit closed·processing/lane/run/stage null입니다. pending 10건은 eligible 9·partial 격리 1입니다.
- event 934~937은 17:20:08~17:20:52 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 순서이고 collection은 `pw-chrome-1786782051055-c62e6458df42eb8b37bd`입니다. 17:21 KST cycle #10은 50 distinct group/63 tracker, commit 61·fail 2·중복 0·cursor sort 2700입니다. v1.1.8 이후 snapshot 56건/45 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 46·circuit closed·processing/lane/run/stage null입니다. pending 9건은 eligible 8·partial 격리 1입니다.
- event 941~947은 17:30:08~17:30:52 KST `group_claimed(normal) → tracker_claimed×3 → tracker_committed(300)×3` 순서입니다. 세 tracker가 collection `pw-chrome-1786782652392-e1fcbd219e84859d6b67` 하나를 공유해 브라우저 중복 수집이 없습니다. 17:31 KST cycle #10은 51 distinct group/66 tracker, commit 64·fail 2·중복 0·cursor sort 2800입니다. v1.1.8 이후 snapshot 59건/46 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 47·circuit closed·processing/lane/run/stage null입니다. pending 6건은 eligible 5·partial 격리 1입니다.
- event 949~951은 17:40:08~17:40:52 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786783252770-4d2b11c7b52361ccece5`입니다. 17:41 KST cycle #10은 52 distinct group/67 tracker, commit 65·fail 2·중복 0·cursor sort 3200입니다. v1.1.8 이후 snapshot 60건/47 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 48·circuit closed·processing/lane/run/stage null입니다. pending 5건은 eligible 4·partial 격리 1입니다.
- event 953~955는 17:50:08~17:50:51 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786783851708-ffd804f4643b88e08c9a`입니다. 17:51 KST cycle #10은 53 distinct group/68 tracker, commit 66·fail 2·중복 0·cursor sort 3300입니다. v1.1.8 이후 snapshot 61건/48 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 49·circuit closed·processing/lane/run/stage null입니다. pending 4건은 eligible 3·partial 격리 1입니다.
- event 957~959·961~963은 17:59:01~18:00:50 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 두 묶음이며 collections는 `pw-chrome-1786784388968-c5d056c1608873d156e5`·`pw-chrome-1786784450244-6f22e02bb1a786426ca3`입니다. 18:01 KST cycle #10은 55 distinct group/70 tracker, commit 68·fail 2·중복 0·cursor sort 3600입니다. v1.1.8 이후 snapshot 63건/50 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 51·circuit closed·processing/lane/run/stage null입니다. pending 2건은 eligible 1·partial 격리 1입니다.
- event 965~967은 18:10:08~18:10:50 KST `group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서이고 collection은 `pw-chrome-1786785050384-fc0a26bbf7edade775e1`입니다. cycle #10은 56 distinct group/71 tracker, commit 69·fail 2·중복 0·cursor sort 3700이며 pending 1건은 시작 시 partial 격리 1건뿐입니다. v1.1.8 이후 snapshot 64건/51 collection의 checkedCount/source/evidence/policy/adExcluded 위반·민감 proof 저장·failure는 0이고 success streak 52·circuit closed·processing/lane/run/stage null입니다. 24시간 기준 이후 cycle terminal/다음 cycle 시작은 아직 미확인입니다.
- event 968은 18:20:08 KST cycle #10 `cycle_completed`입니다. 24시간 기준 뒤 재계산한 roster는 57 group/72 tracker/9 agency(eligible 56/71, 시작 격리 1/1), claim은 56 distinct group/71 distinct tracker/9 agency, new 1·resume 1·normal 54, group/tracker 중복 0, 시작 격리 claim 0, agency full coverage 9/9입니다. terminal commit 69·fail 2·open 0·multiple 0이고 commit snapshot missing 0, checkedCount300/source/evidence/policy/adExcluded 위반 0입니다. cycle #10 완료 전 #11 시작은 0이며 실제 #11 시작은 다음 wake에서 확인해야 합니다.
- event 969는 18:30:07 KST cycle #11 시작이며 cycle #10 완료 9분59초 뒤입니다. roster event는 72 tracker/57 group/9 agency(eligible 71, quarantined 1)입니다. event 1043~1046은 첫 `new` group/tracker claim → 18:31:36 KST `tracker_committed(300, stable-full-window-v1)` → quarantine clear 순서이고 collection은 `pw-chrome-1786786296142-f60a8e9cfa1610eb49a8`입니다. event 1049~1053은 `resumeCursorBefore=true`인 기존 group으로 복귀해 tracker 2건을 collection `pw-chrome-1786786851859-c337fa156160ecf8fa04` 하나로 각각 commit(300)한 장부입니다. 두 collection의 snapshot 3건은 source/evidence/policy/adExcluded/checkedCount 위반 0, proof 민감정보 저장 0이고 cycle #11 group/tracker 중복 0·failure 0·terminal lane/run/lease null입니다. active never=0이며 잔여 stale는 과거 page-overlap 1건과 20:10:47 KST 재시도 예정인 partial 37/300 1건입니다.
- event 1062~1065는 18:50:07~18:51:32 KST 과거 page-overlap tracker의 `group_claimed(normal) → tracker_claimed → job_failed(provider_partial_window:130_300) → quarantine_set` 순서입니다. current cycle claim은 정확히 1회, snapshot·collection은 0이고 last checked/rank/history는 유지됐습니다. terminal 뒤 circuit closed·processing/lane/run/lease null이며 24시간 격리 시각은 2026-08-16 18:51:32 KST입니다. 이는 stable overlap 처리 뒤 duplicate 오류는 재발하지 않았지만 실제 오가닉 300 슬롯을 증명하지 못해 저장을 거부한 결과입니다.
- `scripts/naver-shopping-native-host.test.mjs`의 finite-market 회귀는 first-party total 37·130에 맞춰 절대 순위 슬롯만 제공한 8페이지를 검증하고 두 경우 모두 정확한 `provider_partial_window:<count>/300`을 요구합니다. 임의 padding 없이 fail-closed하며 native-host 37/37, `git diff --check`, 보호 잠금이 통과했습니다.
- 19:33 KST heartbeat 시점은 재시도 예정 20:10:47 KST 전이며 예약된 20:12 KST SELECT-only 조회는 대기 상태입니다. 이 회차의 DB write·wake·격리/순서/lease 변경은 0입니다.
- 20:04 KST heartbeat도 재시도 전입니다. 예약 작업은 실행 대기 중이고 DB write·wake·격리/순서/lease 변경은 0입니다.
- event 1167~1169는 21:20:07~21:20:47 KST `키크는쌀`의 자연 `tracker_claimed(normal) → job_failed(provider_partial_window:35_300) → quarantine_set`입니다. cycle #11에서 같은 tracker 재claim은 0, snapshot/collection 0, rank/history 불변, next quarantine은 2026-08-16 21:20:47 KST입니다. 격리 만료 직후 강제 우선하지 않고 cursor sort 600 도달 시 처리된 순서 증거입니다.
- 2026-08-16 01:20:56 KST 최종 집계: cycle #10은 roster tracker/group/agency 72/57/9, eligible 71·quarantined 1, claim tracker/group/agency 71/56/9, priority new 1·resume 1·normal 54, group/tracker duplicate 0, commit 69·fail 2, `nextBeforeComplete=0`입니다. cycle #11은 51 group/64 tracker, commit 62·fail 2, duplicate 0, 첫 priority `[new,resume,normal]`입니다. 기준 시각 이후 snapshot 210건/161 collection의 checkedCount300/source/evidence/policy/adExcluded 위반과 proof secret leak은 모두 0입니다. active 72 중 stale/quarantine 2건은 모두 typed partial이며 never/processing 0, coordination은 runtime 1.1.8·fingerprint 일치·circuit closed·failure streak 0·lane/run/lease null입니다.

## 2026-08-14 준비작업 1번 시작 기준

- 17:27 KST Windows 실기: exact release `1ba1efc45bbe`, expected `1.1.6` 업데이터는 `native_host_manifest_missing`으로 중단됐습니다. `$LOCALAPPDATA\MomentInsight\NaverShoppingBridge\com.momentinsight.naver_shopping.json`의 `Test-Path` 결과도 `False`여서 최초 판단을 레지스트리 단독 누락에서 manifest+등록 동시 누락으로 정정합니다.
- 후속 회귀는 manifest 누락 감지→정확 5필드 UTF-8 재생성→name/type/path/origin 재검증→HKCU write/readback 순서를 고정합니다. Windows bridge 10/10, server contract 49/49, baseline과 `git diff --check`를 통과했으며 운영 재실행 결과는 아직 없습니다.
- 현재 사용자 범위에서 manifest·HKCU를 직접 복원했고 `MANIFEST=True`, launcher/config/DPAPI secret 존재, 등록 경로 readback 일치를 확인했습니다. launcher에 invalid start frame을 보냈을 때 typed `native_host_start_invalid`가 반환돼 manifest·launcher·DPAPI·Node 기동 자체는 정상입니다.
- 실제 `run` frame에서는 Chrome debug log가 `Error when writing to Native Messaging host: -101`을 남겼고, Node 직접 stderr는 `local-worker-contract.mjs`의 `LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS` named export 누락을 정확히 가리켰습니다. Windows의 구 `local-worker-auth.mjs`와 새 contract가 혼합된 상태가 heartbeat 정지의 확정 원인입니다.
- v1.1.7 후보는 updater와 full installer의 실행 `.mjs` 폐쇄 집합 일치, 다운로드→구문검사→복사→해시 순서, native fingerprint 동일 순서를 회귀로 고정했습니다. 전체 `check:release`는 core 539/539·Place 51/51·Shopping 57/57, server contract 50/50, Production auth 18/18, 공개빌드/CSP와 보호 잠금을 모두 통과했습니다.
- Production `/health`·`/ready`는 `703bf0ca0e02`/Supabase ready로 일치했고 migration `naver_shopping_runtime_1_1_7` 적용 뒤 3개 runtime 함수가 SECURITY INVOKER·빈 search path·postgres/service_role 전용 실행권한을 유지했습니다.
- Windows updater는 `MI_EXTENSION_UPDATE_OK release=703bf0c… version=1.1.7 syntax=13`, `loaded_extension_synced=true`, `native_host_registry_synced=true`, fingerprint `8eef01d4357766c0d4a002fc061b68f7420b48a703dfd6af4e3dffd2d17e5e01`을 반환했습니다. 이후 자연 수집 `pw-chrome-1786699070869-a689fd48726f639586bb`가 source `naver_shopping_results_collector`, evidence `naver_shopping_organic_list`, `checkedCount=300`, `organic_only`, `adExcluded=true`, 광고 30개 제외로 저장되고 lane·run·tracker lease가 모두 null로 해제됐습니다.
- 18:27 KST SELECT-only: runtime `1.1.7`, heartbeat 59초, circuit closed, cooldown·lane·processing 없음, cycle #8 active입니다. ledger event 순서는 `new claim → checkedCount=300 commit → resume claim → typed page_overlap failure → quarantine_set`이고 scheduled group 중복은 0입니다. 활성 72 tracker/57 group/9 agency, stale24 24·stale48 21·never checked 6·현재 격리 1이며 복구 기준 snapshot 1건의 atomic 위반은 0입니다.
- 18:30:08~18:30:56 KST ledger event 11~14는 `cycle_rostered → group_claimed(new) → tracker_claimed(new) → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786699855696-00657d0c90fcaf93a0a1`, 광고 제외 30개이며 terminal 뒤 lane·lease·run은 모두 null입니다.
- event 15~38은 `resume` tracker 2건의 동일 collection commit, `new` 1건 commit, 이어진 `resume` tracker 4건의 동일 collection commit을 순서대로 기록합니다. 18:42 KST 집계는 scheduled group 6·tracker 10·agency 4, new 3·resume 3, 같은-cycle group 중복 0, commit 9·failure 1입니다. 복구 기준 snapshot 9건/5 collection은 모두 source·오가닉 근거·광고 제외·`checkedCount=300`을 충족합니다. 활성 72 tracker/57 group/9 agency 중 never-checked는 7→4로 감소했고 stale24 24·stale48 21·격리 1·processing 0입니다.
- event 39~42는 18:50:08~18:50:53 KST `cycle_rostered → group_claimed(new) → tracker_claimed(new) → tracker_committed(300)` 순서이며 광고 45개를 제외했습니다. 18:52 KST heartbeat 55초, runtime `1.1.7`, circuit closed, cooldown·lane·run 없음입니다. 다음 claim이 `resume`인지 아직 관측 전이므로 신규 우선 후 cursor 복귀 증거로는 앞선 3쌍만 계산합니다.
- event 43~46은 19:00:08~19:00:56 KST `cycle_rostered(late_observed) → group_claimed(resume) → tracker_claimed(resume) → tracker_committed(300)` 순서로 직전 신규 뒤 cursor 복귀를 확정합니다. terminal은 광고 45개 제외, circuit closed, lane·run 해제이며 current cycle scheduled group 중복은 계속 0입니다.
- event 47~50은 19:10:08~19:10:55 KST `cycle_rostered(new_after_start) → group_claimed(new) → tracker_claimed(new) → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786702255686-115a703b67a543194015`은 광고 30개 제외·`checkedCount=300`이며, cycle 누적 scheduled group 9·tracker 13·agency 4, new 5·resume 4, group 중복 0입니다. 복구 기준 12 snapshot/8 collection의 source·오가닉 근거·광고 제외·원자 300 위반은 0이고 never-checked는 2건입니다.
- event 51~55는 19:20:07~19:21:35 KST `cycle_rostered(late_observed) → group_claimed(resume) → tracker_claimed(resume) → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. 신규 뒤 cursor 복귀는 성립했으나 새 snapshot은 없고 lane·processing은 해제됐습니다. cycle 누적 new 5·resume 5, group 중복 0이며 활성 오류 분포는 정상 44·page-overlap 22·duplicate-row 4·partial 1·generic collection failure 1입니다.
- event 56~59는 19:30:08~19:30:52 KST `cycle_rostered(new_after_start) → group_claimed(new) → tracker_claimed(new) → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786703452418-883e83dd9be75c54245a`, 광고 30개 제외이며 terminal 뒤 lane·lease는 null입니다. DB `worker_last_cycle_id` 기준 cycle #8 누적 25 group·32 tracker·9 agency가 claim됐고, 복구 기준 13 snapshot/9 collection의 atomic 위반은 0입니다.
- event 60~68은 19:40:07~19:41:32 KST `cycle_rostered(late_observed)×2 → group_claimed(resume) → tracker_claimed×2 → job_failed×2 → quarantine_set×2` 순서입니다. 두 tracker는 같은 typed `page_overlap`과 30분 재시도 시각을 받았고 새 snapshot은 0, terminal 뒤 lane·lease는 null입니다. 신규 우선 뒤 cursor 복귀가 다시 성립했으며 cycle 누적 26 group·34 tracker·9 agency, group 중복 0입니다.
- event 69~81은 19:50:07~19:50:54 KST `cycle_rostered(late_observed)×4 → group_claimed(normal) → tracker_claimed×4 → tracker_committed(300)×4` 순서입니다. 네 tracker가 collection `pw-chrome-1786704654007-cdc3898c817c769f6253` 하나를 공유해 같은 키워드의 브라우저 중복 수집 없이 원자 저장됐습니다. cycle 누적 27 group·38 tracker·9 agency, 복구 기준 17 snapshot/10 collection의 atomic 위반은 0입니다.
- event 82~86은 20:00:08~20:01:27 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. 실패한 group은 snapshot 0·lane/lease 해제로 종료됐고 cycle cursor는 다음 순서로 전진했습니다. cycle 누적 28 group·39 tracker·9 agency, group 중복과 atomic 위반은 0입니다.
- event 87~91은 20:10:09~20:10:47 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(provider_partial_window:37_300) → quarantine_set(+24시간)` 순서입니다. 확인 가능한 오가닉 37개를 300개로 위조하지 않아 snapshot은 0이며 terminal 뒤 lane·processing은 해제됐습니다. cycle 누적 29 group·40 tracker·9 agency, atomic 위반 0입니다.
- event 92~95는 20:20:08~20:20:52 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786706452021-8acced7cdd80938c4b99`, 광고 30개 제외이며 terminal 뒤 lane·lease는 null입니다. cycle 누적 30 group·41 tracker·9 agency, 복구 기준 18 snapshot/11 collection의 atomic 위반은 0입니다.
- event 96~104는 20:24:01~20:25:27 KST `cycle_rostered(late_observed)×2 → group_claimed(normal) → tracker_claimed×2 → job_failed(page_overlap)×2 → quarantine_set(+30분)×2` 순서입니다. snapshot 0·terminal lane/lease null이며 cycle 누적 31 group·43 tracker·9 agency, 남은 26 group·29 tracker는 모두 eligible, 같은-cycle group 중복과 복구 기준 atomic 위반은 0입니다.
- event 105~108은 20:30:08~20:30:53 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786707053432-590e86740dae1418fb35`, 광고 45개 제외이며 terminal lane/lease null입니다. cycle 누적 32 group·44 tracker·9 agency, 남은 25 group·28 tracker는 모두 eligible, 복구 기준 19 snapshot/12 collection의 같은-cycle group 중복·atomic 위반은 0입니다.
- event 109~117은 20:34와 20:40 KST의 `normal` group 2건을 각각 `tracker_committed(300)`으로 완료하고 첫 성공 뒤 과거 격리 1건을 해제한 순서입니다. 두 collection은 `pw-chrome-1786707287004-95991c7e1070c3386a5f`, `pw-chrome-1786707651150-deaccaabf30aeb84478a`이며 terminal lane/lease null입니다. cycle 누적 34 group·46 tracker·9 agency, 남은 23 group·26 tracker 전부 eligible, 복구 기준 21 snapshot/14 collection의 same-cycle duplicate·atomic 위반은 0입니다.
- event 118~122는 20:50:07~20:50:53 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 순서입니다. collection `pw-chrome-1786708252428-38ed0c1d7caa30d32f7d`, 광고 45개 제외이며 terminal lane/lease null입니다. cycle 누적 35 group·47 tracker·9 agency, 남은 22 group·25 tracker 전부 eligible, 복구 기준 22 snapshot/15 collection의 duplicate·atomic 위반은 0입니다.
- event 123~126은 21:00:08~21:00:51 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786708851890-591f33f253fc7c120777`, 광고 30개 제외이며 terminal lane/lease null입니다. cycle 누적 36 group·48 tracker·9 agency, 남은 21 group·24 tracker 전부 eligible, 복구 기준 23 snapshot/16 collection의 duplicate·atomic 위반은 0입니다.
- event 127~131은 21:10:08~21:11:16 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null이며 cycle 누적 37 group·49 tracker·9 agency, 남은 20 group·23 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 132~139는 21:20:08~21:20:54 KST `cycle_rostered(late_observed)×2 → group_claimed(normal) → tracker_claimed×2 → tracker_committed(300)×2 → quarantine_cleared` 순서입니다. tracker 2건은 collection `pw-chrome-1786710053743-2fcfd19ee724be222a62` 하나를 공유해 브라우저 중복 수집 없이 저장됐습니다. cycle 누적 38 group·51 tracker·9 agency, 남은 19 group·21 tracker 전부 eligible, 복구 기준 25 snapshot/17 collection의 duplicate·atomic 위반은 0입니다.
- event 140~148은 21:27~21:30 KST `normal` group 1건의 page-overlap fail-closed·30분 격리 뒤 다음 `normal` group이 `tracker_committed(300)`으로 완료된 순서입니다. 성공 collection `pw-chrome-1786710653940-f8f1eb59a3be72619b04`, 광고 30개 제외이며 두 terminal 모두 lane/lease null입니다. cycle 누적 40 group·53 tracker·9 agency, 남은 17 group·19 tracker 전부 eligible, 복구 기준 26 snapshot/18 collection의 duplicate·atomic 위반은 0입니다.
- event 149~153은 21:40:07~21:40:50 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300) → quarantine_cleared` 순서입니다. collection `pw-chrome-1786711250309-f2e58bc8be440b01e285`, 광고 45개 제외이며 terminal lane/lease null입니다. cycle 누적 41 group·54 tracker·9 agency, 남은 16 group·18 tracker 전부 eligible, 복구 기준 27 snapshot/19 collection의 duplicate·atomic 위반은 0입니다.
- event 154~158은 21:50:07~21:51:28 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null이며 cycle 누적 42 group·55 tracker·9 agency, 남은 15 group·17 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 159~163은 22:00:07~22:01:24 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null·global circuit closed이며 cycle 누적 43 group·56 tracker·9 agency, 남은 14 group·16 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 164~172는 22:03~22:10 KST `normal` group 1건의 page-overlap fail-closed·30분 격리 뒤 다음 `normal` group이 `tracker_committed(300)`으로 완료된 순서입니다. 성공 collection `pw-chrome-1786713052105-b1cc9e41860f28fbfb43`, 광고 30개 제외이며 두 terminal 모두 lane/lease null입니다. cycle 누적 45 group·58 tracker·9 agency, 남은 12 group·14 tracker 전부 eligible, 복구 기준 28 snapshot/20 collection의 duplicate·atomic 위반은 0입니다.
- event 173~177은 22:20:08~22:21:20 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null·global circuit closed이며 cycle 누적 46 group·59 tracker·9 agency, 남은 11 group·13 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 178~182는 22:30:07~22:31:17 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null·global circuit closed이며 cycle 누적 47 group·60 tracker·9 agency, 남은 10 group·12 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 183~187은 22:40:07~22:41:28 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null·global circuit closed이며 cycle 누적 48 group·61 tracker·9 agency, 남은 9 group·11 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 188~192는 22:50:07~22:51:16 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → job_failed(page_overlap) → quarantine_set(+30분)` 순서입니다. snapshot 0·terminal lane/lease null·global circuit closed이며 cycle 누적 49 group·62 tracker·9 agency, 남은 8 group·10 tracker 전부 eligible, same-cycle duplicate와 복구 기준 atomic 위반은 0입니다.
- event 193~201은 23:00:00~23:01:35 KST 첫 `normal` group `tracker_committed(300)` 뒤 handoff된 다음 `normal` group도 `tracker_committed(300) → quarantine_cleared`로 완료된 순서입니다. 두 collection `pw-chrome-1786716045675-67da69a7366f226495c0`, `pw-chrome-1786716094992-25cd28a14a56369965b3`은 서로 분리되고 각자 원자 300이며 terminal lane/lease null입니다. cycle 누적 51 group·64 tracker·9 agency, 남은 6 group·8 tracker 전부 eligible, 복구 기준 30 snapshot/22 collection의 duplicate·atomic 위반은 0입니다.
- event 202~211은 23:10:07~23:10:52 KST `cycle_rostered(late_observed)×3 → group_claimed(normal) → tracker_claimed×3 → tracker_committed(300)×3` 순서입니다. tracker 3건은 collection `pw-chrome-1786716652291-8d2cd6b820b3f0e1545d` 하나를 공유해 브라우저 중복 수집 없이 저장됐습니다. cycle 누적 52 group·67 tracker·9 agency, 남은 5 group·5 tracker 전부 eligible, 복구 기준 33 snapshot/23 collection의 duplicate·atomic 위반은 0입니다.
- event 212~215는 23:20:07~23:20:54 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786717254167-2e3aaa66a34f27cf4140`, 광고 30개 제외이며 terminal lane/lease null입니다. cycle 누적 53 group·68 tracker·9 agency, 남은 4 group·4 tracker 전부 eligible, 복구 기준 34 snapshot/24 collection의 duplicate·atomic 위반은 0입니다.
- event 216~219는 23:30 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786717855475-2f738909ec6423342baa`이며 terminal lane/lease null입니다. cycle 누적 54 group·69 tracker·9 agency, 남은 3 group·3 tracker 전부 eligible, 복구 기준 35 snapshot/25 collection의 duplicate·atomic 위반은 0입니다. 23:33 KST runtime `1.1.7`, heartbeat 56초, circuit closed도 함께 확인했습니다.
- event 220~223은 23:40:07~23:40:49 KST `cycle_rostered(late_observed) → group_claimed(normal) → tracker_claimed → tracker_committed(300)` 순서입니다. collection `pw-chrome-1786718449093-c5960af08dffe50d869d`이며 terminal lane/lease null입니다. cycle 누적 55 group·70 tracker·9 agency, 남은 2 group·2 tracker, 복구 기준 36 snapshot/26 collection의 duplicate·atomic 위반은 0입니다.
- event 224~232는 23:50·00:00 KST 남은 두 `normal` group의 `tracker_committed(300)` 뒤 00:10 KST `cycle_completed`가 기록된 순서입니다. 두 collection은 각각 분리된 원자 300이며 복구 기준 38 snapshot/28 collection의 atomic 위반은 0입니다.
- event 233~324는 cycle #9 시작·roster 확정 뒤 `new → 실패 격리 → resume → normal` 순서입니다. 신규는 cursor를 바꾸지 않고 1회 우선 처리됐고 기존 cursor로 복귀했으나, event 316~317·323~324의 서로 다른 두 group이 `naver_page_navigation_failed`로 연속 종료됐습니다. 02:04 KST runtime `1.1.7` heartbeat는 정상이나 circuit은 `navigating:naver_page_navigation_failed`, failure streak 2로 open이며 lane·lease는 null입니다. cycle #9는 3/57 group에서 정지해 정상 판정을 보류합니다.
- `20260814182150_naver_shopping_auto_navigation_half_open.sql` 회귀는 primary·정확 오류·10분 조건, half-open 단 1회, 일반 순서/격리/cursor 불변, 수동 probe 분리, atomic300 성공만 close, service-role-only를 고정합니다. 전용 7/7, server contract 51/51, baseline, 보호 잠금 22함수·82파일·32마이그레이션 self-test 및 전체 `npm run check:release`가 통과했습니다. 운영 적용·재개 증거 전에는 정상화로 보고하지 않습니다.
- 03:30~03:31 KST 첫 자동 half-open은 event 326~329에서 기존 순서 normal group을 claim하고 page 6까지 진행한 뒤 `provider_duplicate_identity:4:1:page_overlap:3`으로 tracker 격리·snapshot 0·lane/lease 해제됐습니다. navigation 자체는 복구됐지만 release 함수가 `probe_incomplete`로 global circuit을 다시 열어 cycle #9가 4/57 group에서 재정지한 추가 결함을 확인했습니다.
- `20260814183217_naver_shopping_auto_navigation_tracker_failure_recovery.sql`은 auto-navigation half-open·failed stage·허용된 tracker 오류 base가 모두 맞을 때만 circuit을 close하고, 성공 시각·순위·tracker·격리·cursor·wake를 쓰지 않습니다. 일반 half-open 실패는 계속 `probe_incomplete` open입니다. 배포 시 one-time repair도 최근 heartbeat·최근 tracker 오류인 exact false-open state만 대상으로 합니다. 전용 9/9, server contract 52/52, baseline, 보호 잠금 22함수·83파일·33 migration self-test, 전체 release 544+51+57 및 Production auth 18/18이 통과했습니다. 운영 적용 전 상태이므로 정상화 증거가 아닙니다.
- Production release `e409f633bac0`·Supabase migration 적용 후 event 331~333은 cycle #9의 다음 normal group을 claim해 collection `pw-chrome-1786732843086-33be93755eeb0d0b666a`, checkedCount 300, source `naver_shopping_results_collector`, evidence `naver_shopping_organic_list`, adExcluded true, 광고 45개 제외로 commit했습니다. event 335~338의 다음 normal group은 `provider_duplicate_identity:3:13:page_overlap:1`로 fail-closed·30분 격리됐으나 circuit closed·lane/run/lease null을 유지했습니다. 03:42 KST cycle 누적 6/57 group·8 tracker·7 agency, 같은-cycle group 중복 0, cycle snapshot 1/collection 1·atomic 위반 0이며 강제 wake·cursor·격리 조작은 수행하지 않았습니다.
- event 341~345는 03:50 KST 다음 자연 normal group의 tracker 2건을 동일 collection `pw-chrome-1786733454439-358906d98f00d5e940d7`로 claim·commit한 증거입니다. snapshot 2건 모두 checkedCount 300, source/evidence/adExcluded 일치, excludedAdCount 45이며 terminal 뒤 circuit closed·processing 0·lane/run/lease null입니다. cycle #9 누적 7 distinct group/10 tracker/8 agency, same-cycle duplicate 0, snapshot 3/collection 2·atomic 위반 0입니다.
- 03:53 KST agency별 active/claim 대조는 9개 중 8개 agency claim, 후속 순서 `dlalsrb8421` 0을 보여줍니다. 현재 격리 3건은 processing null이고, 이전 cycle에서 `provider_partial_window:37_300`으로 24시간 격리된 tracker는 cycle #9 tracker_claimed 0인 반면 이후 normal group은 계속 전진했습니다. 순서·격리·wake에 DB write는 수행하지 않았습니다.
- event 347~350은 04:00 KST 과거 격리 만료 tracker의 normal claim → collection `pw-chrome-1786734054279-dae4c55edd7c3ed63f9d` checkedCount 300 commit → `quarantine_cleared` 순서입니다. snapshot source/evidence/adExcluded 일치, excludedAdCount 45이고 terminal 뒤 circuit closed·processing 0·lane/run/lease null입니다. cycle 누적 8 distinct group/11 tracker/8 agency, 중복 0, snapshot 4/collection 3·atomic 위반 0이며 격리는 3→2로 감소했습니다.
- 04:03:27 KST SELECT-only snapshot은 runtime `1.1.7`, primary heartbeat 04:03:01, cycle #9 active, active 72 tracker/57 group/9 agency, claim 8 distinct group/11 tracker/8 agency, duplicate 0입니다. stale24 21·stale48 19·never 1·quarantine 2·processing 0, snapshot 4/collection 3·atomic violation 0, circuit closed·lane/run/lease null입니다.
- event 352~355는 04:10 KST normal claim → `provider_duplicate_identity:8:3:page_overlap:7` typed failure → 30분 quarantine 순서이며 snapshot 0입니다. terminal 뒤 circuit closed·processing 0·lane/run/lease null, cycle 누적 9 distinct group/12 tracker/8 agency, same-cycle duplicate 0, snapshot 4/collection 3·atomic violation 0입니다.
- event 357~359는 04:20 KST normal claim → collection `pw-chrome-1786735253508-646d551edb676754abd4` checkedCount 300 commit 순서입니다. snapshot source/evidence/adExcluded 일치, excludedAdCount 60이며 terminal 뒤 circuit closed·processing 0·lane/run/lease null입니다. cycle 누적 10 distinct group/13 tracker/8 agency, duplicate 0, snapshot 5/collection 4·atomic violation 0입니다.
- event 361~363은 04:30 KST normal claim → collection `pw-chrome-1786735854088-4378ef93bdce9cc2f8d1` checkedCount 300 commit 순서입니다. snapshot source/evidence/adExcluded 일치, excludedAdCount 45이며 terminal 뒤 circuit closed·processing 0·lane/run/lease null입니다. cycle 누적 11 distinct group/14 tracker/8 agency, duplicate 0, snapshot 6/collection 5·atomic violation 0입니다.
- event 365~368은 04:34~04:35 KST normal claim → `provider_duplicate_identity:6:0:page_overlap:5` typed failure → 30분 quarantine 순서이며 snapshot 0입니다. terminal 뒤 circuit closed·processing 0·lane/run/lease null, cycle 누적 12 distinct group/15 tracker/8 agency, same-cycle duplicate 0, snapshot 6/collection 5·atomic violation 0입니다.
- event 370~372는 04:40 KST normal claim → collection `pw-chrome-1786736452015-2b3072bca3bfa76a5c30` checkedCount 300 commit 순서입니다. snapshot source/evidence/adExcluded 일치, excludedAdCount 60이고 terminal 뒤 circuit closed·lane/run/lease null입니다. cycle 누적 13 distinct group/16 tracker/8 agency, duplicate 0, snapshot 7/collection 6·atomic violation 0입니다.
- event 374~376은 04:50 KST normal claim → collection `pw-chrome-1786737051499-0eee6fb4fa8be4d404f3` checkedCount 300 commit이며 excludedAdCount 45입니다. event 378~381은 05:00~05:01 KST 다음 normal claim → `provider_duplicate_identity:3:3:page_overlap:2` failure → 30분 quarantine이고 snapshot은 없습니다. 05:03 KST 누적 15 distinct group/18 tracker/8 agency, duplicate 0, snapshot 8/collection 7·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 384~405는 05:08·05:10·05:20 KST normal 3개 group의 tracker 2·4·1건을 각 collection `pw-chrome-1786738126015-69d93ec995321eb78800`, `pw-chrome-1786738247746-9a0cabdcf2c42e4637bb`, `pw-chrome-1786738851465-14da8ec89de83f2e3467`로 commit한 장부입니다. 모두 checkedCount 300·source/evidence/adExcluded 일치, excludedAdCount 30·45·45입니다. event 407~410은 05:30~05:31 KST `provider_duplicate_identity:3:20:page_overlap:1` failure→30분 quarantine이며 snapshot 0입니다. 05:35 KST 누적 19 distinct group/26 tracker/9 agency, duplicate 0, snapshot 15/collection 10·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 413~419는 05:40~05:41 KST tracker 2건의 동일 `provider_duplicate_identity:6:2:page_overlap:5` failure→30분 quarantine입니다. event 424~437은 05:50·06:00 KST tracker 4·1건을 collection `pw-chrome-1786740654958-bc4695a7b33a5b89c2bb`, `pw-chrome-1786741247516-00ff46a5325601794177`로 commit하고 두 번째 과거 격리를 해제한 장부이며, 모두 checkedCount 300·source/evidence/adExcluded 일치·excludedAdCount 45입니다. event 439~442는 6초 handoff 후 `provider_duplicate_identity:8:2:page_overlap:7` failure→30분 quarantine입니다. 06:06 KST 누적 23 distinct group/34 tracker/9 agency, duplicate 0, snapshot 20/collection 12·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 445~451은 06:10~06:11 KST tracker 2건의 동일 `provider_duplicate_identity:8:7:page_overlap:5` failure→30분 quarantine입니다. event 453~455는 06:20 KST collection `pw-chrome-1786742451483-b09ac4306d201161e793` checkedCount 300 commit이며 source/evidence/adExcluded 일치·excludedAdCount 45입니다. event 457~460은 06:30~06:31 KST `provider_duplicate_identity:7:3:page_overlap:6` failure→30분 quarantine입니다. 06:38 KST 누적 26 distinct group/38 tracker/9 agency, duplicate 0, snapshot 21/collection 13·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 462~478은 06:40 page-overlap 격리, 06:50·06:55 collection `pw-chrome-1786744251524-0e93029a62f33fb4454a`, `pw-chrome-1786744543667-00100cc5c02854bd6566` commit, 07:00 page-overlap 격리 순서입니다. 두 성공은 checkedCount 300·source/evidence/adExcluded 일치·excludedAdCount 45·30입니다. event 481~485는 07:10 KST tracker 2건을 collection `pw-chrome-1786745451655-0b9c3fbafb6cadb194f8` 하나로 commit했으며 checkedCount 300·excludedAdCount 30·위반 0입니다. 07:11 KST 누적 31 distinct group/44 tracker/9 agency, duplicate 0, snapshot 25/collection 16·atomic violation 0, circuit closed·lane/run/lease null입니다.
- event 487~490은 07:20~07:21 KST `provider_duplicate_identity:6:2:page_overlap:5` failure→30분 quarantine입니다. event 492~498은 07:30·07:40 KST collection `pw-chrome-1786746653449-6f30ff6c9c50bcc5e506`, `pw-chrome-1786747251377-406fd1d424462cd6e5af` checkedCount 300 commit이며 source/evidence/adExcluded 일치·excludedAdCount 30입니다. 07:43 KST 누적 34 distinct group/47 tracker/9 agency, duplicate 0, snapshot 27/collection 18·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 500~514는 07:50·07:56·08:00·08:10 KST 4개 normal group을 collection `pw-chrome-1786747850481-0f07b3803de4ef0b20bb`, `pw-chrome-1786748203461-2cd021068103172560ac`, `pw-chrome-1786748450941-eed0575b40186a3473f6`, `pw-chrome-1786749050186-835198f6f3cd7d47e303`으로 commit한 장부입니다. 모두 checkedCount 300·source/evidence/adExcluded 일치, excludedAdCount 30·60·45·45입니다. 08:14 KST 누적 38 distinct group/51 tracker/9 agency, duplicate 0, snapshot 31/collection 22·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 516~529는 08:20·08:30·08:40 KST 3개 normal group이 각각 `provider_duplicate_identity:4:12:page_overlap:2`, `provider_duplicate_identity:7:39:page_overlap:6`, `provider_duplicate_identity:3:8:page_overlap:2`로 fail-closed된 뒤 30분 quarantine된 장부이며 snapshot은 0입니다. 08:46 KST 누적 41 distinct group/54 tracker/9 agency, duplicate 0, snapshot 31/collection 22·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 531~547은 08:50·09:00 KST collection `pw-chrome-1786751453116-74db6318ce6fd780d232`, `pw-chrome-1786752047985-cc4fd002419eb319f608` checkedCount 300 commit과, 08:56·09:10 KST 두 group의 page-overlap failure→30분 quarantine을 교대로 기록합니다. 두 성공은 source/evidence/adExcluded 일치·excludedAdCount 30입니다. 09:18 KST 누적 45 distinct group/58 tracker/9 agency, duplicate 0, snapshot 33/collection 24·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 549~562는 09:20·09:30·09:40 KST normal 3개 group이 각각 `provider_duplicate_identity:8:5:page_overlap:7`, `provider_duplicate_identity:6:22:page_overlap:5`, `provider_duplicate_identity:4:3:page_overlap:3`으로 fail-closed된 뒤 30분 quarantine된 장부이며 snapshot은 0입니다. 09:50 KST 누적 48 distinct group/61 tracker/9 agency, duplicate 0, snapshot 33/collection 24·atomic violation 0, circuit closed·processing 0·lane/run/lease null입니다.
- event 564~589는 09:50·10:07·10:10·10:12 KST 네 `normal` group의 checkedCount 300 commit과 10:01 KST `provider_duplicate_identity:7:3:page_overlap:6` failure→30분 quarantine을 기록합니다. 10:16 KST cycle #9은 claim 53회/53 distinct group·68 tracker·9 agency로 duplicate 0이고, snapshot 39/collection 28의 source/evidence/adExcluded/checkedCount atomic violation 0, heartbeat 정상·circuit closed·processing 0·lane/run/lease null입니다.
- event 591~602는 10:20·10:24·10:30 KST 마지막 3개 normal group의 checkedCount 300 commit과 10:40 KST cycle_completed 장부입니다. cycle #9 roster 57 group/72 tracker 중 roster_state=quarantined 1 tracker를 제외한 56 group/71 tracker·9 agency를 한 번씩 claim했고 group claim event 56=distinct 56입니다. 성공 31 group/42 snapshot/31 collection은 source/evidence/adExcluded/checkedCount atomic violation 0이며, 실패 25 group은 duplicate 23·navigation 2로 snapshot 0, terminal 뒤 circuit closed·processing 0·lane/run/lease null입니다.
- 17:05 KST SELECT-only: runtime `1.1.5`, heartbeat age 10,741초, cycle #8 active/cursor 400, lane·lease·processing·cooldown 없음입니다. 활성 72 tracker/57 group/9 agency 중 현 cycle claim은 17/14이고 한 agency의 8건은 claim 0입니다. ledger event와 ledger 기준 중복 claim 증거는 0이므로 중복 없음으로 확대 판정하지 않습니다.
- stale24 28·stale48 27·never-checked 7·quarantine 0이며 오류 분포는 duplicate 26, partial 1, generic collection failure 1, 오류 없음 44입니다. 최근 24시간 `pw-chrome` 49 collection/66 snapshot의 checkedCount/source/adExcluded/rankEvidence 위반은 모두 0이지만 최신 snapshot은 13:56 KST로 멈췄습니다.
- 원격 Windows 실기에서 확장 UI `1.1.6`을 재로드하고 안전 갱신을 눌러도 새 nonce가 생기지 않았습니다. 최초에는 manifest와 Native Messaging 등록이 모두 없었고, 이를 복원한 뒤에는 host와 Node 프로세스가 잠깐 생성된 다음 위 import 오류로 종료됐습니다. DB는 runtime `1.1.5`·stale heartbeat 상태이므로 `1.1.6` 운영 성공 증거가 아닙니다.
- 재발 방지 회귀는 manifest name/origin 검증, HKCU 등록 write/readback, typed mismatch 실패와 성공 marker를 포함합니다. Windows bridge 10/10, server contract 49/49, release baseline, rank lock/self-test와 `git diff --check`를 통과했으며 전체 release·Production·Windows 실기는 후속 게이트입니다.
- 운영 SELECT-only 기준 시각은 2026-08-14 10:01 KST입니다. runtime `1.1.4`, heartbeat 48초, circuit closed, cooldown·lane·processing 없음, cycle #7 active/cursor sort 3200을 확인했습니다.
- 활성 66 tracker/51 keyword group/9 agency, cycle claim 63 tracker/48 group, 성공한 같은-cycle 중복 group 0, repair queued/claimed 0입니다.
- 미갱신은 24시간 23 tracker, 48시간 21 tracker, never-checked 1 tracker이며 현재 격리는 2건입니다. 마지막 오류 분포는 없음 37, `provider_duplicate_identity` 28, `provider_partial_window` 1입니다.
- 최근 24시간 collection 77건·snapshot 113행·tracker 43건에서 `checkedCount != 300`은 0건입니다. 이 원자성 증거는 전체 51 group 완주·오류 정상화 증거를 대신하지 않습니다.
- heartbeat automation `1-24`가 30분 간격으로 같은 기준을 기록합니다. 최종 합격은 24시간 후 cycle당 기존 group 1회, 신규 1회 우선 후 cursor 복귀, 전체 종료 뒤 다음 cycle, 격리 건너뛰기, 광고주별 coverage, same-cycle 중복 0, 원자 300 및 lane·lease 해제를 함께 확인해야 합니다.
- 첫 terminal 증거인 cycle #7은 2026-08-14 10:16 KST에 완료됐습니다. 9/9 agency·51/51 group·66/66 tracker를 각각 한 번 claim했고 claim-time 동일 group 중복은 0입니다.
- 성공 26 group은 26개 고유 collection·38 snapshot으로 저장됐고 `checkedCount != 300` 0건, collection ID 교차 재사용 0건입니다. 실패 25 group은 duplicate 24·partial-window 1이며 last-good을 유지했습니다. 이 결과는 순환 coverage·원자성은 증명하지만 전체 키워드 갱신 성공은 명백히 반증합니다.
- 10:32 KST 상호배타 원인 분류에서 stale24 23 tracker/20 group은 `page_overlap` 16/13, `duplicate_row` 6/6, `provider_partial_window` 1/1이며 기타·성공 stale·lease/circuit 정체는 0입니다. 보존된 signed traffic에는 5시간 29분 42초 공백이 있으나 당시 외부 원인은 미확정으로 남깁니다.
- 코드 감사는 P0 없음·원자 300/CAS 유지로 판정했습니다. 다만 partial/row 오류가 system scope로 전역 circuit을 열 수 있는 경로, 인증과 수집창 시계 허용 차이, 2MiB body 상한, 비원자 Windows 교체, 잘못된 request ID 장기 대기, 동일 키워드 100 tracker 상한, 부분 submit 식별, durable cycle 운영 이력 부재를 별도 P1로 기록합니다.
- v1.1.5 회귀는 same-page 반복 identity를 오가닉 순위 1~300 그대로 유지하고 exchange 1회로 완료하며, rank 1↔41 cross-page 반복은 collector·contract·server 세 경계 모두 거절합니다. strict partial `40/300`은 `provider_partial_window:40_300` tracker failure로 남고 global lane block 호출은 0회입니다.
- `npm run check:release`는 core 517/517, Place 51/51, Shopping 57/57, server contract 46/46, Production auth 18/18로 통과했습니다. 보호 잠금은 22함수·78파일·28 migration이며 `git diff --check`도 통과했습니다.
- Production `/health`·`/ready` release `40da76857484`, DB migration `naver_shopping_runtime_1_1_5`, Windows runtime `1.1.5`/fingerprint `7ec0891e023d43d7a43c8f74a9c0e359c21e7dfd1f03b054a9d0290bddf7299e`가 일치합니다. 새 collection `pw-chrome-1786679023142-f1d2bb80ad9ea6963f70`은 `치아미백제`를 source `naver_shopping_results_collector`, rank evidence `naver_shopping_organic_list`, `adExcluded=true`, `checkedCount=300`, 51위로 원자 저장했고 terminal 뒤 circuit closed·lane/lease/run 해제를 확인했습니다.
- runtime 함수 `mi_report_naver_shopping_worker_progress`, `mi_get_naver_shopping_worker_operations`, `mi_set_naver_shopping_worker_cadence`는 모두 SECURITY INVOKER·빈 search path·`postgres/service_role` execute-only입니다. 이 배포·단일 terminal은 실기 기동 증거이며, 24시간 공정성·전체 성공률과 cross-page 오류 해결 증거로 확대하지 않습니다.
- 12:57 KST 후속 SELECT-only 표본은 runtime `1.1.5`, cycle #8 active, cursor sort 200, 8/51 group claimed·43 group unclaimed, processing 0·quarantine 2·circuit closed·cooldown/lane 없음입니다. 현재 cycle 성공 4 group/4 collection/7 snapshot에서 원자 300 위반과 같은 group 복수 성공 collection은 각각 0건입니다. stale24 23·stale48 21과 duplicate 28·partial 1은 여전히 남아 있습니다.
- 13:19 KST 표본은 10/51 group claimed·41 unclaimed, 성공 5 group/5 collection, 원자 300 위반·성공 중복 각각 0, stale24 22입니다. 13:06 KST `성장기칼슘`은 generic `local_worker_collection_failed`로 실패하고 13:16 KST `콘트로이친`은 성공했습니다. 성공 뒤 failure streak 0·circuit closed·lane null이므로 순환은 계속됐지만 generic 실패의 하위 원인은 현 저장 증거로 미확정입니다.
- v1.1.6 대상 회귀는 malformed row group 격리 후 다음 keyword 원자 300 제출, 인증·수집창 ±300초/±301초 경계, wrong/missing request ID 즉시 종료·lane 해제, 4MiB 상한과 HTTP 413 tracker 격리, mixed partial의 `processedCount` suffix 해제를 포함합니다. 현재 `npm test`는 core 537/537·Place 51/51·Shopping 57/57, server contract 49/49, baseline, 보호 잠금 22함수·80파일·30 migration을 통과했습니다.
- scheduler ledger 정적 회귀 9/9와 실제 PostgreSQL shadow transaction을 통과했습니다. service_role 직접 INSERT와 anon SELECT는 거절되고, authenticated tracker/snapshot 쓰기는 audit trigger 때문에 롤백되지 않으며, 같은 cycle의 동일 group 재claim·cycle 중 신규 roster·commit/fail/quarantine 이력이 기록된 뒤 전체 transaction rollback 및 test schema 부재를 확인했습니다.
- 전체 `check:release`는 core 537/537·Place 51/51·Shopping 57/57, server contract 49/49, Production auth 18/18, 공개 build/CSP까지 통과했습니다. Production release, DB migration, Windows v1.1.6 및 자연 terminal은 아직 미검증이므로 운영 정상화나 24시간 완주로 보고하지 않습니다.

## 2026-08-13 N쇼핑 중복 오류 격리 상한 회귀

- 운영 활성 66건 중 24시간 미갱신 23건, 그중 중복 식별 계열 22건을 확인했습니다. 현재 격리 19건은 모두 같은 오류 계열이었고 runtime `1.1.4` heartbeat·cycle #6·circuit closed로 작업기 정지는 배제했습니다.
- migration 회귀는 suffix가 붙은 중복 오류도 정확히 30분으로 제한하고, 다른 tracker 오류의 누적 24시간 정책은 유지함을 검증합니다. 기존 격리 복구문은 quarantine 시각 외 `sort_order`, `next_check_at`, cycle cursor/소유권, retry, current/last rank를 변경하지 못하게 잠급니다.
- 전체 `npm run check:release`, server contract 44/44, 보호 잠금 22함수·77파일·27 migration, Production 인증 18/18과 `git diff --check`를 통과했습니다.
- Production `1c778c655d2b`·Supabase ready와 migration 적용을 확인했습니다. 활성 격리는 19→3건으로 줄었고, `침구청소기`가 신규 우선 슬롯 뒤 기존 cursor에 재진입했습니다. terminal은 `provider_duplicate_identity:4:22:duplicate_row:4`로 30분 fail-closed, last-good 45위 유지, lane·lease 해제였으므로 재진입·순서 복귀·무한루프 방지는 증명했지만 해당 키워드의 새 300개 성공 증거로 확대하지 않습니다.

## 2026-08-13 N쇼핑 v1.1.3 운영 결과·v1.1.4 회귀

- v1.1.3 명시 새로고침 뒤 canary `남자팬티`는 광고 제외 오가닉 300개·50위로 완료됐습니다. 복구 요청에서 `남자 사각팬티`는 새 collection으로 17위·300개를 저장했고, `남성 사각팬티`는 suffix 2회 뒤 `provider_duplicate_identity:8:2:page_overlap:7`로 종료돼 23위 last-good을 보존했습니다.
- 실패 항목은 자동 재큐잉되지 않았고 lane·lease가 해제됐으며 정상 durable cycle cursor는 다음 항목으로 전진했습니다. 따라서 무한루프·전체 정지는 재현되지 않았지만 두 번째 항목의 정상화 증거도 아닙니다.
- v1.1.4 회귀는 `range-v1` ready/ack 불일치 시 claim 전 종료, suffix exact range와 구 실행문맥 full-window 호환의 1회 제한, 두 번째 full 응답 첫 프레임 거절, 최대 4회·16페이지, 절대 deadline, same-page duplicate 무재시도, 최종 전체 300개 재검증을 포함합니다.
- 전체 release·보호 잠금, Production `81a5149aa2a8`, DB runtime gate, Windows runtime `1.1.4`/fingerprint `03bd6305…`를 확인했습니다. 남은 `남성 사각팬티`는 request `8226b9ca…`에서 1회 소비됐고 collection `pw-chrome-1786631085529-7ade3dcbc4ebf989fcde`, 광고 제외 오가닉 `checkedCount=300`, 17위로 성공했습니다. 오류·격리·retry는 해제됐고 정상 cycle #6 cursor는 1500으로 전진해 다음 tracker 수집을 시작했습니다.
- Windows watchdog의 동일 실행파일 오인 회귀는 same Chrome 실행 시 exact profile `--no-startup-window` handoff, Chrome 부재 시 최소화 실행으로 분리했고 Windows 9/9·server contract 43/43·baseline·보호 잠금을 통과했습니다.

## 2026-08-13 N쇼핑 상품 식별 중복·경계 복구 회귀

- 운영 읽기 전용 감사에서 duplicate 오류 27 tracker·24 keyword group·6 agency를 확인했습니다. 두 대상은 약 43~45초 뒤 같은 base code로 종료됐고 DB cycle·lane 고립은 아니었습니다. 과거 상세는 저장되지 않아 정확한 충돌 신호는 미확정으로 남깁니다.
- provider·collector contract·server trusted window에 같은 단일 authoritative identity 규칙을 적용했습니다. 서로 다른 seller가 공유하는 weak product ID는 허용하고 동일 seller/catalog/URL은 계속 거절합니다.
- v1.1.2 운영 재검증은 전체 재수집 뒤에도 `provider_duplicate_identity:7:3:page_overlap:6`으로 종료됐습니다. v1.1.3은 전체 8페이지 1회 후 origin page~8 suffix만 최대 2회 교체하고 매번 전체 1~300을 다시 검증합니다. 최대 이동 16페이지, 원 요청 절대 deadline, 최종 typed error를 고정하며 행 skip·압축과 same-page duplicate 재시도는 금지합니다.
- 복구 큐는 forced RLS·service-role-only, lane token/run CAS, FIFO 1회 소비, idempotent enqueue wake 1회, cursor/next_check 불변을 검사합니다. 두 tracker를 1번·2번으로 처리한 뒤 기존 cycle로 handoff하며 실패 자동 재등록은 없습니다.
- 경계 단위 회귀는 6→7 suffix 성공, 이동 경계 6→7 재조정, 16페이지 예산 초과, deadline 직전 추가 교환 금지, same-page duplicate 무재시도를 포함합니다. 전체 release·보호 잠금·DB SQL parser·Windows 실로드·운영 두 건 결과는 최종 배포 증거에서 별도로 기록합니다.

## 2026-08-12 N쇼핑 30일 영속 순환 회귀

- 운영 읽기 전용 감사에서 worker·circuit·lane은 정상이지만 전체 갱신과 광고주 round-robin 조합으로 24시간 수집의 68.75%가 반복 초과였음을 확인했습니다.
- 전용 migration 회귀 2/2, handler·runner·cron 통합 151/151, 전체 `npm run check:release`, 보호 잠금 22함수·71파일·22 migration, `git diff --check`를 통과했습니다.
- resume cursor의 stale `FOUND` 무한대기, probe 동일 키워드 과다 claim, 공백이 다른 동일 키워드 mismatch를 배포 전 독립 검토에서 발견해 각각 `seed.id` 판정·exact probe ID·동일 정규화 규칙으로 수정했습니다.
- 운영 DB migration 적용 직후 cycle `idle`, active tracker 65, 격리 제외 eligible 46을 확인했습니다. Production `074c3a25d644`와 Windows `074c3a2` 동기화 뒤 cycle `0ef2d2f0-afea-44ce-b93c-53176db07514`에서 서로 다른 keyword group 4개·tracker 7건을 claim했고, 동일 keyword의 광고주 2건은 한 collection으로 묶였습니다. 7건 모두 원자 `checkedCount=300` terminal, 마지막 광고 제외 45개, failure streak 0, circuit closed, lane·tracker lease 해제를 확인했습니다. 이 초기 연속성 증거는 24시간 전체 cycle 완주 증거를 대신하지 않습니다.

## 2026-08-12 키워드 연령별 쇼핑 클릭 비중 회귀

- 첫 Production release `766d26faf8f3`은 월 검색량·추이는 표시했지만 운영 서버의 `mobile_top_fallback` 실패로 category가 비어 연령 그래프가 `조회 후 표시`에 머물렀습니다. 실패 payload는 캐시되지 않았고 재조회에서도 같아 정상화 증거로 사용하지 않습니다.
- 공식 API 실검사는 `남자팬티`의 10개 대분류 요청이 모두 HTTP 200이고 `50000000`만 6연령대·최신 완료 월·6개월 이상 완전 데이터를 가진 단일 후보임을 확인했습니다. sparse 양수 행만 있는 잘못된 분류는 후보로 인정하지 않습니다.
- handler 회귀는 공식 age 요청 10개 뒤 선택 payload를 재사용하고 device·gender만 추가해 총 12회인 정상 경로와, stale 6개월·후보 2개를 `category_required`로 종료하는 경로를 검증합니다. 429는 첫 배치 2회 뒤 남은 호출을 즉시 중단하고 5분 negative TTL로 다음 조회 탐색을 0회로 줄입니다. 성공 프로필도 쇼핑 표본 실패 중 30분 TTL cache를 사용하며, 기존 표본 category ID가 있으면 probe 없이 기존 age 1회 경로를 유지합니다.
- 관리자·광고주 HTML의 `data-keyword-ratio-chart="age"`, 5개 레이블, 기존 `renderRatioChart` 계약은 변경하지 않습니다. N30 공유 parser를 이전 hash로 복원한 상태에서 키워드 handler 22/22와 관련 fallback·tracker 19/19를 통과했습니다.
- 전체 `npm run check:release`, 보호 잠금, `git diff --check`를 통과했습니다. Production release `d2a087a54562`·deployment `dpl_4ofFYdX7xELkHXDyiw2g5g3wDRGz`는 READY이고 `/health`·`/ready` 및 Supabase ready가 일치합니다.
- 로그인된 총관리자 화면에서 `남자팬티` 조회가 월 검색량 30,770, 성별 여성 28%·남성 72%, 연령 막대 `10대 0.5 / 20대 3.9 / 30대 18.3 / 40대 35.2 / 50대 이상 42.1%`를 렌더하고 조회 상태가 `월 검색량과 검색 비율이 확인되었습니다.`로 완료되는 것을 확인했습니다.

## 2026-08-12 키워드 공식 API·N 상품 단건 숨김 회귀

- `npm run check:env:naver`에서 keyword feature, SearchAd 3종, API HUB key pair·hub mode가 모두 ready입니다. API HUB live 검사는 blog 1건·Search Trend 31건·Shopping Insight age 11건을 각각 HTTP 200으로 확인했습니다.
- 실제 handler의 `남자팬티` 조회는 HTTP 200, `naver_searchad_exact`, `naver_api_hub`, 월 검색량 30,770, 검색 추이 37구간, 연관 키워드 10개, warning 0을 반환했습니다. Production 로그인 화면에서도 같은 월 검색량과 경쟁도 높음을 확인했습니다.
- 역할 회귀는 양 역할 키워드 메뉴·실행 버튼·API endpoint를 유지하고, N 상품 단건 메뉴·view 0개와 직접 hash fallback을 검증합니다. N 30일·N 플레이스 30일 화면과 생성·갱신 경로는 유지합니다.
- 상품순위 서버와 Windows 작업기는 SEO·자동 추적 공유 경계이므로 수정하지 않았고 보호 기능 잠금이 통과했습니다.
- Production `dpl_EYbXYLFfekTnVP39zhG1PasR8aJm`은 READY·운영 별칭 연결 상태입니다. `/health`·`/ready`는 release `a035a87f3854`, region `icn1`, Supabase ready이고 `/home`·`/admin`·`/client` 배포 구조 검사가 통과했습니다.
- 로그인된 총관리자 운영 화면에서 `남자팬티` 조회가 30,770회, 경쟁강도 높음, 월별·요일별 검색 추이와 연관 키워드를 렌더했습니다. `#mi-admin-naver-rank`는 `#mi-admin-home`으로 정규화됐고 두 검증 탭의 console error는 0건입니다.

## 2026-08-12 전체 품질 고도화 1차 회귀

- 홈 상태 스트립은 `position: fixed` 재도입을 금지하고 데스크톱 1120px shell·모바일 28px gutter, 기본 상세 `hidden`, `aria-expanded`/`aria-controls`, 닫기·1주 숨김을 baseline에 고정했습니다.
- 보고서 보안 회귀 11건은 타 광고주 `reportId` 선차단, Storage 보상 삭제, 잘못된 메타데이터 선차단, 기존 보고서 파일 실패 시 UPDATE 0회, 후속 갱신 실패 시 새 파일 행 제거와 정리 실패 표면화를 검증합니다.
- `check:baseline`, `check:server-contract`, server syntax, Vercel build, public CSP build와 `git diff --check`를 통과했습니다. 홈 inline script 변경으로 발견된 CSP hash 차단은 새 실제 SHA-256으로 교체하고 stale hash를 제거한 뒤 다시 통과했습니다.
- Supabase는 읽기 전용으로 table size/RLS와 security·performance advisor를 확인했습니다. schema·정책·데이터 쓰기는 수행하지 않았습니다.
- 독립 재검토에서 기존 보고서 rollback이 `updated_at`을 바꾸는 결함을 발견해, 기존 보고서는 파일 성공 후에만 UPDATE하도록 수정했습니다. 최종 재검토는 해당 경계와 생성 보고서 보상 처리에 배포 차단이 없다고 판정했습니다.

## 2026-08-12 N쇼핑 백그라운드 작업기 회귀

- 확장 popup은 `popup.js`만 로드하고 `지금 안전 갱신`/`run-now` 계약을 유지하며, 서비스 워커가 `popup.html?controller=1` 가시 탭을 새로 만들지 않음을 잠급니다.
- direct worker 요청은 실행 중 `manual > catch-up > 09/15 > remote` 단일 신호 병합을 유지하고, idle이면 native worker를 직접 시작합니다. 20초 keepalive는 즉시 시작·주기 실행·terminal 정리를 VM으로 검증합니다.
- 일반 수집의 `active:true` 사용을 금지하고, 보안확인 표시 함수에서만 네이버 탭과 창을 활성화하도록 분리합니다. 구형 controller 탭은 update/startup에서 유한 삭제합니다.
- 직접 8페이지·3.5~6초 pacing·페이지 스트리밍·원자 300개·native input-close·6초 handoff·typed error 회귀를 함께 유지합니다.
- 전체 `check:release`는 앱/API 449, Place 51, Shopping 52, Production 인증 18/18과 Vercel build·CSP·보호 잠금을 통과했습니다. Production release `ecb9a99aab1b`의 `/health`·`/ready`, admin/client 200, 비인증 rank job 401을 확인했습니다.
- Windows updater는 `MI_EXTENSION_UPDATE_OK`, `loaded_extension_synced=true`, service worker SHA `975238a7488e16c207040f82cb74284d52184b6e38ee261db6ba5e46a040c8c4`를 반환했습니다. 새 runtime fingerprint `fd95e1bd7cf9ede4c13ec25fa65195345e0b37a4ed3f5cc38586c293412c6a60`으로 page 1/8 진입부터 terminal까지 화면 전환 없이 수집했고, popup 버튼도 그대로 표시됐습니다.
- 실기 collection `pw-chrome-1786470467501-e0fc34d1aad12f964b44`는 source `naver_shopping_results_collector`, evidence `naver_shopping_organic_list`, `checkedCount=300`, `organic_only`, `adExcluded=true`, 광고 45개 제외, 정확 상품 `12491798995` 93위로 완료했습니다. 이후 circuit closed, run·probe·global lane·tracker lease 해제와 격리 없음까지 확인했습니다.

## 2026-08-12 N플레이스 일별 카드 진실성 회귀

- 운영 snapshot 대조로 대상 직접 리뷰 232·3,594와 기존 검색결과 집계 65,108·264,467의 차이를 확인했습니다. 새 renderer는 direct `snapshot.place`만 읽고 aggregate-only fixture는 `null`로 거부합니다.
- 관리자·광고주 renderer와 상태 계산을 정규화 비교하며 `월검색`·`업체`·nested `place.metrics`가 일별 카드에 다시 들어오지 않도록 잠갔습니다.
- 직전 기록이 미확인인 경우 `첫 순위 기록`으로 오표시하지 않고 `직전 순위 미확인` 또는 `비교 기록 없음`으로 표시합니다.
- 화면 목록은 keyboard focus를 지원하고 최신 기록을 navy로 강조합니다. 이미지 내보내기는 6열·overflow 해제 계약으로 30일 전체를 포함합니다.
- `check:release`, 역할 parity, baseline, 보호 잠금, CSP public build와 `git diff --check`를 배포 전 필수 gate로 유지합니다.

## 2026-08-11 총관리자 전용 개발 운영센터 로컬 증거

- `/api/owner/tool`은 익명·team·잘못된 owner identity를 403으로 거절하고 정확한 `mml93-a01` owner에만 동적 개발 nav group과 두 owner view를 반환합니다.
- 공개 admin/client source의 실제 markup에는 `owner-development`, `owner-utility`, `data-rank-worker-operations`가 없고, `N 30일 순위` view slice에도 운영 패널이 없습니다. 인증 후 검증된 payload만 nav와 view를 삽입하며 로그아웃 때 모두 제거합니다.
- root 기반 canary target·제어 위임, owner deep-link, restored team의 forged hash 정규화, 기존 VAT 계산 계약을 회귀로 고정했습니다.
- 집중 회귀 71/71, role-state, baseline, role-query parity, 보호 잠금, Vercel public build와 `git diff --check`가 통과했습니다.
- Production commit `6a1076899183`·deployment `dpl_HUQadoTJ3qTP1DFxVnKfiNEvQfGb`는 READY이며 `/health`·`/ready`가 같은 release·Supabase ready를 반환했습니다. 실제 `mml93-a01` owner 화면에서 개발 그룹 1개, owner view 2개, `aria-current=page`, 표시된 운영 패널과 오가닉 300개 증거, N30 내부 패널 0개, 가로 넘침 0을 확인했습니다. 초기 빈 패널은 실패가 아니라 계정 범위·운영 상태 API 로딩 구간이었고 약 10초 내 정상 지표 646자가 표시됐습니다.
- `테스트 1건 검증` 버튼의 정확한 렌더링과 과거 `남자팬티 1건 검증` 버튼 부재를 회귀에 추가했습니다. 집중 66/66, 보호 잠금·self-test, 전체 앱/API 448, Place 51, Shopping 52, Production 인증 18/18과 전체 `check:release`가 통과했습니다.

## 2026-08-11 N쇼핑 자동 순환 연속성 v1.1.1 로컬 증거

- controller VM 회귀는 실행 중 catch-up 두 건을 한 건으로 합치고 remote가 이를 덮지 않으며, 현재 회차 종료 뒤 단 한 번 인계되는 것을 검증합니다. Node terminal frame flush·입력 종료, Windows child 종료 뒤 relay join 전 mutex 해제, 6초 handoff, 수동 요청의 보안확인 cooldown 재검사, `control_plane_failed`·idle·알 수 없는 summary의 false-complete 차단도 고정합니다.
- local worker 회귀는 정상 closed 순환의 `provider_duplicate_identity:3:26`을 base code로 비식별화해 tracker scope로 격리하고 maxJobs 2에서 다음 정상 job까지 처리하며, network 제한은 security scope·전역 block을 유지함을 검증합니다. half-open canary 실패의 circuit 재개방 계약은 기존 control-plane 회귀를 유지합니다.
- 서버 후보 조회는 신규 `created_at,id`, due `next_check_at,created_at,id` 순서를 고정했습니다. 신규 우선 DB 함수는 row lock·aging·광고주 round-robin·service_role 전용 권한을 유지합니다.
- 대상 회귀 145/145, server contract 41/41, release baseline과 운영 DB의 rollback parser 검증이 통과했습니다. 보호 잠금·전체 release·배포·Windows 실기는 아래 완료 증거가 추가되기 전까지 미완료입니다.

## 2026-08-11 N쇼핑 자동 순환 연속성 v1.1.1 운영 증거

- DB migration `20260811120243_naver_shopping_queue_continuity`, Windows 1.1.1/fingerprint `ed2e0692fb1d98d2f0eea26fa73e8eb1ecd5921f1dd2b8a82de10b1f214b926c`, 기능 Production commit `f49d93d061eb`/deployment `dpl_DeJghmAKeVPUSMZprGF6vUyjv7hp`를 확인했습니다. 해당 기능 배포 검증 시 `/health`와 `/ready`는 release `f49d93d061eb` 및 Supabase ready를 반환했습니다.
- 신규 우선: 21:18 KST 미검증 `강아지사료`를 첫 슬롯에서 claim했습니다. `provider_duplicate_identity` terminal은 신규 snapshot 없이 last-good를 보존하고 해당 tracker만 24시간 격리했으며 circuit closed와 global/tracker lease 해제를 유지했습니다.
- 단독 canary: `남자팬티`/product `12491798995` collection `pw-chrome-1786451158772-13372ef3800e1ee373a8`은 source `naver_shopping_results_collector`, checkedCount 300, 광고 45개 제외, 100위로 원자 완료했습니다. circuit closed, probe/run/lane/tracker lease가 모두 해제됐습니다.
- 자동 인계: 다음 10분 catch-up은 기존 due `치아미백제`를 자동 claim했습니다. collection `pw-chrome-1786451344481-f10f7157eb70e146d1e1`은 checkedCount 300, 광고 44개 제외, 46위로 완료됐고 success streak 2, circuit closed, 모든 lease 해제를 확인했습니다.
- 관리자 canary target이 operations panel에 렌더되지만 click handler가 card에서 읽던 결함을 수정했고 release baseline에 정확한 DOM 계약을 추가했습니다. 첫 기능 배포 후보는 보호 잠금, 두 번째는 CSP hash가 각각 fail-closed로 차단됐으며 운영 alias는 바뀌지 않았습니다. 잠금·CSP 동기화 후 Vercel 전체 배포 검사가 통과한 기능 배포 `f49d93d061eb`만 Production READY가 됐습니다.
- 위 증거는 `신규 우선 → 개별 실패 격리 → canary 성공 → 기존 자동 인계`의 복구 완료 증거입니다. 전체 tracker의 24시간 완주는 아직 측정하지 않았으며 `준비작업 1번`에서 별도 감사합니다.

## 2026-08-11 개발 폴더·실행 문서 정리

- `git status --ignored`, `git clean -nd/-ndX`, 생성물 패턴, 0바이트 파일, 용량을 읽기 전용으로 감사했습니다. 삭제 가능한 실제 잔재는 재생성되는 `dist` 1개뿐이었고 `npm run clean:workspace`로 제거했습니다.
- `.env.local`, `.vercel/project.json`, `.vercel/.env.production.local`, 전체 소스·마이그레이션·운영 문서, root/tool `node_modules`는 개발·배포에 필요하므로 보존했습니다. 정리 후 `npm run clean:workspace:dry`는 `Workspace is already clean`입니다.
- 현재 `NEXT_ACTIONS.md`는 `준비작업 1번`과 5차 보류만 남겼습니다. 교체된 466줄 원문은 Git commit `3980589`에 보존하고 `archive/NEXT_ACTIONS_HISTORY_THROUGH_2026-08-11.md`에는 요약 인덱스만 두어 중복 문서를 만들지 않았습니다.
- 문서 이동 후 전체 `npm run check:release`가 통과했습니다: 보호 잠금 22함수·69파일·20마이그레이션, 앱/API 444, 플레이스 51, 쇼핑 52, Production 인증 18. 코드·DB·수집 runtime은 변경하지 않았습니다.

## 2026-08-11 N쇼핑 운영 제어면 v1.1.0 로컬 게이트

- 워커·서버 핸들러 59/59, native/Windows bridge 22/22, 순위 API·운영 UI 66/66, server contract 40/40, release baseline, 보호 잠금 22함수·69파일·20마이그레이션, 전체 `check:release`(앱/API 444, 플레이스 51, 쇼핑 52, Production 인증 18), `git diff --check`를 통과했습니다.
- 회귀는 구버전 runtime 사전 차단, nonzero fingerprint, page 진행, exact atomic300, 같은 시스템 실패 2회 차단, 보안 cooldown, tracker 30분/24시간 격리, urgent 2건 상한·aging·광고주 round-robin, canary 1건, candidate 증거 gate, 실패 시 baseline 10분 복귀를 포함합니다.
- 직접 수집 경로·3.5~6초 pacing·광고 제외·마지막 정상값 보존은 변경하지 않았습니다.
- 운영 DB 증거: migration 이력 `20260811095137`, 함수 12/12, 모두 security invoker, PUBLIC·anon·authenticated execute=false, service_role=true, coordination RLS/force RLS=true, anon table select=false, tracker quarantine column=true를 확인했습니다. 작업 상태는 closed·baseline 10분·lane 없음·processing 0·candidate=false입니다.
- Supabase security advisor의 coordination 항목은 service-role 전용 RLS 테이블에 정책이 없다는 INFO이며 직접 권한 검증으로 외부 접근 차단을 확인했습니다. 기존 별도 함수·테이블 advisor 항목은 이번 순위 제어면 범위에서 변경하지 않습니다.
- Production commit `2d16b3d425e8`/deployment `dpl_35bXeh7eJiwZA7n9NyaFhFQD1SiV`의 health·ready 200과 Windows 1.1.0 설치 성공 마커를 확인했습니다. 실 canary는 `남자팬티`/seller product `12491798995`, collection `pw-chrome-1786444926878-415c0336e1c6a0df873c`, rank 100, page 3/position 20, checkedCount 300, 광고 제외 45, source `naver_shopping_results_collector`, organic-only, exact-product, atomic gate true입니다. 완료 뒤 circuit closed, lane·processing 0, probe 해제를 확인했습니다.

## 2026-08-11 N쇼핑 무한반복 금지 문서 계약

- 실패 원장에는 native relay·설치 바이트 손상, controller 동결 최우선 가설과 예방 보강, 확인된 watchdog 재최소화·중복 host, 불안정한 검색 경로, lookup lease 정밀도 불일치, 29분/15분 deadline 불일치, 네이버 보호 신호를 사실의 확정 수준과 함께 기록했습니다.
- 복구 증거는 기능 commit `674f088e3304`, Windows 1.0.48, canary `c70da9f9-15c5-450a-aa0b-515d63f4e69f`, collection `pw-chrome-1786433529434-26068a983fc715bd46ce`, 오가닉 300개·광고 45개 제외·100위, 증거 commit `20e6cd982cdf`, Production deployment `dpl_H11fdEb6Ao63VzQKYXWNuvv6Le2X`로 고정했습니다.
- 문서 계약은 동일 실패 2회 후 추가 요청 중단, `남자팬티` 단독 canary, 자동 fallback 금지, 설치 파일 해시 확인, partial·제한 결과 미반영, Windows/Mac 단일 lane, 유한 timeout·lease·polling, 원자 300개 이후에만 전체 순환 재개를 요구합니다.
- 이번 변경은 문서·운영 절차만 고정하며 런타임 자동 circuit breaker가 새로 구현됐다고 주장하지 않습니다.

## 2026-08-11 native 요청 deadline 계약 정렬 v1.0.48

- 실기 증거: lookup `c70da9f9-15c5-450a-aa0b-515d63f4e69f`는 `2026-08-11 07:12:24.365+00`부터 `07:13:09.817+00`까지 45.452초 처리된 뒤 `attempts=1`, `error_code=local_worker_collection_failed`, 결과·collection 없이 pending으로 복귀했다.
- 무외부 재현: 같은 시작 시각에서 기존 `localWorkerRankRequest`가 만든 deadline은 `07:41:24.365+00`이고 45.452초 뒤에도 1,694,548ms 앞이었다. 공유 collector의 최대 15분 계약으로 검증하면 정확히 `invalid_request`, detail `deadlineAt`이 발생함을 Naver 요청·DB 쓰기 없이 재현했다.
- 수정 회귀: Windows launcher가 timeout 환경값을 주지 않는 상태, 기본 deadline 14분, 60분 override의 14분 clamp, 생성 45초 뒤 실제 `validateRankRequest` 통과를 검증한다. 서버·release 정적 gate도 runner와 contract의 동일 14분 상한을 요구한다.
- 통과: 대상 55/55, server contract 39/39, release baseline, 보호 잠금 22함수·68파일·19마이그레이션과 self-test, 전체 `npm run check:release`, `git diff --check`가 통과했다.
- 운영 증거: commit `674f088e3304`, Production deployment `dpl_Fzs2WQk68yYDBcXAwthVGbaNr27b`, Windows extension 1.0.48 설치를 확인했습니다. 동일 lookup `c70da9f9-15c5-450a-aa0b-515d63f4e69f`는 `completed`, `collection_id=pw-chrome-1786433529434-26068a983fc715bd46ce`, source/evidence 일치, 오가닉 300개, 광고 45개 제외, complete/비partial, 상품 ID 양쪽 일치의 atomic gate를 모두 통과했습니다. `남자팬티` 정확 상품 순위는 100위(3페이지 20번째)이며 완료 뒤 active lookup·tracker lease와 global lane은 모두 0/해제 상태입니다.

## 2026-08-11 Chrome 수집 단계 진단·5일 전 직접 경로 복원 v1.0.47

- 재현 경계: `남자팬티` 단독 작업은 claim 후 273.358초에 fail RPC를 보냈지만 저장된 오류는 일반 `local_worker_collection_failed`여서 Chrome 원문 오류가 발생한 실제 단계를 구분할 수 없었습니다.
- 구현 증거: 실제 오류 정규화 함수를 Node VM에서 실행해 기존 typed 코드 보존과 원문 비노출을 검증했습니다. 라이브 수집은 v1.0.5와 같은 `/search/all` 1~8페이지 직접 URL만 생성하며 홈·일반검색·가격비교 더보기 코드는 제거했습니다.
- 경로 회귀: `남자팬티` 8페이지 URL의 `where=all`, `frm=NVSCTAB`, `pagingIndex=8`, `pagingSize=40`, `productSet=total`, `sort=rel`, `viewType=list`와 3.5~6초 대기 양 끝값을 런타임으로 검증합니다.
- 완료 회귀: 8페이지의 진행 상태 저장과 완료 후 확인 상태 정리를 동시에 실패시킨 VM 실행에서도 `collection_page` 8개 뒤 `collection_complete`가 발생하고 `collection_error`가 없음을 검증합니다.
- 검사 증거: 서비스 워커 문법, native-host 17/17, server contract 39/39, release baseline, 보호 잠금 22함수·68파일·19마이그레이션과 self-test, 앱·API 422/422, 플레이스 51/51, 쇼핑 52/52, Production 인증 18/18, 전체 `npm run check:release`, `git diff --check`가 통과했습니다.
- 운영 경계: controller·스트리밍·접속 제한 감지·공용 차선·원자 300개·lease 정밀도는 유지합니다. 설치·배포·운영 쓰기는 수행하지 않았으며 Windows 설치 후 `남자팬티` 단독 원자 300개 전에는 정상화로 판정하지 않습니다.

## 2026-08-11 N쇼핑 lookup lease 정밀도 회귀

- 재현 증거: 작업 `f4bf2076-43e8-4178-aa18-37e40333a993`은 DB lease `2026-08-11 05:08:24.333392+00`로 처리됐고, 서버 계약은 이를 `2026-08-11T05:08:24.333Z`로 직렬화합니다. 기존 완료·실패 RPC의 정확 비교는 이 값을 다른 lease로 판정해 결과와 오류를 모두 저장하지 못했습니다.
- 수정 검증: claim 시각 밀리초 정렬, 기존 마이크로초 lease의 완료·실패 fallback, `FOR UPDATE SKIP LOCKED`, 완료 행 잠금, service-role 전용 권한을 회귀로 고정했습니다.
- 통과: lookup·local worker 집중 회귀 49/49, 앱·API 419/419, 플레이스 51/51, 쇼핑 52/52, server contract 39/39, Production 인증 18/18, baseline, 보호 잠금 22함수·68파일·19마이그레이션과 self-test, 전체 `npm run check:release`, `git diff --check`.
- 운영 증거: Supabase 적용 및 같은 단독 작업의 terminal 결과 확인 대기. 원자 `checkedCount=300` 전에는 정상 수집으로 판정하지 않습니다.

## 2026-08-11 Windows 10분 watchdog 재최소화 차단 v1.0.46

- 1.0.44가 실행 직전 컨트롤러를 복원해도 스케줄러가 10분마다 같은 Chrome을 `Minimized`로 재호출하는 충돌을 확인했습니다.
- 현재 사용자 세션의 정식 Chrome 프로세스가 있으면 watchdog가 재시작하지 않도록 차단하고, Windows bridge 회귀에서 시작 순서와 바이패스 금지를 같이 검증합니다.

## 2026-08-11 Windows 숨김 컨트롤러 동결 해제 v1.0.44

- 원인 증거: 1.0.43에서 정확히 5분 경계의 중단이 재현됐고, scheduler·native·DB timeout에는 같은 경계가 없습니다. Chrome의 숨김 탭 freeze가 유일한 정확 5분 경계라서 최우선 원인으로 보완하되, 실기 `frozen` 관측 전에는 직접 확정하지 않습니다.
- 구현 증거: 모든 실행 전달 전에 Windows 창을 일반 상태로 복원하고 컨트롤러 탭을 활성화하며, 동결 보고 시 `tabs.onUpdated`와 현재 탭 상태로 재개를 확인한 뒤 메시지를 전송합니다. 자동 알람은 보안확인 보호 시간이 남아 있으면 전달을 중단하며, 메시지 재시도 중 컨트롤러를 재로드하지 않습니다.
- 검사 증거: frozen 재개·활성 전달·보안확인 보호 회귀를 포함한 native-host 14/14, 서버 계약 39/39, 릴리스 baseline, 보호 잠금 22함수·67파일·18마이그레이션, 서비스 워커 문법과 `git diff --check`가 통과했습니다. 실기 설치와 원자 300개 결과 전에는 운영 성공으로 확대하지 않습니다.

## 2026-08-11 Windows 장시간 수집 컨트롤러·유한 폴링 v1.0.43

- 원인 경계: 1.0.42에서 페이지별 스트리밍과 native stdin 종료 처리를 적용한 뒤에도 단독 job이 7분 이상 `processing`에 남았습니다. 같은 작업을 다시 갱신하지 않고 해당 job을 `manual_stop_architecture_review`로 안전 종료했으며 신규 snapshot은 만들지 않았습니다.
- 구현 증거: 고정 확장 페이지가 native host와 8페이지 작업을 소유하고, 서비스 워커는 알람·수동 요청을 토큰 지정 메시지로 전달합니다. 동시 생성 잠금, `pinned`, `autoDiscardable:false`, 폐기 탭 재로드, 동기 실행 잠금과 모든 native 연결의 `finally` 정리를 검증합니다.
- 무한대기 방지 증거: rank job poll은 `expires_at` 또는 `processing_until` 경과 시 HTTP 503, `pending:false`, typed terminal code를 반환합니다. 확장 저장 상태는 마지막 진행 갱신 뒤 20분이 지나면 `native_host_interrupted`로 종료합니다. 만료 pending·만료 processing·활성 processing 회귀 3건을 포함해 handler 8/8이 통과했습니다.
- 테스트 증거: 실행되지 않던 구형 v1.0.38 assertion 블록을 제거하고 v1.0.43 컨트롤러·1.0.42에서 도입한 페이지 스트리밍·native input-close 검증을 활성화했습니다. native-host 13/13, 서버 계약 39/39, 앱/API 415/415, 플레이스 51/51, 쇼핑 52/52, 보호 잠금 self-test와 전체 `npm run check:release`, `git diff --check`가 통과했습니다.
- 실증 경계: Windows 설치·`남자팬티` 오가닉 300개 완료 전에는 정상 가동 또는 Production 배포로 보고하지 않습니다.

## 2026-08-10 초기 검색 경로 결과 경쟁 제거 v1.0.34

- 실기 증거: Windows `Profile 3`의 실로드·runtime 1.0.33 및 서비스 워커 해시 일치 후에도 `골프마스크` 단독 회차가 약 79초 뒤 snapshot 없이 일반 이동 오류로 안전 종료됐습니다. 이는 검색어만 입력되고 검색 전환 없이 닫히던 화면과 같은 초기 경계입니다.
- 구현 증거: 홈 검색은 검색어·공식 검색 UI 존재 확인 결과를 반환한 후 확장이 검증된 N플러스 검색 URL로 이동합니다. 가격비교는 검색 결과에 실제 표시된 링크 URL만 반환받아 재검증 후 이동하고, 2~8페이지도 같은 `chrome.tabs.update` 경계를 사용합니다.
- 보호 증거: 직접 가격비교 진입, 우회 플래그, CAPTCHA 처리, 쿠키·기록 삭제를 추가하지 않았습니다. 원자 300개 미만은 저장하지 않고 마지막 정상 순위·이력을 유지합니다.
- 실증 경계: Windows 1.0.34 설치와 신규 원자 300개 snapshot 전에는 정상화·Production 완료로 보고하지 않습니다.

## 2026-08-10 페이지 이동 결과 경쟁 제거 v1.0.33

- 실기 증거: `Profile 3` 실로드 manifest와 runtime manifest가 모두 1.0.32이고 서비스 워커 SHA-256도 일치한 상태에서 Windows primary가 `자외선차단마스크`를 단독 claim했으나 80초 뒤 snapshot 없이 `naver_navigation_invalid`로 종료됐습니다.
- 구현 증거: 2~8페이지는 페이지 문서가 `location.assign`을 예약하는 대신 검증된 target URL을 반환하고, 확장 컨텍스트가 URL의 host·path·검색어·page index를 재검증한 뒤 `chrome.tabs.update`로 이동합니다. 결과 유실과 읽기 상태 불안정은 서로 다른 안전 코드로 보존합니다.
- 보호 증거: 최초 홈→N플러스 검색→가격비교 링크의 정상 진입, 45~75초 페이지 간격, 광고 제외, 원자 300개, 실패 시 마지막 정상값 보존은 변경하지 않습니다.
- 실증 경계: Windows 1.0.33 설치와 신규 `checked_count=300` snapshot 전에는 정상화·Production 완료로 보고하지 않습니다.

## 2026-08-10 Windows 실제 확장 경로 검증

- 실기 원인 증거: Chrome 사용자 데이터에는 `Profile 2/3/5/7`만 있지만 watchdog 설정은 `Profile 8`이었습니다. 고정 확장 ID는 `Profile 3`의 Secure Preferences에서 `C:\Users\user\Desktop\momentinsightextension`, manifest 1.0.27을 가리켰고, 업데이터가 갱신한 runtime manifest는 1.0.32였습니다.
- 재발 방지 증거: 업데이터는 존재하는 설정 프로필과 manifest key가 일치하는 실로드 경로만 허용하고, runtime·실로드 폴더를 함께 교체한 뒤 버전·SHA-256이 같아야 `loaded_extension_synced=true`를 출력합니다. watchdog은 없는 프로필을 `chrome_profile_missing`으로 차단합니다.
- 자동 검증: Windows 대상 5/5, 앱·API 409/409, 쇼핑 52/52, 플레이스 51/51, 보호 잠금 22함수·67파일·18마이그레이션, Production 인증 18/18과 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 실증 경계: Windows `Profile 3`에 설치 후 신규 `checked_count=300` snapshot 확인 전에는 정상화·Production 완료로 보고하지 않습니다.

## 2026-08-10 N쇼핑 정상 가격비교 진입 v1.0.24

- 실브라우저 증거: 네이버+ 스토어 홈의 `상품명 또는 브랜드 입력` 검색창에서 `복부찜질기`를 검색하면 `/ns/search?query=...`로 이동했고, 화면의 `네이버 가격비교 검색에서 더보기` 링크는 `/search/all?query=...`를 만들었습니다. 해당 링크로 이동한 가격비교 화면은 접속 제한 없이 정상 표시됐습니다.
- 원인 증거: 기존 서비스 워커는 홈·검색·가격비교 링크 단계를 모두 건너뛰고 `where=all&frm=NVSCTAB&pagingIndex=...` URL을 직접 생성했습니다.
- 구현 증거: manifest 1.0.24는 홈과 검색 결과에 필요한 두 네이버 호스트만 허용하고, 서비스 워커는 정상 진입 완료 전 가격비교 데이터를 읽지 않습니다. 이후 페이지도 동일 탭에서 이동하며 `NVSCTAB`을 제거합니다.
- 보호 증거: 비밀번호·쿠키·localStorage·방문 기록을 읽거나 삭제하지 않으며, 원자 300개·광고 제외·제한/보안확인 fail-closed 계약은 유지합니다.
- 회귀 증거: JavaScript 문법, native-host 대상 12/12, 서버 계약 39/39, 앱·API 408/408, 플레이스·쇼핑 각 51/51, 보호 잠금 22함수·66파일·17마이그레이션, Production 인증 18/18, 공개 빌드, 전체 `npm run check:release`와 `git diff --check`를 통과했습니다.

## 2026-08-10 N쇼핑 접속 제한 안내·확장 브랜드 아이콘 v1.0.23

- 원인 증거: 가격비교 `/search/all`에서 네이버 접속 제한이 발생해도 기존 화면은 제한 상태를 받지 못해 `첫 작업은 약 1분 내 시작`으로 오해를 만들 수 있었습니다.
- 구현 증거: 서버 응답은 허용된 작업 상태·제한 코드·재시도 시각만 포함하며 작업기 ID, 토큰, lease는 노출하지 않습니다. 관리자·광고주 화면은 같은 제한 안내와 마지막 정상값 보존 문구를 사용합니다.
- 보호 증거: 제한 중 자동 동기화와 중복 요청을 보내지 않고, `checkedCount=300` 원자 반영과 실패 시 기존 정상 순위·30일 기록 보존 계약은 유지합니다.
- 아이콘 증거: 확장 manifest 1.0.23이 16/32/48/128px PNG와 action 아이콘을 선언하며, 팝업도 동일 48px 심볼을 사용합니다. Windows 설치기와 UTF-8 안전 업데이터에 네 파일을 포함했습니다.
- 회귀 증거: N상품 handler 55/55, 앱·API 408/408, Windows/native-host 대상 17/17, 플레이스·쇼핑 각 51/51, 서버 계약 39/39, Production 인증 18/18, 공개 빌드·CSP, 보호 잠금과 전체 `npm run check:release`, `git diff --check`가 통과했습니다.
- 배포 증거: 코드 `8b80c0d`·`e4089ac`은 GitHub `main`에 반영됐습니다. Vercel 배포 `dpl_9E6xGwSCx1Wi6o15bt7Dat3hiqYT`은 모든 코드 검사 통과 후 `hybrid_worker_recent_300_proof_missing`에서 차단됐습니다.
- 운영 증거: 최신 정상 `pw-chrome-*` 300개는 `2026-08-09 04:55:15 UTC`로 확인 시점 기준 26.7시간 전입니다. 공용 제한은 `2026-08-10 07:40:15 UTC`에 해제됐지만 Windows 화면에 네이버 이미지 보안확인이 표시되어 신규 정상 증거 생성 전에는 안전문을 우회하지 않습니다.

## 2026-08-10 Windows 중복·고아 수집기 자동 복구 v1.0.20

- 실기 원인 증거: 가격비교 탭 없이 4분 이상 남은 회차에서 `MomentInsightNaverShoppingHost.exe`와 `naver-shopping-native-host.mjs` Node가 중복 실행됐고, 종료 직후 1분 알람이 신규 한 쌍을 다시 만들었습니다. 단순 팝업 로딩이 아니라 서비스 워커 재시작과 OS 프로세스 수명 경계 문제입니다.
- 복구 증거: Windows PowerShell에서 대상 native host·Node만 강제 종료한 뒤 `MI_STUCK_WORKER_RESET`을 확인했습니다. 순위 snapshot이나 Chrome 프로필 데이터는 삭제하지 않았습니다.
- 코드 증거: launcher의 named mutex가 동시 native host를 차단하고, Chrome stdin EOF 후 자식이 5초 안에 끝나지 않으면 종료합니다. 확장은 실행 객체가 없는 2분 초과 `running` 저장 상태를 `native_host_interrupted`로 교체합니다.
- 설치 증거: Windows 안전 업데이터가 새 C# launcher를 staging에서 먼저 컴파일한 뒤 확장·launcher를 함께 교체하도록 회귀검사에 고정했습니다. DPAPI 운영 키 파일은 대상에 포함하지 않습니다.
- 회귀 증거: JavaScript 문법, Windows/native-host 대상 17/17, 보호 잠금 22함수·66파일·17마이그레이션, baseline, 서버 계약 39/39, 앱·API 407/407, 플레이스·쇼핑 각 51/51, Production 인증 18/18, `git diff --check`와 전체 `npm run check:release`가 통과했습니다.
- 배포·실기 증거: `0419439`·`48016f7`을 GitHub `main`에 푸시했고 Vercel Production `/health`·`/ready`는 릴리스 `48016f734b96`, 서울 `icn1`, Supabase ready입니다. Windows 업데이터가 Chrome을 재시작한 뒤 확장 카드가 1.0.20으로 표시됐습니다.

## 2026-08-10 수동 갱신 가시성 v1.0.19

- 코드 증거: manual trigger만 `activateTab: true`를 전달하고, 자동·원격 trigger는 false를 유지합니다. 네이버 제한·보안확인 경로의 `surfaceNetworkRestrictionTab`·`surfaceVerificationTab`은 항상 탭을 활성화합니다.
- UX 증거: 팝업은 `30~45초 안전 대기 후 가격비교 탭이 열립니다`라고 안내합니다. native host 대상 12/12, 서버 계약 39/39, baseline과 `git diff --check`를 통과했습니다.
- 배포·설치 증거: 코드 `d90c66b`가 GitHub `main`과 Production `/health`·`/ready` 릴리스 `d90c66b41ecb`에 반영됐습니다. Windows `동빈 (개발)` 설치 경로를 1.0.19로 교체하고 Chrome을 재기동했으며 PowerShell에서 `MI_UI_UPDATE_OK version=1.0.19`, `MI_VERIFY version=1.0.19 chrome=13`을 확인했습니다.
- 설치 장애 증거: 첫 원격 교체가 GitHub 원문을 `DownloadString`으로 읽어 한국어 바이트를 손상했고, Windows Node 24 `--check`에서 설치된 `service-worker.js`의 `Invalid regular expression flags`를 재현했습니다. 서비스 워커가 시작되지 않아 팝업이 `상태 확인 중`에 고정된 직접 원인입니다.
- 재발 방지: Windows 전용 업데이터는 `DownloadData`와 `WriteAllBytes`만 사용하고 staging의 manifest 버전·`service-worker.js`·`popup.js` 문법을 모두 검증한 뒤에만 Chrome을 재시작합니다. 정적 회귀 5/5와 native host 포함 대상 17/17을 통과했습니다.

## 2026-08-10 Windows 우선·Mac 대기 공용 차선 v1.0.18

- 원인 증거: tracker 행의 조건부 lease는 같은 행 중복 저장을 막지만, Mac과 Windows가 각기 다른 due 키워드를 동시에 claim할 수 있었습니다.
- 구현 증거: 운영 Supabase에 `naver_shopping_worker_coordination`과 claim/touch/release/block RPC를 적용했습니다. Windows `primary_seen_at` 3분, 공용 lease 1,200초, network/418/429 1,800초, verification/CAPTCHA 3,600초입니다.
- 권한 증거: 운영 SQL에서 RLS·force RLS가 모두 true, anon table select와 claim RPC execute는 false, service_role execute는 true입니다. 보안 advisor의 신규 항목은 접근 정책이 없는 service-role 전용 RLS 테이블이라는 INFO이며 외부 권한은 없습니다.
- 회귀 증거: standby는 primary online 응답에서 wake·tracker claim·브라우저 수집을 0회 수행하고, lane lost 시 서버가 tracker claim 전 409로 차단합니다. 서버 계약 39/39, 앱·API 405/405, 플레이스·쇼핑 각 51/51, Production 인증 18/18과 전체 `npm run check:release`가 통과했습니다.
- 설치 증거: Windows PowerShell이 `MI_UPDATE_OK version=1.0.18 primary=True exe=True`를 출력했고 Chrome 재시작 뒤 `Moment Insight N Shopping Rank 1.0.18` 표시를 확인했습니다. DPAPI 운영 키는 보존됐습니다.
- 장애·수정 증거: 운영 RPC probe가 `current_time`의 `timetz`/`timestamptz` 충돌을 재현했습니다. `fix_naver_shopping_worker_lane_timestamp` migration 적용 뒤 `windows-desktop-primary`가 `2026-08-10 10:09:16 KST` heartbeat를 기록하고 idle 회차 lease를 정상 해제했습니다.
- 실수집 경계: 주 작업기 연결은 증명됐지만 신규 `pw-chrome-*`·`checked_count=300` snapshot은 별도로 확인합니다. 이 전에는 신규 300위 수집 완료로 확대하지 않습니다.
- 안전 실패·원격 재개 증거: `2026-08-10 10:12 KST` Windows 단독 회차는 tracker 1건을 claim했고 `10:30 KST` `native_host_response_timeout`으로 lease를 해제했습니다. 신규 snapshot·공용 block code 없이 마지막 정상값을 보존했고, `10:42:59 KST` Codex wake는 1분 안에 소비되어 Windows primary가 lane과 tracker 1건을 다시 claim했습니다.

## 2026-08-10 Windows 수동 갱신 무한로딩 복구 v1.0.17

- 장애 증거: Windows native host PID와 자식 `node.exe`는 남아 있었지만 Supabase의 최근 10분 worker 요청과 processing tracker는 모두 0이었고 due tracker는 58건이었습니다.
- 수정 증거: launcher가 Chrome stdin을 자식 Node stdin으로, 자식 stdout을 Chrome stdout으로 binary relay합니다. 확장은 native host 첫 응답을 30초로 제한하고 수동 실행 UI에는 즉시 접수 응답을 반환합니다.
- 자동 검증: Windows/native-host 대상 16/16, 보호 잠금 22함수·64파일·15마이그레이션과 self-test, 서버 계약 39/39, 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 배포 증거: 코드 `5049602`를 GitHub `main`에 푸시했고 Production `/health`·`/ready`는 릴리스 `504960286b26`, 서울 `icn1`, Supabase ready입니다.
- 설치 증거: `동빈 (개발)`의 `Profile 3`에 확장 1.0.16을 로드했습니다. DPAPI secret 해시는 보존됐고 정상 `.exe` 출력명으로 다시 컴파일한 launcher는 `MI_EXE_TEST_RUNNING=True`, 설치 경로 파일 크기 9216 bytes로 확인됐습니다.
- 운영 요청 증거: Windows 재가동 뒤 nonce `b4047c8b-ea3a-4c25-aa23-73c4b4918e2b`가 `2026-08-10 04:20:59 KST`에 소비됐고, 수동 실행 후에도 신규 nonce와 활성 tracker 59건 중 processing lease 1건이 확인됐습니다.
- 후속 실패 증거: 해당 lease는 시작 정확히 4분 뒤 `local_worker_collection_failed`로 해제되고 snapshot은 증가하지 않았습니다. native exchange `240000ms`와 request deadline `225000ms`가 8페이지 45~75초 분산보다 짧은 계약 불일치였습니다.
- 후속 수정 검증: 11분 1차 보완은 기존 4분 경계를 통과했지만 실회차가 정확히 11분을 사용해 명시적 `native_host_response_timeout`으로 안전 종료됐습니다. 요청 간격은 줄이지 않고 native/deadline 18분·lease 20분으로 정렬했습니다.
- 18분 실증: `프로폴리스` tracker `6a650814-432b-4f7b-b838-0885069c05d0`는 `2026-08-10 05:01:58 KST`에 1,200초 lease를 얻어 4분·11분을 통과하고 `05:20:00 KST`에 `native_host_response_timeout`으로 안전 종료됐습니다. 신규 snapshot은 0건이며 기존 11위·48회 이력은 유지됐습니다.
- 1.0.17 수정 증거: Chrome `executeScript`를 페이지마다 45초로 제한하고 모든 수집 오류에 tab ID를 전파해 보안확인 외의 걸린 탭을 정리합니다. 대상 104/104, 서버 계약 39/39, 보호 잠금과 self-test, 전체 `npm run check:release`가 통과했습니다.
- 1.0.17 배포·설치 증거: 코드 `9ed047c`가 GitHub `main`과 Production `/health`·`/ready` 릴리스 `9ed047cdac47`에 반영됐고, Windows PowerShell은 `MI_EXTENSION_UPDATE_OK release=9ed047c version=1.0.17 script_timeout=45s`를 출력했습니다.
- 재개 경계: 설치 직후 Windows 사용자 세션 로그오프로 Chrome이 닫혀 마지막 nonce는 `2026-08-10 05:25:16 KST`입니다. 운영 읽기는 활성 59건·due 59건·processing 0건이며, 사용자 로그인과 Chrome 재실행 후 1.0.17의 첫 typed failure 또는 300개 snapshot을 확인해야 합니다.
- 실수집 경계: 신규 `pw-chrome-*`·`checked_count=300` snapshot 생성 전에는 Windows 300위 수집 완료로 확대하지 않습니다. 네이버 제한·보안확인은 우회하지 않고 안전 실패와 마지막 정상값 보존을 확인합니다.

## 2026-08-10 N상품 Windows 작업용 데스크탑

- 원인: 기존 설치기와 wrapper는 macOS `/usr/bin/security`, `~/Library/Application Support`, LaunchAgent만 사용하므로 Windows Chrome에 확장이 자동 설치되지 않습니다.
- Windows 설치 경계: 표시 이름 `프로그램 개발` 정확 매칭, 런타임 사용자 전용 ACL, HKCU Native Messaging, 고정 확장 ID, 현재 사용자 DPAPI, Windows PowerShell 5.1 컴파일 launcher, 로그인 사용자 전용 10분 watchdog입니다.
- 바이너리 경계: Chrome과 Node 사이의 4-byte native messaging framing을 보존하도록 C# launcher가 stdin/stdout을 리다이렉트·텍스트 변환하지 않고 Node에 그대로 상속합니다. launcher stdout과 비밀키 로그는 금지합니다.
- 자동 검증: 신규 Windows 정적 회귀 4/4, native host 12/12, API·서버 401/401, 플레이스 51/51, 쇼핑 51/51, 서버 계약 39/39, Production 인증 18/18, 보호 잠금 22함수·64파일·15마이그레이션, 공개 빌드·CSP와 전체 `npm run check:release`를 통과했습니다.
- 미검증 경계: 현재 실행 환경은 macOS이므로 Windows PowerShell 5.1 C# launcher 실컴파일, HKCU 레지스트리, 작업 스케줄러, Chrome 압축해제 확장 연결은 Windows 데스크탑에서 확인해야 합니다.
- 실증 경계: Windows에서 신규 `pw-chrome-*`, `checked_count=300`, 광고 제외·정확 상품/원부 판정이 확인되기 전에는 주 작업자 전환 완료로 기록하지 않습니다.
- Production: 코드 `c22b5d6`을 GitHub `main`에 푸시했고 Vercel 커밋 상태 `success` 후 운영 별칭에 반영됐습니다. `/health`·`/ready`는 릴리스 `c22b5d65c491`·서울 `icn1`·Supabase ready이고 `/admin`·`/client`는 리다이렉트 후 200입니다.
- 별도 CI 경계: GitHub Quality Gate는 Windows 검사 전 단계인 `npm audit` 중 `pptxgenjs -> image-size` 상류 high 권고 2건으로 중단됐습니다. 현재 `image-size <=2.0.2` 전체가 권고 범위이고 npm의 자동 제안은 `pptxgenjs 1.1.5`로의 breaking downgrade이므로 이 Windows 작업에서 임의 적용하지 않았습니다. Vercel Production 빌드의 전체 릴리스 검사는 통과했습니다.

## 2026-08-09 N상품 당일 전체 순환·복구 v1.0.15

- 사용자·내부 분리: 관리자·광고주 화면의 `09:00 · 15:00` 안내와 `nextRankCheckAt` 표시는 유지하고, 내부 `rank-catch-up` 20분 회차가 사이트 전체를 멱등 등록하도록 고정했습니다.
- 운영 규모: Supabase 읽기 전용 SQL에서 `status=active` 59건, 고유 키워드 47개, due 56건·47키워드, 활성 processing lease 0건을 확인했습니다.
- 연속 처리: 회차당 `max_jobs=1`, 기존 30~45초 첫 대기와 페이지 간 45~75초 분산을 유지합니다. 47개 키워드는 오류가 없을 때 약 15시간 40분에 한 바퀴이며 기존 due·처리 중 행과 oldest-first 순서는 보존합니다.
- 장애 복구: 네트워크 제한·418·429 즉시 중단, `30/60/120분` 단계형 보호 대기와 이후 120분 상한, CAPTCHA 비우회, 회복 후 `rank-recovery` 1건, 실패 lease 해제와 마지막 정상 순위·30일 snapshot 보존을 정적 계약과 회귀검사에 고정했습니다.
- 전체 검증: native host 12/12, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18, 보호 잠금 22함수·60파일·15마이그레이션, 공개 빌드·CSP와 전체 `npm run check:release`를 통과했습니다.
- Production: 코드 `16a0488`, 배포 `dpl_J23S2KoAt34TbC4gafyxneBdADjG`, 운영 별칭 `https://insight.momentlabs.co.kr`입니다. `/health`·`/ready`는 `release=16a04882ff83`, `region=icn1`, Supabase ready이고 관리자·광고주 화면은 리다이렉트 후 200입니다.
- Mac: 설치 런타임 14/14 파일이 저장소와 byte-for-byte 일치합니다. native host는 고정 확장 ID `pflggephankeefaeoaafkmggampnaefm`만 허용하고 scheduler config는 `Profile 5`, LaunchAgent 최근 exit 0, 확장 소스 manifest는 1.0.15입니다.
- 남은 실증: 서비스 워커 변경은 사용자가 `동빈(개발)`의 `chrome://extensions`에서 한 번 재로드해야 적용됩니다. 로드 버전 1.0.15, 제한 해제·첫 신규 `pw-chrome-*`·`checked_count=300`과 다음 oldest-first 작업 재개를 확인합니다.

## 2026-08-09 N상품 가격비교 순위 저빈도 안정화

- 기준 URL: `https://search.shopping.naver.com/search/all`, `where=all`, `productSet=total`, `sort=rel`, `viewType=list`, 페이지 1~8·40개 단위입니다. 네이버플러스 `/ns/search`는 수집과 운영 링크에서 제외했습니다.
- 수집 계약: 동일 탭 순차 이동, 페이지 간 12~18초, 회차당 1개 키워드, 광고 제외 후 정확히 오가닉 300개가 완성된 경우만 원자 저장합니다. 정확 URL 상품 ID·판매자 ID가 다른 상품은 일치시키지 않습니다.
- 실패 계약: 보안확인·418·429·네트워크 제한·페이지/스키마 불일치·부분 수집은 즉시 중단하고 마지막 정상값·30일 이력·대기 순서를 유지합니다. CAPTCHA 우회 코드는 없습니다.
- 자동 검증: 앱·API 393/393, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 공개 빌드 9파일·inline script 6개·CSP SHA 4개, 보호 잠금 22함수·58파일·14마이그레이션과 self-test, 전체 `npm run check:release`, `git diff --check` 통과입니다.
- 설치 검증: 저장소와 중앙 Mac 설치 wrapper SHA-256은 모두 `bcfb8ec9437ae67d41a70ea8fc74db295a632d16d089e8388a3fecf1d8d3738c`, 설치 기본값 `max_jobs=1`, Chrome `동빈` 프로필 확장 1.0.10 활성입니다.
- 운영 실증 경계: 가격비교 1페이지를 직접 열자 네이버 보안확인이 반환됐습니다. 담당자 직접 완료 후 신규 `pw-chrome-*`·`checked_count=300` snapshot이 생기기 전에는 실수집 정상화와 배포 완료로 판정하지 않습니다.

## 2026-08-08 N상품 보안확인 안정화 기준

- 원인 로그: `2026-08-08T10:11:13Z max_jobs=2`와 `2026-08-08T11:19:57Z max_jobs=4` 모두 첫 작업에서 `naver_verification_required`로 중단됐습니다. 4건 연속 수집 증거는 없으며 기존 보안확인 미해결 상태의 재시도입니다.
- 필수 동작: 기존 확인 탭이 blocked/unknown이면 자동·수동 모두 native host 연결과 서버 claim 전에 중단하고, 정상 쇼핑 `__NEXT_DATA__`가 확인된 경우에만 상태를 지우고 안전 수집을 재개해야 합니다.
- 처리량: 기본 상한은 회차당 순차 2건, 10분 보정과 페이지별 3.5~6초 분산을 유지합니다.
- 자동 검증: native host·worker 대상 28/28, 앱·API 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션 self-test와 전체 `check:release`를 통과했습니다.
- 설치 검증: 저장소와 중앙 Mac 설치 wrapper SHA-256은 `58c062eca4c392f2696110bc3840417ef71237c728aa066b9f5ce49f819615fd`로 일치하며 wrapper 기본값은 `max_jobs=2`, LaunchAgent 주기는 600초입니다.
- 미완료: Chrome 확장 1.0.6 재로드, 사용자의 현재 보안확인 완료, 이후 실제 원자 300개 snapshot 생성은 아직 확인하지 않았습니다.

## 2026-08-08 N상품 Mac 처리량·중복 대기열 검증 기준

- 처리량: native host 기본 상한은 회차당 4건이며 병렬 수집 없이 기존 10분 주기·페이지 분산·보안확인 중단·1시간 쿨다운을 유지합니다.
- 중복 방지: 첫 전체 갱신은 미래 예약 행만 due로 전환하고, 같은 계정 또는 사이트 전체의 반복 요청은 `queued=0`, `alreadyQueued` 증가로 끝나야 합니다.
- 공정성: 이미 due인 `next_check_at`은 다시 쓰지 않으며 중앙 claim은 기존 oldest-first와 조건부 lease를 유지해야 합니다.
- 필수 검증: handler 반복 요청, local worker, native host, release baseline, 보호 잠금 self-test와 전체 `npm run check:release`를 통과해야 완료로 판정합니다.
- 실행 결과: 대상 96/96, 전체 앱·API 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션과 self-test, 공개 빌드·CSP 검사가 모두 통과했습니다.
- 변경 경계: 화면·DB 스키마·순위 판정·광고 제외·정확 상품/원부 판정·300개 원자 저장·기존 30일 이력은 변경하지 않았습니다.
- 배포 증거: 코드 `1d7b773`, Production `dpl_H5Jtb4sZR3yNGV75PKAxZnwLgvYp`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `1d7b77338bfc`·서울 `icn1`·Supabase ready이며 Vercel Production 빌드에서도 전체 릴리스 검사를 다시 통과했습니다.
- Mac 설치 증거: 저장소와 설치 wrapper SHA-256은 모두 `13edcfe18410dd657a9f5e9a3a2a6b779ba7ddd0a251465477a8e1b16afddbf8`, 설치 환경은 `MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS=4`, LaunchAgent 최근 exit 0입니다.
- 운영 관찰 경계: 설치 후 스케줄러의 `chrome_ready profile=Default`는 확인했지만 새 native-host 작업 기록이 없어 첫 자연 회차의 `max_jobs=4`와 신규 원자 300개 snapshot은 아직 미확인입니다.

## 2026-08-08 N상품 30일 순위 날짜별 단일 표시

- 대상: `src/pages/admin.html`, `src/pages/client.html`
- 동작: 날짜별 AM/PM 중 `checkedAt` 기준 최신 유효 순위 1개 표시, 한쪽만 수집된 날은 해당 순위 표시, 둘 다 없으면 `-`.
- 대상 동작 검증: 양쪽 존재·AM만 존재·PM만 존재·최신값 공란 fallback·양쪽 없음, 관리자·광고주 합계 `10/10`.
- `npm run check:baseline`: 통과, `rankTrackingDailySingleRank: true`.
- `npm run check:rank-feature-lock:self-test`: 통과, 보호 함수 22개·보호 파일 58개·migration discovery 확인.
- `npm run check:release`: 통과. server contract `37/37`, app tests `389/389`, place collector `51/51`, shopping collector `51/51`, production auth `18/18`, public build 9개 파일과 inline script 6개를 CSP SHA 4개로 허용.
- Production 배포: 코드 `01dd688`, 운영 릴리스 `01dd688b814b`, 서울 `icn1`, `/health`·`/ready` 200, Supabase ready.
- 운영 산출물: `/admin`과 `/client` HTML SHA-256이 각각 로컬 검증 빌드와 일치하며 두 파일 모두 `latestRankSnapshotForDay`와 단일 `renderRankSlot` 호출을 포함하고 기존 AM/PM 렌더 호출은 없습니다.
- 로그인 관리자 실데이터: 새로고침 후 날짜 카드 367개 모두 슬롯 1개, AM/PM 라벨 0개. 표본 `08-07 순위 68위`, `08-03 순위 121위`, `07-31 순위 101위` 확인.
- 광고주 실데이터 육안 검수: 현재 Chrome에 광고주 접속 코드 세션이 없어 미완료. 광고주 운영 HTML 해시 일치와 동일 동작 대상 테스트는 완료했습니다.

## 2026-08-03 확장 수동 갱신 사이트 전체 대기열

- 원인 증거: 기존 확장 수동 실행은 `next_check_at <= now()`인 due만 claim했다. 운영 DB 읽기 전용 집계는 active 71·고유 키워드 58·due 61·미도래 10·활성 lease 0으로, 수동 버튼을 눌러도 미래 예약 10건은 대상이 아니었다.
- 변경 증거: 수동 trigger만 서명된 `queue-all-active-trackers`를 먼저 호출한다. 서버는 모든 active를 계정 필터 없이 갱신하되 활성 lease는 제외하고, 총계·등록·처리 중 수만 반환하며 ID와 계정 코드는 반환하지 않는다. 신규 tracker의 즉시 due 계약도 유지한다.
- 처리 증거: 첫 회차는 기존 최대 2건, 남은 due는 10분 catch-up, 보안확인·418·429는 1시간 휴지한다. 자동 09:00·15:00·10분 trigger는 전체 재등록을 호출하지 않는다.
- 검증: 대상 워커·handler·native host·확장 42/42, API·서버 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 역할 5상태, 보호 잠금 22함수·58파일·14마이그레이션, 공개 빌드/CSP와 전체 `npm run check:release` 통과.
- 배포 증거: 코드 `2924d82`, Production `dpl_9zLh7gMu554Uo1tHnF7BcUtmWid9`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `2924d82801e5`·서울 `icn1`·Supabase ready이고 무서명 워커 요청은 401이다. 중앙 Mac native host·local worker 설치본 SHA-256은 저장소와 각각 일치하고 확장 소스는 1.0.5, LaunchAgent 최근 exit 0이다.
- 미완료: Chrome 보안 정책상 `chrome://extensions`의 재로드 버튼은 자동 조작하지 않았다. 사용자가 확장을 한 번 재로드하고 수동 버튼을 직접 누른 뒤 `전체 71개 등록`과 신규 `pw-chrome-*`·`checked_count=300` snapshot 증가를 확인해야 하며, 그 전에는 전체 실갱신 완료로 판단하지 않는다.

## 2026-08-03 N 쇼핑 일반 Chrome 자동 수집

- Chrome 실화면: 동빈 프로필의 `온열찜질기` 가격비교 페이지에서 보안확인 문구 없음, `__NEXT_DATA__` 존재, 정상 검색결과 확인.
- 운영 DB 읽기 검증: 최근 3시간 `naver_shopping_results_collector` snapshot 17건 모두 `checked_count=300`; 17개 서로 다른 tracker의 원자 저장 확인.
- 장애 근거: 짧은 시간 연속 실행 뒤 28개 tracker가 실패해 페이지 간 1.25초 간격과 차단 시 현재 실행 중단을 적용. 실패 시 `submit` 없음·lease 해제·추가 claim 없음 회귀검사 통과.
- 설치 검증: LaunchAgent `co.kr.momentinsight.naver-shopping-chrome-scheduler`, 08:50·14:50 KST, 승인 Chrome 경로와 `Default(동빈)` 프로필, plist `OK`, 실행 exit 0·`chrome_ready profile=Default` 확인.
- 집중 검사: local worker·native host 25/25. 전체 릴리스 검사는 API·서버 371/371, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·54파일·12마이그레이션을 통과했다.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, Supabase 스키마·운영 이력·순위 계산·화면 렌더링 변경 없음. Production 배포 없음.

> 2026-07-31 이전의 공식 쇼핑 검색 API 순번·API 배열 기록은 과거 결함과 배포를 재현하기 위한 증거다. 현재 순위 소스 검증에는 2026-08-02 hybrid 경계와 `mi.naver-shopping-organic-window.v1` 원자 수집 계약만 적용한다.

## 2026-08-02 · N 쇼핑 hybrid 로컬 워커 전환·실증 대기

- 공식 경계: NAVER API Hub에는 쇼핑 오가닉 전체 순위를 반환하는 endpoint가 없다. 종료된 쇼핑 검색 API, Search·Search Trend·Shopping Insight·Commerce API를 순위 대체값으로 사용하지 않는다.
- 서버 경로: 모바일 통합검색의 명시적 SAS 상품에서 광고를 제외하고 1위부터 연속 검증된 최대 상위 50위 exact hit만 허용한다. 범위 밖 miss와 불완전 응답은 새 순위·snapshot을 만들지 않는다.
- 300위 경로: 사용자가 승인한 일반 `동빈` Chrome에 MV3 최소권한 확장을 로드한다. 권한은 `alarms`·`nativeMessaging`·`scripting`·`storage`·`tabs`와 `https://search.shopping.naver.com/*`만 허용하며 cookies·history·webRequest·localStorage 접근, 비밀번호·쿠키 서버 전송, CAPTCHA 자동 우회를 금지한다.
- 제출 경계: HMAC 서명, 제한된 유효시간, 1회용 nonce, 활성 lease, 정확히 300개, 광고 제외, 연속 순번, 고유 stable ID를 모두 강제한다. 성공 결과는 tracker와 snapshot에 원자 반영하고 실패는 마지막 정상값과 30일 이력을 보존한다.
- 실행 경계: 오전 9시·오후 3시에 로컬 워커가 먼저 실행되고 후속 재시도와 매시 안전 실행이 남은 due tracker를 처리한다. Mac이 꺼져 있으면 서버 상위 50위와 기존값 보존은 계속되지만 새 51~300위 증거는 생성되지 않는다.
- 비용 경계: 유료 외부 수집기·카드·자동 결제는 사용하지 않는다.
- 브라우저 증거: 사용자가 열어 둔 일반 Chrome에서 `온열찜질기` 페이지 1~8을 확인해 페이지마다 광고 4개+오가닉 40개, 오가닉 1~320 연속, 상품 `12149720593` 정확 91위를 확인했다. 별도 자동 Chrome의 보안확인 화면은 근거로 사용하지 않았다.
- 로컬 브리지 증거: Native Messaging manifest를 Chrome 표준 경로에 0600으로 설치하고 확장 ID `pflggephankeefaeoaafkmggampnaefm`만 허용했다. HMAC secret은 기존 macOS 키체인에서 길이만 확인했고 출력·파일 저장하지 않았다. 네이티브 300위·불완전/순번 drift 차단·교환·고정 ID·stdio framing 5/5와 최소권한·원자 수집 계약을 통과했다.
- 서버 배선 증거: 배포 전 운영 endpoint 무서명 POST가 `401 SESSION_REQUIRED`로 끝나 HMAC handler에 도달하지 못하는 결함을 발견했다. 정확한 워커 경로만 공통 로그인 세션 gate에서 제외하고 유사 하위 경로는 계속 잠기며, handler의 HMAC·timestamp·nonce 검증은 그대로 필수인 회귀를 추가했다. 운영 반영 후 무서명 요청이 세션 오류가 아닌 워커 서명 오류로 거부되는지 다시 확인해야 한다.
- 미완료 증거: Chrome 정책상 `chrome://extensions` 자동 조작이 차단되어 사용자 1회 수동 로드가 남았다. 최근 `collection_id=pw-chrome-*`, `checked_count=300` 실제 snapshot, 전체 활성 tracker, 두 정규 실행 창, 세 역할 동일 값은 아직 확인되지 않았으므로 실수집 정상화·Production 배포 완료로 기록하지 않는다.

## 2026-08-01 · 폐기된 원격 쇼핑 수집기 실험 이력

> 아래 내용은 Render/headless 공개 수집 경로를 검토하던 당시 증거다. 현재 실행 구조는 위 2026-08-02 hybrid 로컬 워커 계약을 따른다.

- 신규 경계: `tools/naver-shopping-rank-collector`를 본 Vercel API·플레이스 수집기와 분리했다. Bearer 인증과 16KB 요청 제한, `mi.naver-shopping-organic-window.v1`, 한 응답당 단일 `collectionId`·`collectedAt`, 광고 제외, 연속 오가닉 순번, 숫자형 상품·원부 ID를 강제한다. 부분·혼합 출처·증거 불일치·중복 stable ID는 2xx라도 거부한다.
- 실행 구조: Playwright Chromium 한 개를 재사용하고 요청별 context를 폐기한다. 동시성 1의 제한 큐, 동일 키워드 single-flight, 불변 TTL cache, 호출자 deadline, 허용된 `https://search.shopping.naver.com/search/all` 경로만 사용한다. HTTP 418·429, 캡차, 인증 리다이렉트, selector drift, deadline·부분 수집은 각각 명시 오류로 분류한다.
- 무료 하드닝 재검증: 쇼핑 Render 서비스 블록을 `region: singapore`, Playwright 공식 `channel=chromium` headless, 요청별 격리 context로 유지했다. Render의 플랫폼 health check는 `/health`로 바꾸고 실제 N 쇼핑 검증 readiness는 `/ready`에 남겼다. 공용 쿠키·세션, stealth·fingerprint 위장, 캡차 우회는 추가하지 않았다.
- 앱 통합: 키워드 상품 참고값과 N 상품 단건·30일 추적은 같은 원자 목록만 사용한다. exact seller ID와 직접 확인한 catalog ID만 비교하고, URL query의 가짜 catalog ID·유사 상품명·광고·불완전 조기 일치는 snapshot을 만들지 않는다. 수집 실패 시 processing lease를 안전하게 풀고 마지막 정상 순위·30일 이력을 유지한다.
- 독립 감사 회귀: 명시적 `전체 상품/검색 결과` 문구만 상품수로 인정하고, 빈 결과 페이지 외에는 소진을 추측하지 않는다. 하나의 document-order selector로 카드 순서를 유지한다. 상품수 누락·페이지별 변경·수집량 미만은 `marketTotal=null/unavailable`로만 폐기하고 완전한 순위 창과 readiness는 유지한다. 큐 대기 만료·포화는 HTTP 429 `provider_busy`로 반환하고 5분 재시도하며 전역 readiness를 내리지 않는다. 강제 canary가 포화 큐를 만나거나 구버전 502가 `provider_queue_full`을 포함해도 기존 readiness와 due queue를 유지하며, 실제 `provider_collection_failed:naver_http_418`만 첫 요청부터 회로차단까지 전달됨을 검증했다.
- 시간 계약: 수집기·본 서버 deadline/abort·Production 300 canary는 90초, provider cold-start prewarm은 75초, 관리자·광고주 단건/SEO 조회는 120초 외곽 제한이다. 이 값과 `/health`·`/ready` 역할이 어긋나면 서버 계약 검사가 실패한다.
- 현재 로컬 집중 검사: 쇼핑 수집기 49/49, 관련 서버 회귀 60/60, 서버 계약 36/36 통과. HTTP 418 사용 불가, 실제 Naver 429 재시도, 300개 원자 gate, Playwright 의존성과 Docker 이미지 버전 일치, canary 브랜치 격리까지 확인했다. 전체 릴리스 통과나 실수집 성공으로 확대하지 않는다.
- 재현 명령: `npm --prefix tools/naver-shopping-rank-collector test`, `node --test src/server/handlers/naver-rank-trackers.test.mjs src/server/handlers/naver-rank-cron.test.mjs src/server/handlers/naver-shopping-rank-runtime.test.mjs src/server/naver-shopping/provider-runtime.test.mjs src/server/naver-shopping/source-status.test.mjs`, `node scripts/check-server-contract.mjs`.
- 실 canary: 수정 후 실제 Playwright/Chromium은 정상 기동했으나 N 쇼핑 검색이 HTTP 418을 반환했다. 수집기 `/ready`는 HTTP 503, `secretConfigured=true`, `provider.configured=true`, `provider.verified=false`, `reason=naver_http_418`을 반환했다. 테스트 서버 종료 후 로컬 포트 접속 실패까지 확인했다. 앞선 사용자 브라우저 점검에서도 동일 공개 주소가 `보안 확인을 완료해 주세요` 캡차로 전환됐으며 캡차를 우회하거나 순위를 추정하지 않았다.
- 배포 gate: Vercel Preview의 `--vercel-build` live check는 의도대로 skip되지만 Production은 실제 collector `/ready`와 요청한 300개가 정확히 일치하는 원자 목록을 통과해야 한다. `sourceExhausted`만으로 짧은 목록을 300개 canary 성공으로 인정하지 않는다. 실상품 300개·`mml93-a01` 25/25·전체 71개·09시/15시 cron은 미완료이며 수집 서비스와 Production 배포는 대기다.
- 비용 확인: Render 계정은 Hobby $0, 결제 카드 없음, 현재 청구액 $0이고 blueprint의 쇼핑 수집 서비스도 무료 plan이다. 이는 비용 상태 증거일 뿐 서비스 생성·실수집·배포 완료 증거가 아니다.

## 2026-07-31 · 종료 쇼핑 API 제거·Hub/쇼핑 수집원 경계 통합

- 호출 계약: Search·Search Trend·Shopping Insight는 `NAVER_API_HUB_MODE=hub`와 NCP 인증만 사용한다. Search Ads는 별도 공식 `/keywordstool` 계약을 유지한다. 키워드 상품수·카테고리와 N 상품 단건·30일 순위는 동일한 Bearer POST 수집원과 `naver_shopping_results_collector`·`naver_shopping_organic_list` 증거만 허용한다.
- 종료 경로 차단: `naver-keyword.mjs`와 `naver-shopping-rank.mjs`의 `/v1/search/shop.json`, 직접 legacy 쇼핑 헤더, 기존 fallback을 제거했다. 수집원이 없을 때 종료 API 호출 0건·키워드 Hub/SearchAd 부분 응답·상품 순위 DB 무변경을 자동 검증하고, 재도입 시 기준선과 보호 잠금이 실패한다.
- 환경 일치: 로컬 서버와 런타임·Hub 실호출 검사가 모두 기능 폴더 fallback보다 루트 `.env.local`을 우선하고, 실행 프로세스 환경값을 최우선으로 사용한다. 중복 키가 생겨도 검사와 실제 서버가 서로 다른 인증값을 읽지 않도록 통일했다.
- 정확성 회귀: 300개 완전 수집, 광고 제외, 정확 상품·검증 원부 비교, 잘못된 유사 원부 거부, 빈/짧은/증거 불일치 응답, 401·429·5xx 성격의 실패에서 기존 순위·30일 이력 보존을 검증했다. 총관리자·연결 운영팀·단독 운영팀·광고주·해제 운영팀과 양 역할 화면 계약도 통과했다.
- 자동검사: API·서버 252/252, 플레이스 수집기 51/51, 서버 계약 29/29, Production 인증 18/18, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개, 전체 `npm run check:release` 통과.
- 신규 Hub 실호출: blog HTTP 200·1건·209ms, Search Trend HTTP 200·31건·157ms, Shopping Insight age HTTP 200·12건·53ms. 모두 `hub` 모드이며 실제 키는 출력·문서·커밋하지 않았다.
- 미완료·배포 차단: Production에 쇼핑 수집원 키 쌍이 없어 실상품 300위, `mml93-a01` 25/25, 전체 71개, cron 2회 검증은 수행하지 못했다. 자동 테스트를 실수집 성공으로 대체하지 않으며 commit·push·Production 배포하지 않는다.

## 2026-07-30 · 업무 실행 요약·즉시 완료·등록창 단순화

- 화면 계약: 기존 상단 3카드를 `오늘 업무·지연 업무·확인 필요` 필터 버튼으로 전환한다. 활성 필터는 얇은 딥네이비 계층으로 표시하고 같은 버튼 또는 `전체`를 눌러 해제한다. 모바일은 설명을 숨긴 3열 압축형으로 유지한다.
- 완료 계약: 가까운 업무의 체크 버튼은 `PATCH`에 기존 전체 업무 payload와 `status=done`만 합쳐 전송한다. 일정·유형·우선순위·담당자·내부 메모·공개 제목·공개 안내·공개 여부를 변경하지 않는다. 저장 성공 후 서버를 다시 조회하며 실패 시 화면 상태를 완료로 과장하지 않는다.
- 등록 계약: 기본 영역에는 업무 제목·시작·상태·광고주 공개만 노출한다. 유형·종료·담당자·우선순위·내부 메모는 `상세 설정`에 보존하고 서버 입력 계약은 변경하지 않는다.
- 회귀 검증: 새 기준선 `workOperationExecutionSummaryAndQuickComplete`, 즉시 완료 보존 단위검사 포함 API·서버 236/236, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 `npm run check:release` 통과. `client.html`, 업무 API·DB·운영 데이터와 보호 기능은 변경하지 않았다.
- 육안 검수 제한: 로컬 서버는 정상 실행됐지만 앱 브라우저가 localhost를 `ERR_BLOCKED_BY_CLIENT`로 차단해 변경 후 실화면 캡처는 확보하지 못했다. 자동·정적 검증을 육안 확인으로 대체하지 않으며 push·Production 배포 전 대표님 실계정 확인이 필요하다.

## 2026-07-30 · 업무 등록 팝업·날짜 셀 전체 클릭

- 디자인 계약: 팝업은 딥네이비·화이트·그레이 토큰, 43px 입력 높이, 동일한 선택 화살표, 공개 전용 스위치, 고정 헤더·하단 행동으로 통일한다. 입력 내용만 내부 스크롤되어 작은 화면에서도 취소·저장을 바로 사용할 수 있다.
- 동작 계약: 날짜 숫자와 셀의 빈 영역 모두 해당 날짜의 신규 등록창을 연다. 일정 카드 클릭은 기존 업무 수정, 카드 드래그·모바일 long-press는 기존 일정 이동이 먼저 처리되며 드래그 직후 셀 클릭은 500ms 차단한다.
- 결함 보완: 공통 버튼 CSS가 `hidden`을 덮어 신규 등록창에도 삭제가 보이던 상태를 `[data-work-delete][hidden]`으로 강제 차단했다. 삭제는 수정할 업무가 있을 때만 표시한다.
- 브라우저 검수: 1280px 팝업과 390×700 모바일 팝업에서 입력 행열·선택 UI·공개 스위치·고정 저장 영역·가로 넘침을 확인했다. 빈 셀 `2026-07-08` 클릭 전 팝업 비노출, 클릭 후 팝업 노출과 시작값 `2026-07-08T09:00`, 신규 삭제 버튼 비노출을 확인했다.
- 자동 검증: 새 기준선 `workOperationCalendarCellCreatesAndDialogIsPremium`, 역할 5상태, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 29/29, 전체 API·서버 235/235, 플레이스 51/51, Production 인증 18/18, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 `npm run check:quality`가 통과했다. `client.html`, 업무 API·DB·운영 데이터와 순위 기능은 변경하지 않았다.
- Production 증거: 코드 `1bf6859`, Vercel `dpl_7tQpFm3W5RKY7UvYbLpxrCyJqEqz`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `1bf68593e3af`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 관리자 HTML에는 날짜 셀·팝업·스위치·삭제 숨김 마커가 있고 광고주 HTML에는 셀 등록 기능 없이 공개 일정 읽기 계약만 있다.

## 2026-07-30 · 업무 일정 드래그 이동·저장 확인

- 동작 계약: 데스크톱은 캘린더 업무 카드를 드래그하고 모바일·펜은 320ms 길게 누른 뒤 이동한다. 대상 날짜는 딥네이비 계열의 얇은 강조선으로 표시하며, 놓는 즉시 카드가 새 날짜에 미리 표시된다.
- 저장 안전: 별도 `일정을 변경할까요?` 팝업에서 기존·변경 일시를 비교한다. `일정 변경` 확인 전에는 PATCH를 호출하지 않으며, 취소·ESC·바깥 클릭·저장 실패는 낙관적 이동을 원래 시작·종료 일시로 되돌린다. 확인 시 기존 시각·업무 길이·종일 여부·상태·우선순위·메모·공개값을 보존한 전체 업무 payload를 기존 권한 범위의 `/api/work-items`에 저장한다.
- 권한·비변경 범위: 수정 가능 역할은 기존과 동일한 총관리자·운영팀이며 광고주는 공개 일정 읽기만 유지한다. `client.html`, DB·마이그레이션·RLS, 보호된 키워드 조회·SEO·N 상품 순위·N 30일 순위·N 플레이스 30일 순위는 변경하지 않았다.
- 자동 검증: 이동된 시작·종료 90분 범위 단위검사를 포함한 업무 6/6, 역할 5상태, 새 기준선 `workOperationDragMoveRequiresConfirmation`, 서버 문법, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개가 통과했다.
- 전체·Production 검증: Vercel 빌드에서 전체 API·서버 235/235, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18과 전체 `check:release`가 통과했다. 코드 `d1e08f3`, Production `dpl_HQ6xoQJua3Cg5B46CvhM5d1RakuV`, 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다. `/health`·`/ready`는 릴리스 `d1e08f3607db`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 관리자 HTML에는 드래그·날짜 대상·확인 팝업 마커가 있고 광고주 HTML에는 이동 기능 없이 공개 일정 읽기 계약만 있다.

## 2026-07-30 · 업무 운영 화면 격리·광고주 코드 비열거

- 원인: 공통 `.mi-view`는 비활성 화면을 숨기지만 뒤쪽의 `.mi-work-shell { display:grid }`가 같은 업무 화면에 다시 display를 부여했다. 총관리자 업무 범위 입력은 `ownerCodeSnapshot.clients` 전체를 HTML `datalist`로 직렬화해 클릭만으로 코드 목록이 보였다.
- 화면 수정: `.mi-view:not(.is-active)`를 비활성 화면의 최종 숨김 계약으로 고정하고 업무 grid는 `.mi-work-shell.is-active`에서만 사용한다. `대행사 연결`·`키워드 조회`·`업무 운영` 해시를 각각 로드한 브라우저 검수에서 표시 화면은 각각 해당 화면 1개뿐이고 display는 `block`·`block`·`grid`다.
- 코드 보호: 업무 범위 입력의 `datalist`, `list` 연결, 전체 광고주 코드 렌더링을 제거했다. 입력은 `광고주 코드 직접 입력`, `autocomplete=new-password`이며 다른 메뉴로 이동하면 입력값·불러온 업무 범위를 폐기한다. 업무 API는 기존처럼 입력된 단일 코드를 서버에서 활성 광고주와 대조하고 응답에는 광고주 ID·이름만 사용하며 코드 목록은 포함하지 않는다.
- 자동 검증: 새 기준선 `workOperationViewIsStrictlyScoped`, `workOperationOwnerCodeIsManualAndNonEnumerating`, 역할 5상태, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 29/29, API·서버 234/234, 플레이스 수집기 51/51, Production 인증 18/18, 공개 빌드 9파일·인라인 스크립트 6개·CSP 해시 4개와 전체 `npm run check:release` 통과.
- 비변경 범위: `client.html`, Supabase 스키마·운영 데이터·RLS, 업무 API 권한 범위, 순위 수집·계산·저장·크론, 보호 잠금 해시는 변경하지 않았다.
- Production 증거: 기능 코드 `0e8a4b0`, 배포 증거 `f9be8ca`, 최종 배포 `dpl_9qB4m8GJrsEfUPSKWRt6PVLkxcaY`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `f9be8cadf997`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 운영 브라우저 해시 전환에서도 `대행사 연결`·`키워드 조회`·`업무 운영`은 각각 해당 화면 1개만 표시되고 코드 추천 목록·list 연결은 모두 0건이다.

## 2026-07-30 · 업무 운영 워크플로 1차 로컬 검증

- 권한·공개 계약: 업무는 기본 비공개이며 광고주 미연결 운영팀은 내부 업무만 생성한다. 공개 전환에는 광고주 범위가 필요하고 광고주 응답은 공개 제목·일정·상태·공개 안내만 포함하며 내부 메모·광고주 ID·운영팀 ID·담당자는 제외한다.
- 대상 검증: 업무 전용 단위검사 5/5, 서버 계약 29/29, 역할 상태 회귀, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 232/232, 플레이스 수집기 51/51, 공개 빌드 9파일·인라인 스크립트 6개·CSP 해시 4개, `git diff --check`와 전체 `npm run check:quality` 통과.
- 미완료 증거: 앱 브라우저와 Chrome 모두 로컬 주소를 보안 정책으로 차단해 역할별 로그인 실화면 육안 검수는 수행하지 못했다. 마이그레이션은 파일만 생성했으며 Production DB에는 적용하지 않았고 push·배포도 하지 않았다.

## 2026-07-27 · 역할·연결 상태 자동 회귀 게이트

- 자동 행렬: 총관리자, 광고주 연결 운영팀, 광고주 미연결 운영팀, 광고주, 해제 운영팀의 5개 상태를 `키워드 조회`, `SEO 확인`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위` 5개 경로와 교차 검증한다. 실제 세션 게이트의 역할·활성 상태 판정도 함께 실행해 해제 운영팀은 401 `SESSION_REVOKED`로 닫힌다.
- 범위 경계: 광고주 전용 보고서 범위와 총관리자 전용 운영팀 관리 경계를 별도로 검사한다. 브라우저가 위조한 운영팀·광고주·순위 접근 헤더는 모두 제거되고 서버가 확인한 단독 운영팀 코드로 교체되는 계약을 상품·플레이스 양쪽에서 검증한다.
- 액션 경로: 광고주 미연결 운영팀은 상품 추적 등록·단건 갱신·중지·삭제·그룹·이동·정렬·대기열 갱신 8개와 플레이스 추적 등록·단건 갱신·그룹·삭제·대기열 갱신 5개 경로에서 광고주 연결 403이 아닌 각 액션의 실제 입력 검증 또는 정상 빈 대기열 응답까지 도달한다. 기존 핸들러 테스트의 생성·갱신·그룹·삭제·이력 계약과 결합해 권한만 통과하고 동작이 빠지는 경우를 함께 막는다.
- 화면·문서: 관리자 단독 운영팀 문구가 키워드·상품 순위·SEO와 두 30일 추적 사용 가능 상태를 표시하고, 광고주 핵심 화면이 모두 남아 있는지 검사한다. 현재 정책과 상충하던 과거 `연결 전 30일 추적 차단` 문구는 운영 문서에서 대체 기록으로 정정했다.
- 전체 검증: `npm run check:release` 통과. API·서버 222/222, 플레이스 수집기 51/51, 서버 계약 28/28, Production 인증 18/18, 역할 parity, 기준선, 공개 빌드/CSP, 보호 잠금 21함수·23파일·11마이그레이션이 통과했다.
- 브라우저 2차 검수: 광고주가 없는 운영팀 모의 세션에서 `N 30일 순위`와 `N 플레이스 30일 순위`를 차례로 열었다. 양 화면의 키워드·URL 입력과 `순위 추적` 버튼이 활성 상태였고 `관리자 코드 확인 후 순위 추적을 사용할 수 있습니다.` 경고는 0건이었다.
- Production 증거: 코드 `afe5bfa`를 GitHub `main`에 푸시했고 Vercel 커밋 상태 `success` 후 운영 별칭에 반영됐다. `/health`는 릴리스 `afe5bfa0a8a3`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주 파일은 로컬 검증 빌드와 SHA-256이 각각 일치하고, 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401 `SESSION_REQUIRED`다.
- 비변경 범위: Supabase 스키마·운영 데이터·RLS·보호 잠금 해시를 변경하지 않았고, 검증 중 실계정 데이터 생성·수정·삭제를 실행하지 않았다.

## 2026-07-27 · 운영팀 단독 N 상품·플레이스 30일 순위 격리 정상화

- 원인: 광고주 미연결 운영팀을 독립 조회 도구만 허용하는 과거 권한 정책이 두 추적 API를 403으로 막았고, 화면은 이를 `관리자 코드 확인 후 순위 추적을 사용할 수 있습니다.`로 잘못 안내했다. 파일 용량·크롤러·Supabase 과부하 문제가 아니었다.
- 서버 격리: 서버가 검증한 운영팀 코드만 `x-mi-team-code`, `x-mi-agency-code`, `x-mi-rank-access-code`의 내부 신뢰 범위로 주입한다. 두 추적 API는 이 값이 일치하는 운영팀 단독 요청만 `team-account` 범위로 허용하며, 임의 헤더·다른 운영팀·광고주 범위 요청은 거부한다. 광고주 연결 시 기존 광고주 범위 계약을 그대로 사용한다.
- 데이터 확인: Supabase 운영 DB를 읽기 전용으로 조회해 활성 운영팀 3개, 광고주 미연결 2개, 연결 1개를 확인했다. 미연결 운영팀 코드 범위의 기존 상품 추적 2개는 활성 상태로 보존돼 있었으며 DB 데이터·스키마·RLS는 변경하지 않았다.
- 자동 검증: 운영팀 단독·연결 운영팀·광고주·총관리자와 교차 범위 차단 대상 89/89, 전체 API·서버 220/220, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity, 기준선, 공개 빌드/CSP, 보호 잠금 21함수·23파일·11마이그레이션과 변조 self-test, 전체 `npm run check:release`가 통과했다.
- 브라우저 2차 검수: 광고주가 없는 운영팀 모의 세션으로 두 메뉴를 차례로 열어 상품 화면 `키워드와 상품 URL을 입력하면 최근 30일 대표 순위를 표시합니다.`, 플레이스 화면 `운영팀 격리 범위 연결 완료`를 확인했다. 두 화면의 비활성 버튼과 기존 관리자 코드 경고는 각각 0건이었다.
- Production 증거: 코드 `70f5c75`·배포 `dpl_ByyyBPzAhoPTEmG7zgZ2awh8YWRo`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `70f5c7574ec9`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. `/admin`·`/client`는 최종 200이고 검증 빌드와 SHA-256이 각각 일치한다. 비인증 상품·플레이스 추적 API는 모두 401이며 운영 관리자 파일에 과거 관리자 코드 경고가 없고 새 `team-account` 범위 계약이 포함돼 있다.

## 2026-07-26 · 프로젝트 파일 안전 정리·경로 단순화

- 삭제 근거: `dist`, `.vercel/output`, `03_운영시트_템플릿/outputs`, `.DS_Store`는 Git ignored이며 빌드·샘플 생성으로 다시 만들 수 있어 약 18MB를 삭제했다. `.env.local`, `.vercel/project.json`, `.vercel/.env.production.local`, 루트·플레이스 수집기 `node_modules`는 운영·검증에 필요해 보존했다.
- 추적 파일 정리: 현재 정적 HTML·Vercel 구조와 충돌하고 다른 파일에서 참조되지 않는 `docs/00-project-structure.md`, `src/README.md`만 제거했다. 초기 제품·정보 구조·화면·데이터·UI·로드맵·개발·DB 초안 8개는 삭제하지 않고 `docs/planning`으로 이동했다.
- 경로 고정: `00_프로젝트_폴더_가이드.md`와 `docs/README.md`에 현재 상태·다음 작업·작업명세·테스트 증거의 읽기 순서와 화면·서버·DB·수집기 원본 경로를 고정했다. 로컬 Markdown 22개 링크와 핵심 경로 존재, 제거 대상 부재 검사가 통과했다.
- 기능 무손실: 잠금 21함수·23파일·11마이그레이션, API·서버 218/218, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 공개 빌드/CSP와 전체 `npm run check:release`가 통과했다. 검증 빌드가 만든 `dist`를 다시 안전 정리한 후 `npm run clean:workspace:dry`가 정리 대상 0개를 반환했다.
- 비변경 범위: 정리 구현에서는 `src/pages`, `src/server`, `api`, `public`, `supabase`, `tools`의 운영 구현과 DB 데이터·환경변수를 변경하지 않았다. 이후 대표님 승인으로 동일 검증 결과를 Production에 반영했다.
- Production 증거: 코드 `548b997`·배포 `dpl_D73LagXA6oRCJu3CqrHC8MuCGQtj`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `548b9973383e`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주 파일은 검증 빌드와 SHA-256이 각각 일치하고 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401로 차단됐다.

## 2026-07-26 · 5대 핵심 기능 보호 잠금·3역할 회귀 확장

- 보호 계약: 기존 `키워드 조회`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위`에 `SEO 확인`의 공통 점수 엔진·서버 자동 점검 수집기와 운영팀·광고주 조회·평가·표시 진입점을 추가했다. 총 21함수·23파일·11마이그레이션이 승인 없는 변경을 릴리스에서 차단하며 운영 사용자의 신규 조회·점검·추적 등록·갱신은 계속 허용한다.
- 역할 계약: 운영팀·광고주·총관리자는 각자 허용된 범위에서 다섯 기능을 사용한다. 이 릴리스 당시 광고주 미연결 운영팀의 두 30일 추적을 차단했던 계약은 2026-07-27 운영팀 격리 범위 계약으로 대체됐다.
- 자동 검증: 잠금 현재값 검사와 모든 보호 항목 변조·신규 순위 마이그레이션 탐지 self-test, 운영팀·광고주 화면 parity, 총관리자·연결 운영팀·광고주 5기능 API 권한, 기준선, SEO 18/18 포함 대상 31/31, API·서버 218/218, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`가 통과했다.
- Production 증거: 코드 `34431f5`·배포 `dpl_AaVnUcMpHonkbS8no3DhSDutzU2g`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `34431f5b2504`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주·SEO 엔진 파일은 검증 빌드와 SHA-256이 각각 일치하고 양 역할 다섯 메뉴를 포함한다. 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401로 차단됐다.

## 2026-07-24 · Vercel 서울 리전·로그인 세션 지연 최적화

- 실행 지역·격리 계약: Vercel Functions는 `regions=["icn1"]`, Fluid Compute 활성으로 고정했다. `/api/session`은 별도 30초 함수, 나머지 catch-all API는 기존 300초 함수로 분리했다. `/health`는 비밀값 없이 실제 `VERCEL_REGION`을 반환해 배포 후 런타임 지역을 검증한다.
- 로그인 왕복 최적화: 동일 로그인 요청의 IP rate-limit과 IP·계정 rate-limit은 서로 독립된 Supabase RPC이므로 `Promise.all`로 동시에 시작한다. 두 검사는 그대로 모두 수행하며 Production DB 오류는 이전과 동일하게 fail-closed 처리한다.
- 테스트 환경 격리: Vercel Production 변수가 주입된 빌드에서 운영의 `MI_PRIMARY_AGENCY_CODE`·`VERCEL_ENV`가 플레이스 단위 테스트의 고정 계정과 충돌해 5건이 403이 되는 현상을 확인했다. 보호된 플레이스 구현은 수정하지 않고 해당 테스트가 자체 계정·환경을 설정하고 원래 값을 복원하도록 보정했다.
- 자동 검증: 대상 61/61, API·서버 207/207, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 순위 기능 잠금 13함수·21파일·11마이그레이션, 공개 빌드 9파일·CSP, 일반 환경 전체 `npm run check:release`, 실제 Production 환경변수가 주입된 `vercel build --prod`, `git diff --check` 통과.
- Production 배포: 코드 `31b70e4`·배포 `dpl_DZFaojbvvLfnGVVB7G7bVA3jzSgX`·운영 별칭 `https://insight.momentlabs.co.kr`. Vercel 배포 상세의 API 함수가 `icn1`, 운영 `/health`가 `region=icn1`·릴리스 `31b70e4fb469`를 반환했고 `/ready`는 Supabase ready를 유지했다.
- 운영 연속성 실측: `/health`·`/ready`·비인증 `/api/session`을 각 10회 연속 호출해 30/30 통과, 각 5회 동시 호출해 15/15 통과했다. 연속 p95는 각각 325ms·1,047ms·302ms, 동시 p95는 216ms·251ms·371ms였고 20초 제한 초과·5xx·네트워크 오류는 0건이다. 비인증 세션의 401은 정상 권한 차단으로 판정했다.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, 상품·플레이스 순위 계산·수집·저장·스냅샷, Supabase 스키마와 운영 데이터는 변경하지 않았다.

## 2026-07-24 · 광고주 코드 자동 제안 제거·명시 입력 강제

- 화면 계약: 운영팀·총관리자 광고주 생성 입력란은 `광고주 코드 직접 입력`의 빈 상태로 시작하며 `autocomplete=off`를 사용한다. 서버 목록·운영팀 검증 응답도 다음 광고주 코드를 내려주지 않는다.
- 서버 계약: Owner 직접 생성과 운영팀 연결 생성 모두 광고주 코드가 비어 있으면 `생성할 광고주 코드를 직접 입력해주세요.`와 HTTP 400을 반환한다. `mml93-aXX` 순차 코드 계산·대체 생성 함수는 제거했다.
- 데이터 보존: 기존 광고주 코드·운영팀 연결·세션·DB 행은 수정하거나 재발급하지 않았다. 실제 운영 광고주 생성은 검증 과정에서 실행하지 않는다.
- 전체 검증: 전용 7/7, API·서버 206/206, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, Production 인증 18/18, 보호 기능 잠금 13함수·21파일·11마이그레이션, Vercel 공개 빌드·CSP, 전체 `npm run check:release`, `git diff --check` 통과.
- Production 증거: 코드 `553a880`, 배포 `dpl_34DZvmNhn6mCBam2nEmaQ6nNARrV`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `553a8801e2fa`, live, Supabase ready를 반환했다. 운영 관리자 HTML은 로컬 `dist/admin.html`과 바이트 일치하고 `광고주 코드 직접 입력`·`autocomplete=off`를 포함하며 `다음 광고주 코드`·`nextAgencyCode`는 포함하지 않는다. 비인증 생성 요청은 401로 차단됐다.

## 2026-07-23 · 상품 SEO 트래픽·리뷰 평균·태그·상품정보고시 재정렬

- 점수 계약: 모든 자동 점검이 양호해도 정확 상품 순위가 6위 이하이면 100점을 금지한다. 상위 5위만 트래픽 점수 25/25를 받을 수 있고, 6~10위·11~20위·21~40위·41~100위·101~300위·300위 밖을 구간별 감점한다.
- 대상 회귀: `온열찜질기`와 상품ID `12149720593`의 정확 순위 11위 표본이 100점이 아니며 `트래픽·노출 보완`을 바로 수정할 항목 최상단에 표시하는 자동 검사가 통과했다.
- 리뷰 계약: 같은 키워드 상위 오가닉 상품 중 공개 페이지에서 실제 리뷰 수가 확인된 최대 5개 표본의 산술 평균과 내 상품 리뷰를 비교한다. 표본이 2개 미만이면 평균과 점수 카드를 만들지 않는다.
- 상세 자동 확인: 판매자 태그는 중복 제거 후 최대 10개 충족 여부를 평가한다. 상품정보제공고시는 공개 상품 상세 JSON에서 실제 필드를 읽고 `상세페이지 참조` 문구가 있으면 보완 대상으로 판정한다. 상세 근거가 없으면 통과로 추측하지 않는다.
- 화면 제거: 공식 브랜드·제조사 명칭, 동일 단어 반복, 홍보·가격·배송 문구, 전화번호 사용, 특수문자 사용, 동종 상품 카테고리 6개 카드를 양 역할 점검표와 수정 목록에서 제거했다.
- 전체 검증: SEO 대상 25/25, API·서버 204/204, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, 4대 기능 잠금 13함수·21파일·11마이그레이션, 기준선, 순위·크론·키워드 추이, Vercel 빌드와 공개 CSP, 전체 `npm run check:quality` 통과. 보호된 키워드 조회·N 상품 순위·N 30일 순위·N 플레이스 30일 순위 코드는 변경하지 않았다.
- 캐시·리디렉션 2차 검수: 운영 브라우저가 이전 SEO 자산을 재사용하는 문제를 `seo-v8-20260723` 쿼리로 차단했고, 네이버 모바일 상품 URL이 같은 상품의 데스크톱 URL로 이동할 때 실제 허용 호스트·경로를 보존하도록 보정했다. 후속 전체 검증은 API·서버 205/205, 플레이스 수집기 51/51, 서버 계약 24/24, Production 인증 18/18, 역할 parity·기준선·잠금·공개 빌드/CSP를 통과했다.
- Production 증거: 코드 `6b179a9`·배포 `dpl_CRdGneWLqgpw8KfVvZxKDEuQuBes`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`와 `/ready`는 릴리스 `6b179a9e51eb`, live, Supabase ready를 반환하고 운영 HTML은 `/seo-evaluation.js?v=seo-v8-20260723`을 로드한다.
- 운영 실조회: 광고주 화면에서 `온열찜질기`·상품 `12149720593`를 조회한 결과 정확 상품 순위 12위, 총점 80, 트래픽 15/25, `트래픽·노출 보완` 최상단, 삭제 대상 6개 카드 0건, 콘솔 경고·오류 0건을 확인했다. 순위는 조회 시점에 변할 수 있으므로 과거 11위 표본을 현재값으로 고정하지 않는다.
- 외부 제한: 같은 시점 네이버 공개 상품 상세·상세 조회는 429 제한을 반환했다. 따라서 리뷰 상위 평균·판매자 태그·상품정보고시의 운영 실데이터 카드는 표시하지 않았고, 통과·실패·100점을 추측하지 않았다. 자동 판정 코드와 단위 회귀는 통과했지만 이 세 항목의 운영 실데이터 확인은 외부 응답 정상화 전까지 미완료로 기록한다.

## 2026-07-23 · NAVER API Hub 이중 호환 준비

- 공식 근거: 네이버 개발자센터의 최신 공지와 NAVER API Hub 명세를 기준으로 Search·Search Trend·Shopping Insight의 Hub 인증 헤더와 경로를 확인했다. 쇼핑 검색은 Hub 이관 제외이며 2026-07-31 24:00 종료·공식 대체 API 없음으로 별도 분리했다.
- 새 계약 검증: `legacy|hub|auto` 공급자 선택, 모드 누락·오타의 legacy 안전 기본값, 공급자별 URL·인증 헤더, nested Hub 오류 파싱, 401/403·404/410·429·5xx 운영 판정을 자동 검사한다. 쇼핑 검색은 Hub 경로로 보내지 않는 회귀도 고정했다.
- 기능 회귀: 새 어댑터·키워드·플레이스 폴백·통합 상태 대상 66/66, 전체 API·서버 178/178, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, N 상품·N 플레이스 30일 보호 잠금·공개 빌드·전체 `npm run check:release`가 통과했다. 변조 차단 self-test와 `git diff --check`도 최종 변경 기준으로 별도 재검증했다.
- 실제 호출: 로컬 legacy 자격증명으로 `써큘레이터?profile=trend`를 호출해 HTTP 200, provider `legacy`, Search Trend·Shopping Insight 정상, 경고 0건을 확인했다. NCP Hub 키가 현재 환경에 없어 Hub 인증 실호출·양 공급자 결과 비교는 완료로 주장하지 않는다.

## 2026-07-22 · 키워드 시장 3지표 프리미엄 요약

- UI 계약: 운영팀·광고주 키워드 조회 결과 상단을 `KEYWORD MARKET` 카드와 기존 연관 키워드 미리보기의 2열 구조로 정리했다. 카드에는 정확 월 검색량, 경쟁 상태, `검색 수요`·`경쟁 강도`·`판매 기회율` 3개 진행 바와 산정 근거·오인 방지 고지만 노출한다. 900px 이하에서는 1열, 520px 이하에서는 간격·문자 크기를 줄인다.
- 산정 계약: 검색 수요는 정확 월 검색량을 로그 스케일 1~100으로 변환한다. 경쟁 강도는 검색광고 경쟁도 60%와 쇼핑 상품수/검색량 포화도 40%를 결합한다. 판매 기회율은 수요 65%와 역경쟁 35%의 참고 점수이며 실제 주문·매출 전환율이 아니다.
- 누락 방어: 네이버가 검색량을 `<10` 같은 범위값으로만 제공하면 `Number(null)=0` 경로를 차단하고 검색 수요·판매 기회율을 `확인 필요`로 유지한다. 경쟁 근거만 있으면 경쟁 강도만 표시하며 데이터를 임의 생성하지 않는다.
- 대상 회귀: 신규 3/3 통과. 모든 점수 0~100 범위, 검색량 범위값 fail-closed, 동일 수요에서 낮은 경쟁의 판매 기회율이 더 높음을 검증했다. 운영팀·광고주 마커와 API `market` 계약을 릴리즈 기준선에 고정했다.
- 모바일 2차 검수: 390px 첫 운영 렌더에서 고정 폭 4열 때문에 연관 키워드가 글자 단위로 줄바꿈되는 결함을 발견했다. 키워드 열 최소 100px·말줄임과 보조 3열을 카드 실사용 폭에 맞춰 양 역할에 동일 적용해 문서·시장 카드·연관 표·3개 지표 바의 가로 넘침을 모두 0으로 유지했으며 해당 CSS를 기준선에 추가했다.
- 전체 릴리스 검사: API·서버 165/165, 플레이스 수집기 51/51, Production 인증 18/18, 역할 query parity, 서버 계약, 순위·크론·키워드 추이, 공개 빌드 8파일·인라인 6개/CSP 해시 4개와 전체 `npm run check:release`를 통과했다.
- 비변경 범위: N 상품·N 플레이스 30일 기능 잠금은 4개 함수·20개 파일·11개 마이그레이션으로 통과했다. 순위 수집·매칭·크론·DB 스키마·기존 추적 행과 이력은 수정하지 않았다.

## 2026-07-22 · 키워드 연령별 쇼핑 클릭 비중 정상화

- 운영 증상: Production `온열찜질기` 조회는 10대 0.2%·20대 4.3%·30대 15.8%·40대 29.0%·50대 이상 50.7%를 `최근 1년 연령별 검색 비율`로 표시했다. 화면 합계는 100%였지만 원본은 절대 클릭 구성비가 아니라 각 월 최고값을 100으로 둔 상대지수였다.
- 공식 근거: NAVER API Hub의 `키워드 연령별 트렌드 조회` 명세는 `/shopping/v1/category/keyword/age`의 `ratio`를 `구간별 결과에서 가장 큰 값을 100으로 설정한 상댓값`으로 정의한다. 따라서 월별 전체 클릭량 가중치 없이 12개월 상대지수를 더한 값은 1년 클릭 구성비로 해석할 수 없다.
- 수정 계약: 최신 완료 월의 한 구간 안에서만 10·20·30·40·50·60대 상대값을 합계 100%로 정규화하고 50·60대를 `50대 이상`으로 합친다. 부분 진행 월은 제외하고, 응답에서 빠진 0값 연령은 0%로 유지하며 완료 월이 없으면 null을 반환한다. API는 `ageBasis`와 실제 `agePeriod`를 제공한다.
- 자동 회귀: 진행 중인 월 제외, 0값 연령 생략 허용, 월말 완료 월 선택, 완료 구간 없음 fail-closed 4개 검사가 모두 통과했다. 전체 API·서버 158/158, 플레이스 수집기 49/49, 서버 계약 22/22, Production 인증 18/18, 역할 query parity, 키워드 추이, 순위, CSP 공개 빌드 8개 파일·인라인 6개/해시 4개와 `git diff --check`를 통과했다.
- 역할 검증: `admin.html`과 `client.html`은 동일하게 `연령별 쇼핑 클릭 비중`, 최신 완료 월 설명, `쇼핑 클릭 비중` 툴팁을 사용한다. 상품·플레이스 순위·30일 저장·로그인·권한·보고서·Supabase 스키마는 변경하지 않았다.
- 운영 배포: 코드 `a4d68f3`, `/health`·`/ready` 릴리스 `a4d68f324d9b`, Supabase ready를 확인했다. Production 관리자·광고주 HTML에 새 제목·설명·툴팁이 모두 존재하고 보호 키워드 API의 비인증 401도 유지된다. 배포 직후 브라우저는 로그아웃 상태여서 인증 데이터의 새 `agePeriod` 실응답은 다음 로그인 조회에서 확인한다.

## 2026-07-22 · 운영팀·광고주 로그아웃 로그인 화면 복귀 정상화

- 원인 확정: 광고주 `logoutClient()`의 성공 경로는 서버 쿠키와 코드만 제거하고 `clearClientAuth()`를 호출하지 않아 루트의 `is-authed`가 남았다. 서버 `/api/session?action=logout`은 기존에도 CSRF를 확인하고 Production·개발 쿠키를 모두 만료시켰으며 응답 어댑터도 복수 `Set-Cookie`를 보존하므로 이번 잔류 화면의 직접 원인은 클라이언트 상태 전환이었다.
- 즉시 안전 전환: 운영팀·광고주 모두 서버 요청을 먼저 시작해 CSRF를 보존한 뒤, 응답을 기다리지 않고 로컬 세션·민감 상태를 지우고 로그인 화면 최상단으로 이동한다. 서버 확인은 요청당 5초, 네트워크/5xx만 최대 2회이며 HTTP 성공과 JSON `ok=true`가 모두 맞아야 완료로 표시한다.
- 비동기 경합 방어: 로그인·복원·보고서 동기화·원본 파일 FileReader/서버 업로드·PPTX 생성·Owner/운영팀 계정 조회/생성/해제·Meta·키워드·SEO·N상품 1회 조회는 요청 시점 generation·role·scope를 캡처한다. 로그아웃 또는 다른 계정 재로그인 뒤 도착한 이전 응답은 화면·다운로드·`currentOperationTeam`·저장소에 반영하지 않는다.
- 교차 계정 초기화: 로그아웃 시 Meta 검색어와 요약, 키워드·SEO 입력, 상품 1회 조회 결과, 상품·플레이스 추적 URL, 검색·그룹 필터와 그룹 임시값을 지운다. 초기 세션 확인은 별도 잠금 함수로 처리해 기존 서버 세션 자동 복원 generation을 바꾸거나 입력을 지우지 않는다.
- 자동 회귀: `roleLogoutAlwaysReturnsToLogin`, `roleLogoutInvalidatesStaleAuthWork`, `roleLogoutBlocksLatePrivilegedAndToolResponses`, `clientLoginButtonsRespectSessionGeneration`, `clientSessionRestoreKeepsInitialGeneration`, `adminLoginFailureCanRetry` 기준선을 추가했다. 광고주·운영팀 인라인 스크립트 문법, 로그아웃 세션·CSRF·쿠키 계약, `git diff --check`를 통과했다.
- 전체 릴리스 검사: API·서버 154/154, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, CSP 공개 빌드 8개 파일·인라인 스크립트 6개/해시 4개를 통과했다. 기존 상품·플레이스 순위 수집·스냅샷·DB는 변경하지 않았다.
- 2차 검수: 초기 자동 복원, 로그인 재시도 버튼, 모든 민감 도구 응답·다운로드, Owner/운영팀 계정 작업과 교차 계정 입력 초기화를 적대적으로 재검수해 P0/P1 0건을 확인했다.
- 운영 배포: 코드 커밋 `b052e85`, `/health`·`/ready` 릴리스 `b052e8597fb4`, Supabase ready, `/client`·`/admin` 200, 실제 상품·플레이스 추적 보호 API 비인증 401, 새 admin/client CSP 해시 일치를 확인했다.
- 실제 브라우저: 기존 `우노헬스케어` 광고주 서버 세션이 자동 복원되는 것을 확인한 뒤 로그아웃 버튼을 클릭했다. 즉시 로그인 화면으로 전환돼 `로그아웃되었습니다. 다른 대행사 코드를 입력해주세요.`가 표시됐고 입력창으로 초점이 이동했으며, 새로고침 뒤에도 로그인 화면 잠금이 유지됐다. 운영팀 페이지도 로그인 잠금 상태였고 양 페이지 콘솔의 사이트 오류는 0건이다. 운영팀 인증 세션의 실제 클릭은 별도 로그인 비밀값을 사용하지 않고 자동·독립 검수 근거로 한정했다.

## 2026-07-20 · 플레이스 실목록 오가닉 순위 근거 정상화

- 증상·DB 근거: 같은 키워드가 이전에는 62개였으나 최신 배치에서 9개만 확인됐고, `홍대 맛집`/`1907427831`은 미리보기 배열 7번째를 실제 7위처럼 저장했다. `부평 맛집`/`2019299673`도 9개 미리보기와 실제 목록이 달랐다.
- 원인 확정: 네이버 `/p/api/search/allSearch`는 지도 마커 미리보기이며 PC 장소 목록의 오가닉 정렬과 일치하지 않는다. 기존 selector fallback이 이 후보를 실제 목록 후보와 합쳐 미리보기 index를 순위로 확정했다.
- 추가 원인: 가상 목록을 처음부터 끝으로 점프하면 중간 장소 행이 DOM에 나타나지 않았고, `querySelectorAll("li")`는 실제 장소 카드 안의 `새로 오픈했어요` 중첩 프로모션 행까지 업체로 읽었다. 겹침 단계 스크롤로 모든 viewport를 수집하고 목록 최상위 `li`만 순위 후보로 제한했다.
- selector·타임아웃 재현: selector를 1ms로 강제 실패시킨 실조회에서 최초 9개 뒤 겹침 수집 68회로 100개까지 확장했고 top10 ID가 정상 경로와 10/10 일치했다. 정확 ID가 있는 상태로 `placeName`만 비운 실조회도 불필요한 상세 식별을 건너뛰어 39.827초·100개·rank null로 종료됐다. DOM 추출 오류는 빈 viewport로 삼지 않고 fail-closed로 재시도한다.
- 실목록 교차확인: 최종 독립 Chromium 세션과 수집기를 같은 시점에 대조했다. `홍대 맛집` 대상 `1907427831`은 양쪽 모두 오가닉 7위이고 top10 ID·순번 10개가 전부 일치했다. `부평 맛집` 대상 `2019299673`은 양쪽 모두 공개 목록 상위 100개에 없고 top10이 전부 일치했다. 프로모션에서 유입된 ID 없는 후보는 0개다.
- 수집 계약: 미리보기 후보는 순위 근거로 사용하지 않고 실제 `#_pcmap_list_scroll_container` 내부 최상위 행만 인정한다. ID 없는 실제 오가닉 행은 순번 슬롯으로 유지하되 body 메뉴·중첩 프로모션은 제외해 앞당김·밀림을 모두 막는다. 정확 대상 ID가 없으면 이름 유사도로 대체하지 않는다.
- 부분 조회: 300개를 완주하지 못한 미발견은 `complete=false`, `partial=true`, `rank=null`, `current_rank=null`로 저장하고 5분부터 재시도한다. 불완전 후보 목록은 캐시하거나 동일 키워드의 다른 추적 항목으로 전파하지 않는다.
- UI 계약: 운영팀·광고주 모두 부분 조회를 `N개 확인 · 이후 미검증`으로 표시한다. 최신 스냅샷이 null이면 현재 순위뿐 아니라 상태 요약·점검 필터·상승/하락·권고도 과거 `currentRank`를 사용하지 않는다. 두 역할 전용 helper·적용 경로·CSP 해시는 일치한다.
- 공개 범위 한계: 네이버 PC 공개 목록은 두 실조회 모두 오가닉 100개에서 종료돼 `complete=false`다. 따라서 확인된 순위는 정확히 기록하지만 미발견 대상의 101~300위는 `N개 확인 · 이후 미검증`으로 유지하고 5분부터 재시도한다.
- 자동 검증: API·서버 153/153, 플레이스 tracker 계약 42/42, 수집기 42/42, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 미리보기 오인, ID 없는 실제 행의 순위 압축, body 메뉴·중첩 프로모션의 순위 팽창, 가상 목록 끝 점프, selector fallback 확장, DOM 추출 fail-closed, known-ID identity 생략, drain-mode degraded summary 전달을 각각 회귀 테스트로 고정했다.
- 2차 검수: 순위 수집·서버 저장·양 역할 UI를 분리 검수해 P0/P1 0건을 확인했다. 상품 N30 렌더 구간은 HEAD와 바이트 해시가 같고 상품 백엔드 diff도 없다. 기존 추적 행과 30일 스냅샷은 삭제·초기화하지 않았다.
- 운영 큐 재현: Vercel `8f0c6b5`·Render v14 반영 후 활성 13건의 `next_check_at`만 앞당겨 이력 비삭제 재수집을 실행했다. 첫 `부평맛집` 건은 오가닉 1위로 정상 저장됐지만 다음 `종로한의원` selector timeout 1건에서 workflow가 즉시 실패해 뒤의 11건이 미처리로 남았다.
- 큐 보강 계약: 개별 tracker 실패는 서버의 오류·지수 재시도 계약을 그대로 유지하면서 workflow가 다음 batch를 계속 처리한다. `totals.failed`는 queue drain 뒤 최종 실패로 보고하므로 오류가 성공처럼 숨겨지지 않는다.

## 2026-07-20 · 플레이스 검색결과 전체 업체 지표 정상화

- 원인: 수집기는 후보별 방문자·블로그 리뷰 값을 읽고 있었지만 대상 매장 또는 상위 일부 후보만 스냅샷에 전달했고, 양 역할 화면은 값 없음의 fallback `null`을 `Number(null)=0`으로 바꿔 실제 0처럼 표시했다. 외부 수집 경로에는 월검색량 보조 조회도 연결되지 않았다.
- 수집 계약: 광고를 제외한 실제 확인 오가닉 후보 전체에서 블로그·방문 합계를 계산하고 `scope=organic_search_results`, `businessCount`, 각 지표의 `knownCount/totalCount` coverage를 저장한다. 일부 후보 값이 누락되면 해당 합계는 null이며 명시적 0만 0으로 보존한다.
- 성능 보존: 합계는 전체 후보에서 계산하지만 `topPlaces` 저장은 기존 20개 제한을 유지한다. 신규 DB 컬럼·마이그레이션·기존 30일 스냅샷 재작성은 없다.
- 월검색량: 네이버 지도 응답에는 월검색량 필드가 없음을 실응답에서 확인했다. 서버가 기존 Search Ads 자격으로 키워드 월검색량을 별도 조회해 외부 수집 결과와 병합하고, 실패 시 리뷰·업체 지표 저장을 방해하지 않는다. `<10`처럼 범위로만 제공되는 값은 상한을 정확한 수치로 오인하지 않도록 null로 보존한다.
- 실조회 1: `부평 맛집`/플레이스ID `2019299673`은 대상 미발견·부분 조회를 유지하면서 오가닉 54개 전체 coverage 54/54, 블로그 56,310개·방문 173,749개·업체 54개를 반환했다.
- 실조회 2: `강남 맛집`은 오가닉 54개 전체 coverage 54/54, 블로그 61,503개·방문 145,192개·업체 54개를 반환했다.
- 자동 검증: 플레이스 서버 41/41, 수집기 35/35, 전체 API·서버 152/152, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 불완전·불일치 coverage 합계 거부와 검색량 `<10` 비확정 처리를 별도 회귀 테스트로 고정했다.
- 역할 검증: 운영팀·광고주 `placeSnapshotMetric`·일별 카드 출력은 동일하며 누락은 `-`, 명시적 0은 `0`으로 표시한다. 상품 순위·플레이스 순위 판정·광고 제외·기존 30일 이력은 변경하지 않았다.

## 2026-07-19 · 부평 맛집 플레이스·상품 원부 연속 추적 정상화

- 플레이스 대상: 키워드 `부평 맛집`, 정확 플레이스ID `2019299673`. 공식 상세 페이지에서 상호명 `팽오리농장 부평점`을 확인했다.
- 플레이스 실조회: 광고 제외 네이버 공개 목록 54개를 확인했으나 정확 ID는 없었다. 결과를 `complete=false`, `partial=true`로 유지해 300위 미노출을 거짓 확정하지 않고 기존 확정 순위를 보존한다.
- 플레이스 보완: 정확 ID가 있으면 같은 이름의 다른 ID와 ID 없는 후보를 거부하고, 입력 URL의 `lng/lat` 좌표와 좌표별 캐시를 사용한다. 외부 제공자의 일치 응답도 동일한 명시 ID를 필수로 하며 원본 오가닉 순위를 재번호화하지 않는다.
- 플레이스 상호명: 공식 모바일 상세의 리다이렉트와 최대 768KiB 응답을 제한적으로 읽어 상호명을 채우며, 네이버 응답 끝의 제어문자는 저장 전에 제거한다.
- 상품 대상: 상품ID `12649811979`, 최근 확정 원부ID `57907660073`. 과거 스냅샷의 `matched=true`, `rankPolicy=organic_only`, `adExcluded=true`, `trackingRankSource=related_catalog`을 모두 충족한 정확 원부ID만 이어받는다.
- 상품 실조회: `음파 전동칫솔` 원부 15위, `전동칫솔` 원부 25위, 정확 판매자 상품은 두 키워드 모두 상위 300위 밖이다. 정확 상품과 검증 원부는 같은 300개 응답에서 비교하며 제목이 비슷한 다른 원부와 광고 후보는 제외한다.
- 데이터 보존: `naver_rank_trackers`, `naver_place_rank_trackers`와 기존 스냅샷을 삭제·초기화하지 않았다. `admin.html`, `client.html`도 변경하지 않았다.
- 자동 검증: `npm run check:release` 통과. API·서버 147/147, 플레이스 수집기 32/32, 서버 계약 22/22, Production 인증 18/18, 공개 빌드와 `git diff --check` 통과.
- 복구 지점: 원격 태그 `checkpoint/rank-hotfix-20260719-2048`은 커밋 `3fb98b9`를 가리키며 `recovery:verify --quality`를 통과했다.
- 운영 배포: `/health`·`/ready` 릴리즈 `3fb98b9e4622`, Supabase ready, Render 릴리즈 `2026-07-19-exact-id-coordinate-rank-v11`, 관리자·광고주 HTTP 200, 보호 순위 API 비인증 401.
- 운영 상품 저장: `음파 전동칫솔` 현재 15위, `전동칫솔` 현재 25위. 두 최신 스냅샷 모두 원부ID `57907660073`, `checked_count=300`, `matched=true`, `trackingRankSource=related_catalog`, `rankPolicy=organic_only`, `adExcluded=true`다.
- 운영 플레이스 저장: 플레이스ID `2019299673`의 상호명은 `팽오리농장 부평점`, 현재·최고·최저 순위는 미검증이므로 null을 유지한다. 공식 GraphQL `start=71` 재요청은 HTTP 429여서 54위 이후를 임의 계산하지 않았다.

## 2026-07-15 · 메인 기능 쇼케이스 우선순위·그룹 보정

- 요청: 기능 쇼케이스를 신뢰 기준보다 먼저 노출하고, 현재 지표와 30일 추적을 별도 카드 묶음으로 구분하며 네이비 배경을 더 프리미엄하게 보정한다. 배포는 하지 않는다.
- 순서: `Hero → Product Intelligence → Trust Standard → Workflow → CTA`. 1440px 기준 기능 섹션 상단 744px, Trust 상단 1,795px로 기능이 먼저 노출된다.
- 그룹: `현재 데이터`는 오가닉 상품 순위·키워드 시장 분석 2장, `30일 순위 추적`은 상품 순위 추적·플레이스 순위 추적 2장으로 고정했다.
- 색감: `#071421 → #0a1e36 → #102b4b` 저채도 잉크 네이비, 약한 우측 하이라이트, 얇은 인셋 보더와 흰 카드로 위계를 분리했다.
- 데스크톱 1440×900: 두 그룹 각 2카드, 문서 가로 넘침 0, 기능/Trust 순서 정상, 콘솔 로그 0건.
- 모바일 390×844: 두 그룹이 세로로 분리되고 각 그룹 내부만 독립 가로 탐색(`clientWidth=313`, `scrollWidth=545`). 카드 4장의 내부 오버플로와 문서 가로 넘침 모두 0건.
- 회귀 기준선: `homeFeatureShowcasePriorityAndGroups=true`. 섹션 순서뿐 아니라 snapshot에 rank+keyword, tracking에 trend+place만 존재하는지 직접 검사한다. `homeAnonymousFeatureShowcase=true`도 유지한다.
- 독립 2차 검토: 순서·그룹·프리미엄 톤·반응형·익명화·기능 비변경에서 차단 이슈 없음.
- 비변경 범위: 팝업, `admin.html`, `client.html`, 순위 수집·매칭·저장·크론, Supabase·운영 데이터 변경 없음.
- Production: 커밋 `9cdbaad`, `momentinsight-8rljvs8ue-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 검증: `/health`·`/`·`/home.html`·`/admin.html`·`/client.html` HTTP 200, health `ok=true`·`supabaseReady=true`, 운영 HTML과 로컬 `dist` SHA-256 일치. 1440×900·390×844에서 그룹별 2카드·가로 넘침·카드 잘림·콘솔 오류 0건.

## 2026-07-15 · 메인 홈페이지 익명 기능 쇼케이스

- 요청: 상품 오가닉 단건, 상품 30일 추적, 플레이스 30일 추적, 키워드 시장 분석·차트를 메인 홈페이지에서 짧고 프리미엄하게 소개하되 실제 광고주 자료는 노출하지 않는다.
- 구성: `For Brand Growth` 3카드와 `Core Features` 4카드를 삭제하고 `Product Intelligence` 단일 섹션의 4개 예시 카드로 교체.
- 익명화: `예시 키워드 A/B/C`, `예시 상품 A`, `예시 매장 A`만 사용. 실제 고객명·상품명·키워드·가격·상품ID·원부ID·플레이스ID·조회 시각·외부 링크·스크린샷·상품 이미지는 포함하지 않음.
- 표시 고지: `data-mi-showcase-privacy=synthetic-only`, `예시 데이터`, `실고객 정보 미사용`, 모든 화면·명칭·수치가 기능 설명용 예시라는 문구를 함께 표시.
- 데스크톱 1440×900: 카드 4개가 2×2로 노출되고 1행 619×246px/439×246px, 2행 619×281px/439×281px. 문서 `scrollWidth=clientWidth=1425`, 전체 높이 3,107px.
- 모바일 390×844: 4개 카드가 각각 277×277px의 한 줄 가로 탐색으로 렌더링되고 첫·마지막 카드 육안검수 통과. 쇼케이스 375×725px, 내부 패널 347×423px, 문서 `scrollWidth=clientWidth=375`, 전체 높이 3,729px.
- 콘텐츠 검사: 쇼케이스 카드 4개, `<img>` 0개, 외부 링크 0개, 내부 텍스트 오버플로 0건, 브라우저 콘솔 로그 0건.
- 독립 2차 검토: 실제 광고주·상품·키워드·매장·ID·URL·이미지 노출, HTML/CSS 이상, 문서 가로 넘침, 운영/광고주·순위 기능 변경 차단 이슈 없음.
- 개인정보 기준선: 실고객 문자열 NFKC 정규화 차단, 9자리 이상 숫자, 외부 URL, 상품/원부/플레이스 ID 문구, 임시 파일·스크린샷 경로 금지. `homeAnonymousFeatureShowcase=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 비변경 범위: `admin.html`, `client.html`, `src/server`, 플레이스 수집기, Supabase·운영 데이터 변경 없음.
- 배포: 커밋 `8d78d01`을 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료.

## 2026-07-15 · 메인 홈페이지 프리미엄 보완 2차

- 범위: `src/pages/home.html`, 홈페이지 전용 릴리즈 기준선, 운영 문서만 변경. `admin.html`, `client.html`, 순위 수집·매칭·저장·크론·Supabase 코드는 변경하지 않음.
- 문서 기반: `<!doctype html>`, `lang=ko`, viewport, body 여백 초기화 적용. 브라우저 계산 body margin `0px`.
- 팝업 보존: 데스크톱 1440×900에서 348×489px·x72·y118, 모바일 390×844에서 높이 489px·x14·y82·좌우 14px. 외곽 위치·너비 규칙·헤더/본문 여백, 다섯 기능, 카카오 링크, 저장 키와 7일 계산식 유지.
- 팝업 동작: 닫기 버튼과 `1주일 동안 안보기` 버튼을 각각 실행해 `is-hidden=true` 확인.
- 데스크톱: 고정 헤더 69px, 샘플 대시보드 528×529px, CTA 주 행동 버튼 흰색 배경/딥네이비 글자, 문서 `scrollWidth=clientWidth=1425`, 브라우저 콘솔 로그 0건.
- 모바일: 헤더 65px 한 줄, 버튼 2개 동일 행, 샘플 대시보드 347×494px. 반복 3개 카드는 내부 가로 탐색으로 정리하고 페이지 높이를 검증 환경 기준 약 5,498px에서 4,220px로 압축. 문서 `scrollWidth=clientWidth=375`, 외부 가로 넘침 0건.
- 시각 확인: 딥네이비·화이트·절제된 블루 계층, 핵심 매출 카드 강조, 연결형 신뢰 패널·운영 흐름, 실제 경로만 둔 푸터를 1440×900·390×844에서 육안 검수.
- 릴리즈 기준선: `homeDocumentShellAndViewport=true`, `homePopupGeometryPreserved=true`, `homePremiumHierarchyVisible=true`, 기존 `homeDevelopmentNoticeVisible=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포: 커밋 `530839f`를 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료. 거절된 `0886833`은 미사용.

## 2026-07-15 · N 30일 순위 슬롯 `상품` 문구 정리

- 요청: 일별 오전·오후 슬롯의 `PM · 상품`에서 중복되는 `상품` 문구를 제거한다.
- 수정 범위: 운영팀·광고주 `renderRankSlot()`에서 정확 상품 슬롯만 `PM`·`AM`으로 표시. 관련 원부는 `PM · 원부`·`AM · 원부`로 유지.
- 기능 보존: `rankSnapshotSourceLabel()`과 카드 상단 상품/원부 표시, 순위 조회·저장·갱신·크론·광고 제외·대표값 판정·Supabase 데이터 코드는 변경하지 않음.
- 런타임 함수 검사: 양 역할 모두 정확 상품 `<small>PM</small><b>9위</b>`, 관련 원부 `<small>AM · 원부</small><b>8위</b>` 출력.
- 릴리즈 기준선: `rankTrackingDailySlotOmitsExactProductLabel=true`, 기존 `rankTrackingDailySlotAlignment=true` 유지.
- 브라우저 빌드: 광고주 390px `scrollWidth=390`, 운영팀 데스크톱·광고주 모바일에서 신규 마커 반영, 구 문구 제거, 콘솔 오류 0건.
- 자동 검사: 전체 `npm run check:quality` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포 커밋: `368408d`만 `main`에 푸시.
- Production: `momentinsight-jly55k3zm-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY. `/health` HTTP 200·`ok=true`.
- 운영 소스: `/admin.html`·`/client.html`·`/home.html`이 `368408d` 산출물과 바이트 단위로 일치하고, 두 역할 HTML 모두 신규 조건식 1개·구 조건식 0개.
- 운영 브라우저: 로그인 운영팀·광고주 `N 30일 순위` 각 414개 일별 슬롯에서 정확 상품의 `상품` 문구 0건, `PM`·`AM` 및 원부 구분 유지, 콘솔 오류 0건.
- 배포 후 자동 작업: GitHub 품질 검사, 상품 순위 갱신, 플레이스 순위 갱신 모두 성공.
- 로컬 이력: 사용자 거절 커밋 `0886833`의 홈페이지·기준선·작업 문서 변경을 `main`에서 제거하고, 현재 홈페이지 소스가 `origin/main`과 일치함을 확인.

## 2026-07-14 · N 30일 순위 오전·오후 행 정렬 복구

- 증상: `PM · 상품` 또는 `AM · 원부`처럼 선택 기준이 붙은 슬롯 라벨만 고정 폭에서 두 줄로 접혀 해당 순위 숫자가 인접 순위보다 아래에 표시됨.
- 원인: `.mi-rank-day-slots small`에 한 줄 제약이 없고, 108px 일별 카드의 반쪽 슬롯에서 기준 문구 너비가 사용 가능 폭을 초과함.
- 수정 범위: 운영팀·광고주 일별 슬롯 CSS의 수평 여백, 라벨 크기, `white-space`·오버플로 처리와 릴리즈 기준선만 변경.
- 기능 보존: 순위 조회·저장·갱신·자동 크론·광고 제외·원부/상품 대표 순위·Supabase 데이터 코드 변경 없음.
- 운영팀 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 광고주 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 390px: 운영팀·광고주 오전·오후 순위 상단 좌표 최대 차이 0px, 슬롯 라벨 오버플로 0건.
- 브라우저: 양 역할 데스크톱·390px 콘솔 경고/오류 0건, 육안 확인에서 `PM · 상품`과 `AM` 순위가 같은 행으로 표시됨.
- 자동 검사: `rankTrackingDailySlotAlignment=true`, 전체 `npm run check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·순위 매칭·크론·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `01935d2` (`fix: align Naver rank daily slots`)을 `main`에 푸시.
- Production: `momentinsight-fhgibit9c-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health`·`/admin.html`·`/client.html` HTTP 200, 두 HTML의 한 줄 라벨·오버플로 방지 CSS 마커 확인.
- 운영팀·광고주 데스크톱: 각 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, `PM · 상품` 포함 라벨 오버플로 0건.
- 운영팀 390px: 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 운영 브라우저: 운영팀 데스크톱·390px, 광고주 데스크톱 콘솔 경고/오류 0건. 육안으로 첫 카드의 PM 4위·AM 4위 동일 행 확인.

## 2026-07-14 · 플레이스 30일 순위 컴팩트 프리미엄 UI

- 범위: 운영팀·광고주 `네이버 플레이스 30일 순위` 카드의 정보 밀도와 반응형 표시만 변경. 순위 수집·매칭·광고 제외·저장·갱신·삭제·그룹·공유 로직은 변경하지 않음.
- 데스크톱: 두 역할 모두 첫 카드 858×264px, 헤더 856×46px, 상태 영역 856×68px, 일별 셀 140×129px.
- 모바일 390px: 두 역할 모두 첫 카드 248×285px, 헤더 246×95px, 상태 영역 246×43px, 일별 셀 140×127px.
- 반응형: 문서 `scrollWidth=390`, 일별 기록과 상태 배지만 카드 내부 가로 탐색을 사용. 긴 수치 셀 오버플로 0건.
- 육안 확인: 딥네이비 현재 순위, 절제된 그레이 보조지표, 낮은 그림자와 작은 라운드, 헤더 2행·상태 1행 구조가 운영팀·광고주에서 동일하게 렌더링됨.
- 브라우저: 운영팀·광고주 데스크톱·390px 콘솔 경고/오류 0건.
- 릴리즈 기준선: `placeRankPremiumCompactCards=true`.
- 자동 검사: 전체 `npm run check:quality` 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·서버 문법·크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `7710008` (`style: compact Place rank tracking cards`)을 `main`에 푸시.
- Production: `momentinsight-m19imug8x-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health` 200, 리다이렉트 후 `/admin.html`·`/client.html` 최종 200, 두 HTML의 140px 카드·2×2 지표 마커 확인.
- 운영 데스크톱: 운영팀·광고주 모두 첫 카드 858×264px, 일별 셀 140×129px, 긴 수치 오버플로 0건.
- 운영 390px: 운영팀·광고주 모두 첫 카드 248×285px, 상태 영역 246×43px, 일별 셀 140×127px, 문서 `scrollWidth=390`, 상태 영역 `nowrap`, 긴 수치 오버플로 0건.
- 운영 브라우저: 운영팀·광고주 데스크톱·모바일 콘솔 경고/오류 0건.

## 2026-07-14 · 써큘레이터 원부 누락 원인 및 모델 식별 보강

- 대상: 키워드 `써큘레이터`, 판매자 상품 URL `https://smartstore.naver.com/eco/products/11687310806`.
- 원인: 정확 상품 제목에는 `서큘레이터`가 있지만 가격비교 원부 제목 `파세코 PCF-MSF1100 화이트`에는 키워드가 없어 기존 `keywordEvidence` 공통 포함 조건이 실제 원부를 누락했다.
- 보강: 원부 후보는 가격비교 원부형, 모델번호 정규화 완전 일치 또는 기존 키워드 근거, 브랜드·제조사·판매처 식별 근거, 상위 카테고리 일치를 모두 통과해야 한다.
- 오탐 방지: `PCF-MSF1100`과 접두가 유사한 다른 모델 `PCF-MSF11000`은 관련 원부로 연결하지 않는다.
- 공식 API 실조회: 원부 `53687717527` 8위, 정확 판매자 상품 `11687310806` 59위, 300개 확인, 대표 `related_catalog` 8위·원부형.
- 로그인 아이템스카우트 교차확인: 같은 시점 원부 9위·정확 상품 60위. 조회 시점 차이 1칸 범위에서 동일 두 상품과 우선순위를 확인했다.
- 회귀 실조회: `치아미백제`/`5145848584` 원부 9위·정확 상품 44위, `전동 칫솔`/`12649811979` 원부 34위·정확 상품 163위.
- 운영팀·광고주 로컬 빌드 실조회: 두 역할 모두 대표 원부 8위·정확 상품 59위, 1페이지 8위·2페이지 19위, 카드 2건과 각 키워드/상세 링크 정상.
- 반응형·브라우저: 광고주 390px에서 `scrollWidth=390`, 결과 카드 가로 넘침 없음. 운영팀·광고주 콘솔 경고·오류 0건, 두 화면 육안 확인 통과.
- 자동 검사: `check:rank-matching`, 전체 `check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, Vercel 정적 빌드, `check:env:naver`, `check:supabase`, `git diff --check` 통과.
- `admin.html`, `client.html`, Supabase 스키마·RLS·Storage·운영 데이터는 수정하지 않았다.
- 커밋·배포: `d9b97ca`를 `main`에 푸시하고 Production `momentinsight-cjx4bkodl-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 검증: `/health`와 순위 API HTTP 200, 대표 원부 `53687717527` 8위·정확 판매자 상품 `11687310806` 59위·`checkedCount=300`·`rankPolicy=organic_only`.
- 운영팀·광고주 실화면: 두 역할 모두 원부 8위·정확 상품 59위 카드, 상품명 키워드 검색 링크와 각 상세 링크 정상, 콘솔 경고·오류 0건. 광고주 390px `scrollWidth=390`.

## 2026-07-14 · 상품 순위 추적 광고 완전 제외

- 코드 경로: 단건 검색 배열 → 관련 원부·정확 상품 후보 → 30일 대표값 → 수동/자동 `runTrackerCheck` → Supabase 스냅샷까지 동일 오가닉 정책 적용
- 광고 혼입 차단: `isAdProduct`, `adId`, sponsored/paid, `supersaving`, `brand_ad` 후보는 순위·대표값·상위 결과에서 제거
- 오탐 방지: 실제 오가닉 상품에도 존재한 `cr.shopping.naver.com/adcr` 링크와 `organic_expose_order` 조합은 광고로 오판하지 않음
- 로그인 네이버 가격비교 `전동칫솔` 1페이지: `product` 40개, 별도 `supersaving` 5개, product 순번 1~40 연속 확인
- 광고 혼합 단위검사: 광고 정확 상품 1위·광고 원부 1위는 무효, 뒤의 오가닉 정확 상품 10위 또는 원부 7위만 대표값으로 선택
- 실조회 `전동칫솔`: 대표 원부 34위, 정확 상품 167위, 300개 확인, 노출 카드 모두 `isAd=false`, `isOrganic=true`
- Supabase 실제 추적 갱신 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인
- Supabase 최신 스냅샷: `rankPolicy=organic_only`, `adExcluded=true`, 대표 `isAd=false`, 대표 `isOrganic=true`, `top_items` 5개 전부 오가닉
- `npm run check:env:naver`, `npm run check:supabase`, `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 크론·순위·키워드·Vercel 빌드 통과
- 관리자·광고주 로컬 빌드 화면: 두 역할 모두 광고 제외 40개 보기 안내, 오가닉 추적 UI·최근 기록 렌더링 정상
- Supabase 스키마·RLS·Storage 변경 없음. 유효한 신규 스냅샷 1건만 기존 추적에 추가
- 배포 커밋: `032c144`
- Production: `momentinsight-iddnfo068-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 단건 API `전동칫솔`: 대표 원부 34위, 정확 상품 166위, 300개 확인, `rankPolicy=organic_only`, 모든 노출·상위 항목 오가닉
- 운영 추적 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인, 최신 스냅샷 `adExcluded=true`
- 운영 Supabase 직접 조회: 대표 `isAd=false`·`isOrganic=true`, `top_items` 5개 전부 오가닉
- 운영 광고주 화면: 현재 8위·원부, 자동추적 정상, 다음 오전 9시, 광고 제외 안내와 레이아웃 정상

## 2026-07-14 · 상품 30일 대표 순위 원부 비교

- 선택 규칙: 정확 상품과 관련 원부 중 숫자가 더 낮은 공식 API 순번을 30일 대표 순위로 저장한다.
- 단위검사:
  - 상품 48·원부 7 → 대표 7, `related_catalog`
  - 상품 5·원부 12 → 대표 5, `exact_product`
  - 원부 후보 11·8 → 대표 원부 8, 무관 후보 3은 제외
- 로컬 공식 API 실조회:
  - `치아미백제`: 정확 상품 43, 관련 원부 9, 대표 9, 300개 확인
  - `치아미백`: 정확 상품 60, 관련 원부 14, 대표 14, 300개 확인
- 기존 단건 조회의 대상 상품ID와 상품 ID 일치 판정은 변경하지 않는다.
- 기존 과거 스냅샷은 관련 원부 원본이 없어 소급 변경하지 않는다.
- `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 릴리즈 기준선·순위 매칭·크론·키워드 트렌드·Vercel 빌드 통과
- 관리자·광고주 소스와 `dist` 빌드 HTML: 인라인 스크립트 문법, 비교 안내, `related_catalog`, 현재 출처, 오전·오후 출처 마커 통과
- 로컬 인앱 브라우저와 Chrome은 `localhost` 접근이 보안 정책으로 차단돼 우회하지 않았다. 운영 배포 후 실제 도메인 육안 검수가 필요하다.
- 배포: 현재 작업의 별도 배포 지시 전 대기

## 2026-07-14 · 네이버 상품 페이지 오표기 배포 전 재검증

- 대상 1: `전동칫솔` / 판매자 상품ID `12649811979`
  - 공식 API 결과 순번 168, 관련 원부 34, `checkedCount=300`
  - `matchedProductId=12649811979`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 대상 2: `치아미백제` / 판매자 상품ID `5145848584`
  - 공식 API 결과 순번 43, 관련 원부 9, `checkedCount=300`
  - `matchedProductId=5145848584`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- `npm run check:quality` 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 순위 매칭·기준선·크론·키워드 트렌드·Vercel 빌드 통과
- 로컬 인앱 브라우저는 `127.0.0.1` 접근이 `ERR_BLOCKED_BY_CLIENT`로 차단되어 운영 배포 후 실제 도메인에서 관리자·광고주 화면을 재검증한다.
- 공식 Shopping Search API의 검색 순번은 제공되지만 실제 쇼핑 화면 페이지 위치와의 동일성은 공식 문서에서 보장되지 않으므로 페이지 환산을 금지한다.
- Production: `momentinsight-1z4jt31ot-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 API 재조회:
  - `전동칫솔`: 공식 API 168번째, 관련 원부 34번째, 판매자 상품ID 일치, 300개 확인
  - `치아미백제`: 공식 API 43번째, 관련 원부 9번째, 판매자 상품ID 일치, 300개 확인
  - 두 응답 모두 `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 운영 관리자 브라우저: 공식 API 168번째, 화면 위치 미검증, 300개 확인, 관련 원부/상품 ID 일치 카드와 각 링크 목적지 확인
- 운영 관리자·광고주 HTML: 공식 API 결과 순번·실제 화면 위치 아님·상품 ID 일치·프리미엄 사이드바 마커 확인, 40개 단위 페이지 환산 코드 없음

## 2026-07-14 · 네이버 상품 페이지 오표기 제거

- 운영 API 재현: `전동칫솔`/판매자 상품ID `12649811979`는 공식 쇼핑 검색 API 168번째 결과에서 링크 상품ID가 정확히 일치했다.
- 기존 오류: API 배열 순번 168을 40개 단위로 환산해 `5페이지 8위`로 표시했으나 실제 쇼핑 화면 위치를 검증하는 근거가 없었다.
- 실화면 접근: 인앱 브라우저, 사용자 Chrome, 직접 HTTP 요청 모두 네이버 쇼핑의 비정상 접근 제한(HTTP 418)으로 차단됐다. 우회하지 않고 미검증으로 처리했다.
- 로컬 API: `rank=168`, `rankBasis=official_api_result_order`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`, `matchedProductId=12649811979`.
- 카드 결과: 관련 원부 API 34번째, 입력 상품 API 168번째. 두 카드 모두 페이지 위치를 표시하지 않는다.
- `npm run check:rank-matching`: 통과. 40개 단위 환산 함수 제거, 41번째 결과도 페이지 필드가 없음을 회귀 검사했다.
- `npm run check:baseline`: `naverRankDoesNotFabricateWebPagePosition=true` 포함 전체 통과.
- `npm run check:quality`: 독립 실행 2회 통과. 각 실행에 서버 테스트 13개, 플레이스 수집기 25개, Vercel 정적 빌드 포함.
- `git diff --check`: 통과.
- 운영 배포: 없음.

> 아래 과거 기록의 `N페이지 N번째`, `광고 제외 오가닉 순위` 표현은 당시 API 배열 순번을 화면 순위로 해석한 기록이다. 현재 순위 원천은 문서 최상단의 2026-08-02 hybrid 원자 수집 계약이며 과거 API 결과는 신규 순위 근거가 아니다.

기준일: 2026-07-14

## UI/UX 1차 고도화 · 상태 진실성 및 첫 화면 밀도

- 운영 홈: 실제 집계가 아닌 `12개·4건·3건·2건`, 브랜드 예시 3건, 과거 업데이트 날짜 제거
- 운영 홈 대체 흐름: 광고주 연결 → 운영 입력 → 공개 승인 → 보고서 관리 작업 카드 4개와 3단계 운영 순서 제공
- 광고주 빈 상태: `공개 준비 중`, `데이터 상태: 공개 데이터 연결 대기`, `데이터 대기`, `운영팀 공개 입력 전` 동시 전환 확인
- 광고주 데이터 상태 회귀: `4,180만원` 상태에서 `업데이트 완료`, `운영팀 검수 완료`, `공개용` 유지 확인
- 빈 보고서함: 오래된 기본 월간 보고서 대신 `공개 보고서 없음` 표시
- 모바일 광고주 390×844: 빈 요약 카드 401px, 핵심 지표 3열, 액션 2열, `scrollWidth=390`
- 모바일 운영팀 390×844: 작업 카드 4개, `scrollWidth=390`, 카드·메뉴 겹침 없음
- 운영팀 CTA: `광고주 연결` 카드가 `agency-code` 화면으로 정확히 이동
- 스크롤 복귀: 운영팀 `scrollY 554.5 → 0`, 광고주 `scrollY 539 → 0` 확인
- 로컬 브라우저 로그: 오류 0건
- `npm run check:quality`: 통과, 서버 테스트 13/13·플레이스 수집기 25/25·Vercel 빌드 포함
- `npm run check:supabase`: HTTP 200, publishable key·JWKS 정상
- `npm run check:env`: 필수 환경 항목 정상, 기존 선택 항목 미설정 상태는 유지
- Supabase 스키마·RLS·운영 데이터 변경 없음, 삭제·마이그레이션 없음
- 배포: 운영 영향 보고 전 대기

## 네이버 상품 대표 순위·페이지 표기 정상화

- 로그인 네이버 가격비교: `전동칫솔`, 네이버 랭킹순, 40개씩 보기
- 실화면 원부: `57907660073`, 오가닉 34위, 1페이지 34위
- 실화면 정확 상품: 판매자 상품ID `12649811979`, API 항목 ID `90194322885`, 오가닉 168위, 5페이지 8위
- 정확 상품 DOM 근거: `chnl_prod_no=12649811979`, `organic_expose_order=8`, 페이지 `5`
- 로컬 API: 대표 34위·원부형·1페이지 34위, 정확 상품 168위·단일형·5페이지 8위, 300개 확인
- `치아미백제` 회귀: 대표 원부 9위·정확 상품 43위, 원부형 정상
- 관리자 로컬 실조회: 대표 카드와 노출 카드 2건, 상품명은 키워드 검색, 상품 열기는 원부/입력 상품 상세로 분리
- 광고주 로컬 실조회: 관리자와 동일한 숫자·형태·링크 확인
- 광고주 390×844: `innerWidth=390`, 문서 `scrollWidth=375`, 전체 가로 넘침 없음
- 관리자·광고주 브라우저 경고·오류: 0건
- 서버형 Playwright 네이버 화면 접근: HTTP 418 재현, 운영 수집 성공으로 오인하지 않음
- `npm run check:env:naver`: 필수 네이버·Supabase 환경 준비
- `npm run check:quality`: 독립 1차 통과
- `npm run check:quality`: 독립 2차 통과
- 서버 테스트 13/13, 플레이스 수집기 25/25, 릴리즈 기준선과 Vercel 빌드 통과
- `git diff --check`: 통과
- Production 배포: `momentinsight-3whvmsjzo-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`, 관리자·광고주 HTML, 순위 API: HTTP 200
- 운영 API: 대표 원부 34위·1페이지 34위, 정확 상품 168위·5페이지 8위, `checkedCount=300`
- 운영 관리자·광고주 실조회: 대표 원부형 34위, 정확 단일형 168위, 두 카드의 페이지 위치와 원부·스마트스토어 상세 링크 정상
- 운영 데스크톱 육안검수: 상태 메시지·순위 요약·카드 구분·프리미엄 레이아웃 겹침 없음

## 네이버 상품 정확 일치·300위 완주 재검증

- 입력: `전동칫솔`, `https://brand.naver.com/lav/products/12649811979`, 300위
- 네이버 공식 API 원문 300개: 관련 원부 `57907660073` 33위, 입력 URL 판매자 상품ID `12649811979` 173위
- 173위 API 항목: API `productId=90194322885`, 결과 링크 판매자 상품ID `12649811979`, 판매처 `라이브오랄스`, 69,000원
- 실제 입력 상품 페이지: 상품번호 `12649811979`, 제목 `라이브오랄스 음파 전동칫솔 회전 IPX8 방수 C타입 충전식 초극세모 칫솔모 3P`, 판매처·가격까지 API 항목과 일치
- 판정: 173위는 다른 업체가 아니라 입력 URL의 동일 판매자 상품이며, 원부 33위와 판매처 단일 상품 173위가 함께 노출되는 구조
- 보강 후 일치 근거: `seller_link_product_id`; API `productId`만 같은 다른 링크 상품은 불일치
- 보강 후 수집 범위: 정확 상품 173위를 찾은 뒤에도 오가닉 300개 확인, 카드 2건 유지
- 상세 링크: 관련 원부는 `catalog/57907660073`, 정확 상품은 입력 원본 `brand.naver.com/lav/products/12649811979`
- 정상 회귀: `치아미백제`/`5145848584` 관련 원부 7위·정확 상품 48위·300개 확인
- 오판 회귀: `게이밍노트북`/`12649811979`는 오가닉 300개 확인 후 미발견
- 임의 중복 제거 실험은 원부를 33위에서 29위로 변경해 제외; 공식 API 슬롯 순서 유지
- 로컬 운영팀 1280px: 카드 2건, 카드 높이 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 로컬 광고주 390×844: 카드 폭 276px, `scrollWidth=390`, 콘솔 오류 0건
- 전체 `npm run check:quality`: 1차 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- 전체 `npm run check:quality`: 동일 기준 2차 통과
- `npm run check:env:naver`, `npm run check:supabase`: 정상
- Production: `momentinsight-mmeqlbh43-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- 운영 API: `rank=173`, `checkedCount=300`, `matchEvidence=seller_link_product_id`, `matchedProductId=12649811979`
- 운영팀 1280px 실조회: 원부 33위·정확 상품 173위·300개 확인, 카드 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 운영 광고주 390×844 실조회: 카드 폭 276px, `scrollWidth=390`, 원부/정확 상품 상세 링크 정상, 콘솔 오류 0건
- 라이브 `/health`: HTTP 200

## 오가닉 노출 카드 컴팩트 프리미엄화

- 관리자·광고주 공통 카드: 이미지 84×84px, 최소 높이 116px, 14px 보드 라운드와 낮은 그림자 적용
- 관련 원부 배지: `#eaf9f0` 배경, `#087f45` 글자, `#bcebd0` 테두리의 네이버 민트·그린 톤 적용
- 상품명 링크: 조회 키워드를 포함한 `search.shopping.naver.com/search/all` 검색 결과 주소
- `상품 열기` 링크: 각 `productExposureItems`의 기존 상품 상세 URL
- 릴리즈 기준선: 두 역할의 키워드 링크, 상품 상세 링크, 그린 배지 마커 검사 통과
- 전체 `npm run check:quality`: 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- Vercel Preview: `momentinsight-533u2sq4m-momentlabs.vercel.app`, 빌드 READY
- Preview 브라우저 조회: 화면·입력·300위 옵션은 정상이며 네이버 쇼핑 API 환경변수 미연결 메시지를 확인. 실조회 UI는 Production에서 최종 검증했다.
- Production: `momentinsight-c4ylvfjb4-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 실조회: `치아미백제`/상품 `5145848584`, 정확 상품 48위·2페이지 8번째, 관련 원부 `56704991367` 7위·1페이지 7번째
- 운영팀·광고주 데스크톱: 카드 2건, 카드 높이 각각 127px, 이미지 84×84px, 관련 원부 계산 색상 `rgb(234, 249, 240)`·`rgb(8, 127, 69)`
- 운영팀·광고주 390×844: 카드 폭 각각 276px, 이미지 72×72px, 문서 `scrollWidth=390`, 가로 넘침 없음
- 두 역할 상품명 2개: 모두 `search.shopping.naver.com/search/all`의 `치아미백제` 검색 결과로 연결
- 두 역할 `상품 열기` 2개: 관련 원부 `catalog/56704991367`, 정확 상품 `products/5145848584` 상세로 연결
- 운영팀·광고주 브라우저 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 컴팩트 카드·키워드 링크·민트 배지 마커 확인

## 운영팀·광고주 공통 사이드바

- 전체 `npm run check:quality`: 통과
- 릴리즈 기준선: `clientNavigationTaxonomy`, `roleSidebarsSharePremiumShell` 포함 전체 통과
- Vercel Preview: `momentinsight-5fm1vq6dw-momentlabs.vercel.app`, 빌드 READY
- 운영팀 1280×720 실화면: 사이드바 236px, 높이 720px, 문서 `scrollWidth=1280`, 네 개 공통 메뉴 분류 확인
- 운영팀 활성 메뉴: 딥네이비 왼쪽 라인, 프리미엄 그라데이션 배경과 그림자 계산값 확인
- 광고주 Preview DOM: `운영`, `키워드·SEO`, `순위 조회·추적`, `광고 조사` 순서와 10개 역할 허용 메뉴 확인
- 광고주 계산 CSS: 236px 그리드, 운영팀과 동일한 배경·그림자·활성 그라데이션·42px 브랜드 높이 확인
- 광고주 390×844 반응형 규칙: 데스크톱 메뉴 숨김, 모바일 메뉴 flex, 최대 폭 366px, 동일 메뉴 순서 확인
- Production: `momentinsight-1eo93tbd5-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 광고주 데스크톱 실로그인: 사이드바 236px, 네 개 공통 메뉴 분류, 운영팀과 동일한 배경·그림자·활성 그라데이션 확인
- 운영 광고주 390×844 실로그인: 모바일 메뉴 flex, 문서 `scrollWidth=390`, 카드·텍스트 겹침 및 전체 가로 넘침 없음
- 운영 관리자·광고주 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 두 HTML 모두 `data-mi-shell="premium-sidebar"` 확인

## 연속 개발 운영 규칙 검증

- 기존 플레이스 수정 커밋 `3638a73`과 배포 대기 상태를 보존한 채 문서만 변경했다.
- 작업 전 `git status --short --branch`, 최근 커밋, 작업명세, 작업 상태, 결정, 다음 작업, 검증 근거를 확인했다.
- `npm run work:autosave`로 작업 시작 기준점을 기록했다.
- `AGENTS.md`, 작업명세, 프로젝트 기억, 상태, 결정, 다음 작업에 사전 확인·중복 검색·기존 diff 보존·2차 검증·논리 단위 커밋·배포 게이트가 함께 기록됐는지 검색 검사한다.
- 문서 변경 후 `npm run check:baseline`, `git diff --check`, 최종 diff·Git 상태를 재확인한다.

## 네이버 플레이스 장애 재현

- 키워드: `부평 맛집`
- 플레이스 URL/ID: `2019299673`
- 자동 식별 상호명: `팽오리농장 부평점`
- 운영 실패 원문: 세 Apify Actor 모두 `Monthly usage hard limit exceeded`
- 자체 브라우저 수집: 광고 제외 오가닉 54개, 약 70초, 대상 미발견, `collection_deadline_reached`
- 판정: 300위 밖으로 확정하지 않고 `54위까지 확인 · 이후 미검증`
- `npm run check:quality`: 통과
- 플레이스 수집기: 25개 테스트 통과
- 플레이스 서버: 9개 테스트 통과
- `git diff --check`: 통과

## 실제 네이버 조회

- 키워드: `치아미백제`
- 입력 URL: `https://brand.naver.com/lav/products/5145848584`
- 정확 대상 상품ID: `5145848584`
- 결과: 광고 제외 오가닉 48위
- 페이지·위치: 2페이지 8번째
- 매칭: `product_id`
- 대상 모드: `product`
- 잘못 연결되던 카탈로그 ID `59606749556`: 결과에서 사용되지 않음
- 상품 노출 카드: 2건
  - 7위, 1페이지 7번째: 관련 원부 `56704991367`
  - 48위, 2페이지 8번째: 정확 상품 `5145848584`
- 같은 판매처의 무관한 44위 불소 상품: 카드에서 제외
- 잘못 연결되던 원부 `59606749556`: 카드에서 제외

순위는 조회 시점에 따라 바뀔 수 있으며, 이 기록은 정확 일치 로직 검증 증거다.

## 자동 검사

- `npm run check:quality`: 통과
  - 릴리즈 기준선 통과
  - 서버 문법 검사 통과
  - 순위 크론 일정 검사 통과
  - 네이버 상품 매칭 회귀 검사 통과
  - 키워드 트렌드 검사 통과
  - 서버 테스트 12개 통과
  - 플레이스 수집기 테스트 22개 통과
  - Vercel 정적 빌드 통과
- `npm run check:env:naver`: 필수 네이버·Supabase 실행환경 준비 확인
- `npm run check:supabase`: HTTP 200과 JWKS 연결 확인
- `git diff --check`: 공백 오류 없음

## 브라우저 QA

관리자와 광고주 화면에서 각각 로그인 → 키워드/URL 입력 → 순위 조회를 실제 수행했다.

- 데스크톱: 1280×720 브라우저 실조회
- 모바일: 390×844
- 두 화면 모두 오가닉 48위, 관련 원부 7위, 정확 상품 48위 확인
- 두 화면 모두 카드 2개, 이미지 2개, 상품 링크 2개 확인
- 두 화면 모두 잘못된 카탈로그 ID와 무관한 불소 상품 미표시
- 데스크톱 `scrollWidth=1280`, 모바일 `scrollWidth=390`으로 가로 넘침 없음
- 모바일 카드 폭 276px, 상품명 줄바꿈, 버튼과 안내 문구 정상 확인

## Production 배포 후 검증

- 배포: `momentinsight-d7nu7j61r-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- `/health`: HTTP 200, API 정상, Supabase 준비 상태 정상
- 관리자·광고주 화면: HTTP 200, `renderProductExposureCards`, 카드 스타일, `광고상품 미연결` 마커 확인
- 라이브 상품 순위 API: HTTP 200, `matchType=product_id`, `targetProductId=5145848584`, `targetCatalogId` 빈값
- 라이브 노출 결과: 관련 원부 `56704991367` 7위, 정확 상품 `5145848584` 48위
- 라이브 관리자·광고주 데스크톱: 카드·이미지·링크 각각 2개, 가로 넘침 없음
- 라이브 관리자·광고주 390×844: 카드·이미지·링크 각각 2개, `scrollWidth=390`
- 잘못된 원부 `59606749556`과 같은 판매처의 무관한 불소 상품: 라이브 화면 미표시

## 2026-07-20 플레이스 네이티브 오가닉 v16·네이버 API 공지 감사

- 순위 권위: `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`인 네이버 PC 실제 장소 목록만 저장한다. 두 표식 중 하나라도 누락·불일치하면 `place_rank_provider_untrusted_evidence`로 실패하고 새 snapshot을 만들지 않으며 기존 current/best/check_count·30일 이력을 보존한다.
- 수집 예산: Vercel이 Render cold start를 포함한 절대 `providerDeadlineAt`을 전달하고, 수집기는 최대 225초 안에서 응답·브라우저 종료 여유 12초를 확보한다. viewport 1440×1600과 겹침 스크롤을 사용한다.
- 로컬 실조회 1차: `홍대 맛집`/`1907427831` 100개 확인·정확 ID 오가닉 7위·30.770초, `부평 맛집`/`2019299673` 100개 확인·미발견·rank null·31.024초. 두 결과 모두 네이티브 source/evidence를 반환했다.
- 육안 2차: 네이버 PC 목록의 상단 광고 3건을 순위에서 제외했고, 첫 오가닉 1~5위가 수집 결과와 일치했다. 동일 시점 독립 수집의 top10 ID·순서도 일치했다. 공개 목록이 100개에서 끝나므로 101~300위는 확정하지 않는다.
- 자동 검증: 전체 `npm run check:release` 통과. API·서버 154/154, 플레이스 tracker 43/43, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 query parity·공개 빌드 CSP 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, N상품 수집·대표값 판정, 기존 30일 snapshot 조회·저장 로직은 diff 없음.
- 독립 코드 재검수: 최초 P1이었던 공급자 근거 미강제를 보완한 뒤 P0/P1 0건으로 통과했다.
- 공식 메일 확인: 발신자·공지 링크를 네이버 개발자센터 공식 공지와 대조했다. Search Trend·Shopping Insight·일반 Search 일부는 NAVER API Hub 이관 대상이지만 쇼핑 검색은 별도 공지상 이관 제외, 2026-07-31 종료, 대체 API 없음이다.
- 2026-07-20 legacy 실호출: 기존 Search Trend·쇼핑 검색은 HTTP 200으로 응답해 이번 플레이스 오류의 직접 원인이 아님을 확인했다.
- 공식 근거: `https://developers.naver.com/notice/article/32530`, `https://developers.naver.com/notice/article/32564`, `https://guide.ncloud-docs.com/docs/apihub-migration`.
- 운영 배포: Vercel `/health`·`/ready` 릴리즈 `bfa97e38304d`(기능 코드 `5014d1a` 포함), Supabase `ready`; Render `/health` 릴리즈 `2026-07-20-native-organic-deadline-v16`, `configured=true`, `busy=false` 확인.
- 운영 snapshot: `홍대 맛집`/`1907427831`은 `checked_count=97`, `rank=7`, `matched=true`; `부평 맛집`/`2019299673`은 `checked_count=77`, `rank=null`, `matched=false`. 두 source 모두 `naver_map_pc_list_collector`, place ID 정확 일치, 블로그·방문 coverage 전체 충족.
- 이력 보존: 과거 `_fallback` snapshot은 그대로 남겼고 새 v16 snapshot만 추가했다. 현재값·best·기존 30일 기록 삭제·소급 재작성 없음.
- workflow 판정: 두 호출과 저장은 정상 완료했으나 `부평 맛집`의 300위 미완주를 숨기지 않도록 `partial>0` 정책이 첫 실행을 경고 실패로 종료했다. transport·provider 오류와 tracker `last_error`는 없음.

## 2026-07-22 플레이스 의료 키워드 네이티브 경로 정상화

- 운영 데이터 진단: 플레이스ID `1531240094`의 `종로3가한의원`·`종로한의원` 추적은 각각 retry 31회·30회, snapshot 0건이며 마지막 오류는 모두 `#_pcmap_list_scroll_container` 8초 timeout이었다. 기존 추적 행과 이력은 삭제·수정하지 않았다.
- 직접 원인: 네이버 실제 검색 화면은 두 키워드를 `https://pcmap.place.naver.com/hospital/list`로 열고 정확 ID `1531240094`를 목록에 포함한다. 기존 수집기는 이를 `place/list?display=300`으로 다시 열어 `조건에 맞는 업체가 없습니다` 페이지로 리디렉션됐다.
- 수정 기준: 검색 화면이 만든 정확한 HTTPS `pcmap.place.naver.com` 목록 URL만 허용한다. `hospital/list`는 네이티브 `display=70`, `clientX`·`clientY`·`searchText` 문맥을 보존하고, `restaurant/list`는 기존 `display=300` 확장을 유지한다. 호스트 문자열만 포함한 비네이버 URL은 거부한다.
- 대상 실조회: 광고 제외 네이버 PC 오가닉 목록에서 `종로3가한의원` 3위, `종로한의원` 12위이며 두 건 모두 정확 ID `1531240094`, `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`다.
- 2차 회귀: `홍대 맛집`/`1907427831`은 100개 확인·7위, `부평 맛집`/`2019299673`은 100개 확인·미발견·partial이며 기존 진실 표기가 유지됐다.
- 자동 검증: 플레이스 수집기 47/47, API·서버 154/154, 서버 계약 22/22, Production 인증 18/18, 전체 `npm run check:release`, 공개 빌드·역할 parity·`git diff --check` 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, 서버 snapshot 저장 계약, Supabase 스키마, N상품 순위와 기존 30일 기록은 변경하지 않았다.

### 느린 운영 프레임 회귀 검증

- 운영 v17 재실행: 두 tracker 모두 selector 8초 timeout 재현. 원인은 네이티브 프레임 6초 대기 만료 뒤 일반 목록 URL을 만든 폴백이었다.
- 단위 회귀: 첫 네이티브 프레임 미발견 후 두 번째 검색 성공, 두 번 모두 미발견 시 fail-closed를 각각 검사한다.
- 플레이스 수집기: 49/49 통과.
- 전체 `npm run check:release`: 통과. API·서버 154/154, 서버 계약 22/22, Production 인증 18/18.
- 로컬 실제 네이버 PC 오가닉: `종로3가한의원` 3위, `종로한의원` 10위, 각각 70개 확인·정확 ID `1531240094` 일치.

### v18 Production 저장 증거

- Render `/health`: `release=2026-07-22-native-medical-list-v18`, `configured=true`.
- Vercel `/health`: `release=b7919bc86348`, HTTP 200.
- `종로3가한의원`: 2026-07-22 15:51 KST, 오가닉 3위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- `종로한의원`: 2026-07-22 15:56 KST, 오가닉 10위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- 두 tracker 현재 상태: `retry_count=0`, `last_error=null`, `check_count=1`, `found_count=1`, 처리 임대 해제, 다음 정규 실행 2026-07-23 09:00 KST.

## 2026-07-22 N 상품·N 플레이스 30일 보호 잠금·운영 배포

- 잠금 의미: `scripts/check-protected-rank-features.mjs`는 보호 코드의 해시와 새 순위 마이그레이션을 빌드·릴리스에서 검사할 뿐 런타임 요청 경로에는 포함되지 않는다. 신규 키워드 조회, N 상품 단건 조회, N 상품·플레이스 추적 등록과 갱신은 계속 허용한다.
- 회귀 고정: 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`이 운영팀·광고주 신규 키워드 조회 버튼, 상품 단건 조회, 상품·플레이스 추적 등록 버튼과 양 서버의 `action=create` 경로를 확인한다.
- 자동 검증: 정상 잠금 4개 함수·20개 파일·11개 마이그레이션, 의도적 변조 self-test 차단, API·서버 162/162, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity·공개 빌드·CSP 통과.
- 배포 빌드: Vercel CLI가 수집기 `.dockerignore`를 업로드에서 제외하는 환경 차이를 확인했다. 로컬·CI는 실제 `.dockerignore`와 `dockerignore.policy`의 완전 일치를 강제하고, Vercel은 같은 정책 사본을 검사하도록 보완해 공급망 검사를 우회하지 않았다.
- 운영 API: `/health` HTTP 200·`release=f8bf0a3b37a1`, `/ready` HTTP 200·Supabase ready, 상품·플레이스 보호 API 비인증 401.
- 운영 UI: 홈페이지 팝업 348×489px, `N 상품 순위`·`N 30일 순위`·`N 플레이스 30일 순위` 각 1건, 1280px 가로 넘침 0. 총관리자에서 신규 키워드 조회·상품 추적·플레이스 추적 버튼 모두 활성, 기존 상품 추적 25개·플레이스 추적 10개와 30일 이력 로드 확인.
- 배포: Production `https://momentinsight-idchb9x5n-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`. 이번 범위는 Render 수집기 런타임 변경이 없어 Render는 재배포하지 않았다.

## 2026-07-23 4대 핵심 조회·추적 기능 변경 잠금 확장

- 보호 범위: 운영팀·광고주의 `runKeywordLookup`, `initRankCheck`, `initRankTracking`, `initPlaceRankTracking`과 키워드 API Hub 핵심 함수, 키워드·상품 단건·상품/플레이스 30일 서버·크론·수집기·워크플로·순위 DB 마이그레이션을 13함수·21파일·11마이그레이션으로 고정했다.
- 잠금 의미: 런타임 버튼이나 API를 닫는 기능이 아니다. 승인 없이 보호 코드를 바꾸면 `check:quality`와 `check:release`가 실패하며, 신규 키워드 조회·N 상품 순위 조회·상품/플레이스 추적 등록·갱신과 보호 범위 밖 신규 기능은 계속 동작한다.
- 변조 2차 검수: self-test가 13개 보호 함수와 21개 보호 파일을 각각 하나씩 변조해 모두 차단했고, 가상 신규 순위 마이그레이션도 자동 탐지했다.
- 사용 경로 회귀: 운영팀·광고주 양쪽에서 4개 기능 진입 함수와 버튼, 상품·플레이스 `action=create` 및 갱신 경로를 확인했다. 빌드 잠금 스크립트는 페이지·키워드·상품·플레이스 런타임 소스에 포함되지 않는다.
- 전체 자동 검증: API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity, 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`, 공개 빌드·CSP와 전체 `npm run check:release`가 통과했다.
- 변경 비범위: 실제 키워드 조회·상품 순위 계산·상품/플레이스 수집·스냅샷 저장 코드와 `src/pages/admin.html`, `src/pages/client.html`, Supabase 데이터는 수정하지 않았다.
- 운영 배포: 사용자 승인 후 코드 `6c5d10d`를 원격 `main`과 Production `https://momentinsight-htm9llc9v-momentlabs.vercel.app`·운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다. 운영 `/health`와 `/ready`가 릴리스 `6c5d10d1deef`, live, Supabase ready를 반환했다.

## 2026-08-09 N 쇼핑 가격비교 v1.0.11 안정화 검증

- 실화면: Chrome `동빈` 프로필에서 가격비교 `/search/all`, `pagingSize=40`, `productSet=total`, `sort=rel` 정상 결과를 확인했다.
- 실패 안전: 2026-08-09 18:32 KST 수동 실행은 2페이지에서 `naver_network_restricted`로 중단됐고 native host는 `max_jobs=1`, `exit status=0`으로 종료했다. 완전 300개가 아니므로 DB 제출·현재값 교체를 하지 않는다.
- 요청 안정화: 첫 요청 30~45초, 페이지 간 45~75초, catch-up 30분, 순차 1개 키워드를 정적 계약과 테스트로 고정했다.
- 자동 검증: 네이티브 호스트 12/12, API·서버 393/393, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 self-test와 전체 `npm run check:release`, `git diff --check` 통과.
- Production gate: 공식 상단 실응답 `checkedCount=44`, 광고 제외·정확 매칭 가능 상태와 최근 원자 수집 `checkedCount=300`, `source=naver_shopping_results_collector`를 함께 확인해 `SHOPPING_RANK_HYBRID_LIVE_READY`·`deploymentEligible=true`로 통과했다.
- 배포: 코드 `c29b381`을 GitHub `main`과 Production `dpl_DottuAAAw2adGYwBTC1xAvK1xxps`에 반영했다. 운영 별칭은 `https://insight.momentlabs.co.kr`, `/health`·`/ready`는 릴리스 `c29b3812dd8f`, 서울 `icn1`, Supabase ready다.
- Mac 동기화: Production 반영 뒤 브리지를 재설치했다. 설치된 네이티브 호스트 wrapper SHA-256은 저장소와 일치하고 한 회차 `max_jobs=1`, 확장 프로그램 소스 버전 `1.0.11`, 08:50·14:50 KST 사전 기동 스케줄을 유지한다.
- 운영 한계: 2026-08-09 19:50 KST 확인 시 열린 가격비교 탭은 네이버 네트워크 제한 상태다. 이 외부 제한은 배포 성공과 별개이며 제한 중 새 300개 수집을 주장하지 않는다. 부분 데이터는 저장하지 않고 마지막 정상값을 유지한다.

## 2026-08-09 동빈 → 개발 프로필 원격 갱신 v1.0.12

- 집중 회귀: 원격 신호 없음 시 네이버 미접속, 신호 1회당 최대 1작업, signed `claim-wake`, 300위 조회 wake, 계정 범위 전체 갱신 wake, RLS·service-role 전용 마이그레이션을 포함해 109/109 통과.
- 전체 회귀: API·서버 397/397, 플레이스 수집기 51/51, 쇼핑 수집기 51/51 통과.
- 계약: 서버 계약 38/38, Production 인증 18/18, 역할 5상태·관리자/광고주 parity, 보호 잠금 22함수·60파일·15마이그레이션 통과.
- 공개 빌드: 관리자·광고주 변경 스크립트의 CSP SHA-256을 갱신하고 9파일·인라인 6개·고유 해시 4개·비밀 서명 0건으로 통과.
- 최종 검증: `npm run check:release`와 `git diff --check` 통과.
- 운영 쓰기 없음: Supabase 마이그레이션·운영 데이터·GitHub push·Vercel Production·Mac 브리지/확장 `1.0.12` 설치는 승인 전이라 실행하지 않았다.

## 2026-08-09 N 쇼핑 접속 제한 자동 복구 v1.0.13

- 입력 증거: `search.shopping.naver.com/search/all`에서 `쇼핑 서비스 접속이 일시적으로 제한되었습니다` 화면과 네이버가 안내한 짧은 시간 다수 요청·VPN·특정 확장 프로그램 제한 사유를 확인했다.
- 실패 안전: 제한·HTTP 418·429는 즉시 중단하고 완전한 300개가 아니면 제출하지 않는다. 제한 대기 중 DOM 상태 확인 외 네이버 탐색·새로고침을 하지 않는다.
- 자동 복구 계약: 2시간·6시간·12시간·24시간 단계형 대기, 만료 후 `rank-recovery` 1건, 성공 시 단계 초기화, 재제한 시 다음 단계 이동을 확장 소스와 정적 회귀로 고정했다.
- 보안확인 계약: CAPTCHA 풀이·쿠키 접근·로컬스토리지·요청 가로채기·브라우저 기록 접근은 사용하지 않는다. 사람이 정상 화면으로 돌리면 1분 알람이 감지해 1건만 재개한다.
- 팝업 계약: 다음 재시도 시각과 `이후 1건 자동 재시도`를 표시하고 수동 재시작 요구 문구를 제거했다.
- 검증: 네이티브 호스트·로컬 워커 32/32, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18, 공개 빌드·CSP, 전체 `npm run check:release`, JavaScript 문법과 `git diff --check` 통과.
- Supabase: 마이그레이션 `20260809115100_naver_shopping_worker_remote_wake` 적용. `rls_enabled=true`, `rls_forced=true`, anon/authenticated table select=false, service_role select/insert/update=true. 두 RPC는 `security_definer=false`, anon/authenticated execute=false, service_role execute=true다.
- 원자 신호: 트랜잭션 안에서 service_role request 후 첫 claim=true·중복 claim=false를 확인하고 롤백했다. 이후 `naver_shopping_worker_wakes` 운영 행은 0건이다.
- 보안 advisor: 신규 wake 테이블의 `RLS enabled no policy` INFO는 사용자 정책을 의도적으로 0개로 둔 fail-closed 설계다. 이번 RPC 관련 신규 WARN은 없고 기존 `has_client_access`·`is_admin` SECURITY DEFINER WARN은 이번 변경 비범위로 유지했다.
- Production: `dpl_R1YAvtYrTgfqHJ1jAuDFQ3GaPRDX`, `https://momentinsight-8dcpd51mh-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 `release=062ba5935d15`, `region=icn1`, Supabase ready이며 관리자·광고주 HTML 200과 원격 실행 안내를 확인했다.
- Mac: 설치 브리지 14개 파일이 저장소와 byte-for-byte 일치하고 native host allowlist는 고정 확장 ID 1개뿐이다. scheduler config는 `Profile 5`, 10분·08:50·14:50이다.
- Chrome: `동빈(개발)` 확장 `1.0.13` 활성·재로드, 팝업 `접속 제한 보호 중 · 2026. 8. 9. 오후 10:56:10 이후 1건 자동 재시도`를 확인했다. `동빈(Default)`의 같은 ID는 `사용 안함`이다.
- 제한 중 운영 쓰기: 원격 전체 갱신·네이버 새 검색·새 300위 저장은 실행하지 않았다. 현재/최고/최저 순위와 기존 30일 snapshot은 변경하지 않았다.
## 2026-08-10 Windows native host 시작 확인 v1.0.21

- 실기 증거: 확장 LevelDB에 `rank-remote`와 `native_host_start_timeout`이 1분 간격으로 반복됐고, HKCU native messaging 등록·manifest·launcher exe는 모두 존재했습니다. 40초 뒤 관련 프로세스 0건은 확장이 시간 초과 후 연결을 종료한 결과와 일치합니다.
- 회귀: native host·Windows bridge 대상 17/17, 서버 계약 39/39, baseline 및 보호 잠금이 통과했습니다.

## 2026-08-10 Windows native host 양방향 준비 확인 v1.0.22

- 실기 증거: Windows worker가 `볼캡` 작업을 18분 임대했지만 새 가격비교 탭 없이 `native_host_response_timeout`으로 해제됐습니다. DB snapshot은 추가되지 않았고 기존 정상값이 유지됐습니다.
- 수정: native host `ready`와 확장 `ready_ack`를 한 쌍으로 검증한 뒤에만 signed worker claim을 시작합니다.
- 회귀: native host·Windows bridge 17/17, 서버 계약 39/39, API·서버 407/407, 플레이스 51/51, 쇼핑 51/51, Production 인증 18/18, 보호 잠금 22함수·66파일·17마이그레이션 및 전체 `npm run check:release` 통과.
