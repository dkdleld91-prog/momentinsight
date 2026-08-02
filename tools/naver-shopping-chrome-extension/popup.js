const statusElement = document.getElementById("status");
const runButton = document.getElementById("run");

const FAILURE_TEXT = {
  native_host_not_found: "로컬 연결기를 다시 설치해 주세요",
  native_host_origin_not_allowed: "확장 프로그램 연결 권한을 다시 확인해 주세요",
  native_host_exited: "로컬 연결기가 종료되었습니다. 다시 시도해 주세요",
  native_host_communication_failed: "로컬 연결 통신을 다시 시도해 주세요",
  native_host_disconnected: "로컬 연결 상태를 다시 확인해 주세요",
  native_host_closed: "로컬 연결기가 닫혔습니다. 다시 시도해 주세요",
  native_host_timeout: "갱신 시간이 초과되었습니다. 자동 재시도합니다",
};

function failureText(code) {
  return FAILURE_TEXT[String(code || "")] || "잠시 후 다시 시도해 주세요";
}

function statusText(status) {
  if (status?.status === "running") return "현재 오가닉 순위를 안전하게 확인하고 있습니다.";
  if (status?.status === "completed") return `${status.detail || "갱신 완료"} · ${new Date(status.updatedAt).toLocaleString("ko-KR")}`;
  if (status?.status === "failed") return `확인 필요 · ${failureText(status.detail)}`;
  return "자동 갱신 준비 완료";
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: "status" });
    statusElement.textContent = statusText(status);
  } catch {
    statusElement.textContent = "확인 필요 · 확장 프로그램을 다시 열어 주세요";
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  statusElement.textContent = "갱신을 시작합니다.";
  try {
    const result = await chrome.runtime.sendMessage({ action: "run-now" });
    statusElement.textContent = result?.ok
      ? "안전 갱신을 완료했습니다."
      : `확인 필요 · ${failureText(result?.code)}`;
  } catch {
    statusElement.textContent = "확인 필요 · 로컬 연결기를 확인해 주세요";
  } finally {
    runButton.disabled = false;
  }
});

refreshStatus();
