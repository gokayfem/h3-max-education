export type LogLevel = "info" | "warn" | "error";

export interface SafeLogContext {
  readonly event?: string;
  readonly code?: string;
  readonly region?: string;
  readonly sessionRef?: string;
  readonly provider?: "openai" | "redis" | "gateway";
  readonly durationMs?: number;
  readonly recoverable?: boolean;
}

export class SafeLogger {
  constructor(private readonly region: string) {}

  write(level: LogLevel, message: string, context: SafeLogContext = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      region: this.region,
      ...context
    };
    const serialized = JSON.stringify(entry);
    if (level === "error") process.stderr.write(`${serialized}\n`);
    else process.stdout.write(`${serialized}\n`);
  }
}
