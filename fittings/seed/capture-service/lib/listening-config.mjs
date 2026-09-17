export const HEARTBEAT_SECONDS = 5;
export const WATCHDOG_TICK_SECONDS = 5;
export const STALL_AFTER_SECONDS = 20;
export const STALL_PUSH_REPEAT_MINUTES = 10;
export const STALL_PUSH_MAX_PER_EPISODE = 2;
export const STOP_HOLD_MS = 1500;
export const RESUME_RETRY_SCHEDULE_SECONDS = [2, 5, 15, 30, 60];
export const RESUME_GIVE_UP_MINUTES = 10;
export const WAKE_ACK_MAX_LATENCY_MS = 1000;
export const LISTENING_REASONS = new Set([
  "user_start", "user_stop", "source_switch", "interruption_began",
  "interruption_ended_resumed", "interruption_ended_no_resume", "route_change",
  "media_services_reset", "engine_error", "permission_denied", "resume_retry",
  "resume_gave_up", "resume_on_foreground", "app_terminated", "watchdog_stalled",
  "watchdog_recovered"
]);
