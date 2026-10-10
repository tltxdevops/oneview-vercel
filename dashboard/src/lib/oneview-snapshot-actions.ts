const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";

export const SNAPSHOT_MUTATION_UNAVAILABLE_REASON =
  "Indisponível enquanto a origem em tempo real não puder ser validada.";

export function formatSnapshotCopyClock(value?: string | null): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Cópia de --:--:--";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: OPERATIONAL_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "--";
  return `Cópia de ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

/** Snapshot list is a copy. Mutations stay closed until the live read returns. */
export function alertsContingencyState(dataSource?: string | null, generatedAt?: string | null) {
  const contingency = dataSource === "snapshot";
  return {
    contingency,
    copyLabel: contingency ? formatSnapshotCopyClock(generatedAt) : null,
    mutationsEnabled: !contingency,
    mutationReason: contingency ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : null,
  };
}
