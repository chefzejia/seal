export const CHECK_CODES = [
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
  "C11",
  "C12",
  "C13",
  "C14",
  "C15",
  "C16",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];
export type CheckResults = Record<CheckCode, unknown[]>;
export interface DraftCheckReport {
  draft: string;
  complete: boolean;
  results: CheckResults;
  limitations: string[];
  readonlyHints?: unknown[];
}

export function emptyResults(): CheckResults {
  return Object.fromEntries(
    CHECK_CODES.map((code) => [code, [] as unknown[]]),
  ) as CheckResults;
}

/** Projection and pagination never change these project-wide counts. */
export function completeProjectCheck(volumes: readonly DraftCheckReport[]) {
  const counts = Object.fromEntries(
    CHECK_CODES.map((code) => [code, 0]),
  ) as Record<CheckCode, number>;
  const blockingCounts = { ...counts };
  for (const volume of volumes)
    for (const code of CHECK_CODES) {
      counts[code] += volume.results[code].length;
      blockingCounts[code] +=
        code === "C08"
          ? volume.results[code].filter(
              (issue) =>
                !(
                  issue &&
                  typeof issue === "object" &&
                  "validity" in issue &&
                  issue.validity === "expiring_soon"
                ),
            ).length
          : volume.results[code].length;
    }
  const complete =
    volumes.length > 0 && volumes.every((volume) => volume.complete);
  return {
    ready: complete && CHECK_CODES.every((code) => blockingCounts[code] === 0),
    complete,
    counts,
    blockingCounts,
  };
}
