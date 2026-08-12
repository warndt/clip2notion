/**
 * Structured logging to the Netlify function log.
 *
 * A background function can't report anything in its HTTP response, so this and
 * the status callout in the page are the only two places a run leaves a trace.
 * Everything is keyed by `clip_id` so one run can be followed end to end.
 */

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, clipId: string, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, clip_id: clipId, event, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function newClipId(): string {
  return `clp_${Math.random().toString(36).slice(2, 10)}`;
}
