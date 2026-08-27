// Client-side attachment to an authoritative server-owned plan job.
//
// Deliberately no wall-clock deadline here. The planner's timeout is
// configurable and enforced beside the child process; duplicating it in the
// browser made a healthy 42-minute plan look timed out while the server kept
// working to a successful sentinel. The browser's job is to reflect terminal
// state, not independently invent it.

export interface WaitingPlanJob {
  status: string;
  mode: string;
  error: string | null;
}

export interface WaitingPlanStatus {
  job: WaitingPlanJob | null;
}

export async function waitForPlanStatus<T extends WaitingPlanStatus>({
  getStatus,
  onPhase,
  onJob,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  pollMs = 3000
}: {
  getStatus: () => Promise<T>;
  onPhase: (message: string | null) => void;
  onJob?: (job: T["job"]) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<T> {
  for (;;) {
    const status = await getStatus();
    onJob?.(status.job);
    if (status.job?.status === "done" || status.job?.status === "canceled") {
      onPhase(null);
      return status;
    }
    if (status.job?.status === "failed") {
      throw new Error(status.job.error || "planning failed");
    }
    if (!status.job) {
      throw new Error("plan job lost (drill server restarted?) - retry");
    }
    onPhase(status.job.mode === "update"
      ? "Planning the Book update - an agent session is authoring the pages and steps this change touches…"
      : "Planning the Drill Book - an agent session is exploring the app and authoring pages, steps, and states…");
    await sleep(pollMs);
  }
}
