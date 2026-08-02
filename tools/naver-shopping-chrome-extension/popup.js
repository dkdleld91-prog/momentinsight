const statusElement = document.getElementById("status");
const runButton = document.getElementById("run");

function statusText(status) {
  if (status?.status === "running") return "현재 오가닉 순위를 안전하게 확인하고 있습니다.";
  if (status?.status === "completed") return `${status.detail || "갱신 완료"} · ${new Date(status.updatedAt).toLocaleString("ko-KR")}`;
  if (status?.status === "failed") return `확인 필요 · ${status.detail || "다시 시도해 주세요"}`;
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
    statusElement.textContent = result?.ok ? "안전 갱신을 완료했습니다." : `확인 필요 · ${result?.code || "실행 실패"}`;
  } catch {
    statusElement.textContent = "확인 필요 · 로컬 연결기를 확인해 주세요";
  } finally {
    runButton.disabled = false;
  }
});

refreshStatus();
