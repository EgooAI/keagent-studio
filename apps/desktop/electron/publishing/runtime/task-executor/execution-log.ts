export interface ExecutionStepReporter {
  record(
    status: "started" | "completed" | "failed",
    step: string,
    message: string,
    options?: { durationMs?: number; error?: unknown; errorCode?: string },
  ): void;
  run<T>(
    step: string,
    message: string,
    action: () => T | Promise<T>,
  ): Promise<T>;
}
