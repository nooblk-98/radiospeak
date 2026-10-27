/**
 * Reads the current song title from a Shoutcast/Icecast stream's ICY metadata.
 * Opens a short-lived second connection, reads up to the first metadata block
 * (about 16 KB) and closes it, so it is cheap to poll every half minute.
 */
export async function fetchIcyTitle(url: string, timeoutMs = 10_000): Promise<string | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "Icy-MetaData": "1", "User-Agent": "radiospeak/0.2" },
      signal: ac.signal,
    });
    const metaint = Number(res.headers.get("icy-metaint"));
    if (!res.ok || !res.body || !Number.isInteger(metaint) || metaint <= 0) return undefined;

    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    for (;;) {
      if (buf.length > metaint && buf.length >= metaint + 1 + buf[metaint]! * 16) break;
      const { value, done } = await reader.read();
      if (done) return undefined;
      buf = Buffer.concat([buf, value]);
    }
    const meta = buf
      .subarray(metaint + 1, metaint + 1 + buf[metaint]! * 16)
      .toString("utf8")
      .replace(/\0+$/, "");
    const match = /StreamTitle='(.*?)';/s.exec(meta);
    const title = match?.[1]?.trim();
    return title || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}
