const statusElement = document.getElementById("status");
const runButton = document.getElementById("run");

const FAILURE_TEXT = {
  native_host_not_found: "Chrome을 완전히 종료한 뒤 다시 실행해 주세요",
  native_host_origin_not_allowed: "확장 프로그램 연결 권한을 다시 확인해 주세요",
  native_host_exited: "로컬 연결기가 종료되었습니다. 다시 시도해 주세요",
  native_host_communication_failed: "로컬 연결 통신을 다시 시도해 주세요",
  native_host_disconnected: "로컬 연결 상태를 다시 확인해 주세요",
  native_host_closed: "로컬 연결기가 닫혔습니다. 다시 시도해 주세요",
  native_host_start_timeout: "작업기 연결이 30초 안에 시작되지 않았습니다. 연결기를 다시 확인해 주세요",
  native_host_timeout: "갱신 시간이 초과되었습니다. 자동 재시도합니다",
  already_running: "이미 안전 갱신이 진행 중입니다",
  naver_verification_required: "열린 네이버 보안확인을 완료한 뒤 다시 눌러 주세요",
  naver_verification_cooldown: "보안확인 후 자동 갱신이 다시 이어집니다",
  naver_network_restricted: "네이버 쇼핑 접속 제한을 감지해 자동 재시도를 기다립니다",
  naver_network_retry_wait: "네이버 쇼핑 접속 제한을 보호 대기 중입니다",
  naver_manual_resume_required: "정상 검색 화면이 확인되면 자동으로 다시 시작합니다",
  naver_captcha_detected: "열린 네이버 보안확인을 완료한 뒤 다시 눌러 주세요",
  naver_http_418: "네이버 접근 제한을 감지해 자동 재시도를 기다립니다",
  naver_http_429: "네이버 요청 제한을 감지해 자동 재시도를 기다립니다",
};

function failureText(code) {
  return FAILURE_TEXT[String(code || "")] || "잠시 후 다시 시도해 주세요";
}

function statusText(status) {
  if (status?.status === "running") return "현재 오가닉 순위를 안전하게 확인하고 있습니다.";
  if (status?.status === "completed") return `${status.detail || "갱신 완료"} · ${new Date(status.updatedAt).toLocaleString("ko-KR")}`;
  if (status?.status === "partial") return `${status.detail || "일부 항목 재시도 예정"} · ${new Date(status.updatedAt).toLocaleString("ko-KR")}`;
  if (status?.status === "verification" && status?.retryAt) {
    return `접속 제한 보호 중 · ${new Date(status.retryAt).toLocaleString("ko-KR")} 이후 1건 자동 재시도`;
  }
  if (status?.status === "verification") return `확인 필요 · ${failureText(status.detail)}`;
  if (status?.status === "failed") return `확인 필요 · ${failureText(status.detail)}`;
  return "자동 갱신 준비 완료";
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: "status" });
    statusElement.textContent = statusText(status);
    runButton.textContent = status?.retryAt
      ? "접속 제한 보호 중"
      : status?.status === "verification" ? "확인 후 다시 시작" : "지금 안전 갱신";
  } catch {
    statusElement.textContent = "확인 필요 · 확장 프로그램을 다시 열어 주세요";
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  statusElement.textContent = "갱신을 시작합니다.";
  try {
    const result = await chrome.runtime.sendMessage({ action: "run-now" });
    if (result?.started) {
      statusElement.textContent = "갱신 요청을 접수했습니다. 이 창은 닫아도 됩니다.";
      window.setTimeout(refreshStatus, 1000);
      return;
    }
    const queuedTotal = Math.max(0, Number(result?.summary?.queuedTotal || 0));
    const submitted = Math.max(0, Number(result?.summary?.submitted || 0));
    statusElement.textContent = result?.ok
      ? (queuedTotal > 0
        ? `전체 ${queuedTotal}개 등록 · 이번 회차 ${submitted}개 갱신`
        : "안전 갱신을 완료했습니다.")
      : result?.partial
        ? `일부 갱신 완료 · 재시도 ${Number(result?.summary?.failed || 0) + Number(result?.summary?.releaseFailed || 0)}건`
        : `확인 필요 · ${failureText(result?.code)}`;
  } catch {
    statusElement.textContent = "확인 필요 · 로컬 연결기를 확인해 주세요";
  } finally {
    runButton.disabled = false;
  }
});

refreshStatus();
