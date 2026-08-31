const WAKE_SOURCE_PATTERN = /^[a-z0-9][a-z0-9:_-]{2,63}$/u;

function wakeSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!WAKE_SOURCE_PATTERN.test(normalized)) throw new Error("shopping_worker_wake_source_invalid");
  return normalized;
}

export async function requestShoppingWorkerWake(ctx, source) {
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_request_naver_shopping_worker_wake", {
    p_source: wakeSource(source),
  });
  if (error) return false;
  return data === true;
}

export async function claimShoppingWorkerWake(ctx, control) {
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_worker_wake", {
    p_worker_id: control.workerId,
    p_lane_token: control.laneToken,
    p_run_id: control.runId,
    p_run_trigger: control.runTrigger,
  });
  if (error) throw error;
  return data === true;
}
