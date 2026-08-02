const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function kstSlotUtc(kstDate, hour, minute = 0) {
  return new Date(Date.UTC(
    kstDate.getUTCFullYear(),
    kstDate.getUTCMonth(),
    kstDate.getUTCDate(),
    hour - 9,
    minute,
    0,
    0,
  ));
}

function kstBase(date) {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

export function latestLocalWorkerSlotAt(date = new Date()) {
  const base = kstBase(date);
  const todayNine = kstSlotUtc(base, 9);
  const todayFifteen = kstSlotUtc(base, 15);
  if (date >= todayFifteen) return todayFifteen.toISOString();
  if (date >= todayNine) return todayNine.toISOString();
  return kstSlotUtc(new Date(base.getTime() - DAY_MS), 15).toISOString();
}

export function nextLocalWorkerSlotAt(date = new Date()) {
  const base = kstBase(date);
  const slots = [
    kstSlotUtc(base, 9),
    kstSlotUtc(base, 15),
    kstSlotUtc(new Date(base.getTime() + DAY_MS), 9),
  ];
  return slots.find((slot) => slot > date).toISOString();
}

export function nextLocalWorkerWakeAt(date = new Date(), leadMinutes = 10) {
  const leadMs = Math.max(1, Math.min(30, Number(leadMinutes || 10))) * 60_000;
  const base = kstBase(date);
  const wakeCandidates = [
    new Date(kstSlotUtc(base, 9).getTime() - leadMs),
    new Date(kstSlotUtc(base, 15).getTime() - leadMs),
    new Date(kstSlotUtc(new Date(base.getTime() + DAY_MS), 9).getTime() - leadMs),
  ];
  return wakeCandidates.find((slot) => slot > date).toISOString();
}

export function localWorkerCatchupRequired(lastCompletedSlotAt, date = new Date()) {
  const latestSlot = latestLocalWorkerSlotAt(date);
  const completedAt = Date.parse(String(lastCompletedSlotAt || ""));
  return {
    latestSlot,
    required: !Number.isFinite(completedAt) || completedAt < Date.parse(latestSlot),
  };
}
