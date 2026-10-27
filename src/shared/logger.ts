/** Timestamped process logging shared by both platform transports. */
export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}
