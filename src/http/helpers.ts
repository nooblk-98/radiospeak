/** HTTP payload validation and safe public track representations. */
import { type IncomingMessage } from "node:http";
import type { Track } from "../audio/player.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const plain = (s: string) => s.replace(/\[\/?b\]/g, "");
export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const httpUrl = (s: unknown): string | undefined => {
  try {
    const url = new URL(str(s));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
export const streamUrl = (s: unknown): string => {
  const url = httpUrl(s);
  if (!url) throw new HttpError(400, "Enter a valid HTTP or HTTPS stream URL");
  return url;
};
export const trackJson = (t: Track) => {
  const { importKey, ...track } = t;
  return {
    ...track,
    duration: t.duration ?? null,
    requestedBy: t.requestedBy ?? null,
    auto: !!t.auto,
  };
};
export async function readJson(
  req: IncomingMessage,
  maxBytes = 256 * 1024,
): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.includes("application/json"))
    throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Invalid JSON object");
  }
}

export function tracksFrom(v: unknown): Track[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const url = httpUrl(o.url);
    if (!url) return [];
    const duration = Number(o.duration);
    const thumbnail = httpUrl(o.thumbnail);
    return [
      {
        url,
        title: str(o.title) || url,
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        ...(str(o.artist) ? { artist: str(o.artist) } : {}),
        ...(thumbnail ? { thumbnail } : {}),
      },
    ];
  });
}

/** Reject stale positional edits instead of accidentally changing a different track. */
export function checkOrder(tracks: readonly Track[], body: Record<string, unknown>): void {
  if (
    body.expected !== undefined &&
    JSON.stringify(body.expected) !== JSON.stringify(tracks.map((t) => t.url))
  ) {
    throw new HttpError(409, "The list changed. Refreshed it; please try again.");
  }
}
