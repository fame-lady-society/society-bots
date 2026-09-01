export type ScheduledLane = {
  name: string;
  run(): Promise<void>;
};

export async function runIndependentLanes(lanes: readonly ScheduledLane[]) {
  const results = await Promise.allSettled(lanes.map((lane) => lane.run()));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ lane: lanes[index].name, reason: result.reason }]
      : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Scheduled lanes failed: ${failures.map((failure) => failure.lane).join(", ")}`,
    );
  }
}
