/** Search https://www.radio-browser.info, a free directory of ~50k internet radio stations. */

export interface FoundStation {
  name: string;
  url: string;
  country: string;
  codec: string;
  bitrate: number;
  votes: number;
}

interface ApiStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  country: string;
  codec: string;
  bitrate: number;
  clickcount: number;
  votes: number;
}

const SERVERS = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info"];

async function query(params: Record<string, string>): Promise<ApiStation[]> {
  const qs = new URLSearchParams({ limit: "20", hidebroken: "true", order: "clickcount", reverse: "true", ...params });
  let lastError: unknown;
  for (const host of SERVERS) {
    try {
      const res = await fetch(`https://${host}/json/stations/search?${qs}`, {
        headers: { "User-Agent": "radiospeak/0.2" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ApiStation[];
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Radio Browser unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Matches the text against station name, country and tag at once, most popular first. */
export async function searchStations(text: string, limit = 10): Promise<FoundStation[]> {
  const q = text.trim();
  if (!q) return [];
  const results = await Promise.allSettled([query({ name: q }), query({ country: q }), query({ tag: q.toLowerCase() })]);
  const seen = new Set<string>();
  const merged: ApiStation[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const s of r.value) {
      if (!s.url_resolved || seen.has(s.stationuuid)) continue;
      seen.add(s.stationuuid);
      merged.push(s);
    }
  }
  if (merged.length === 0 && results.every((r) => r.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  return merged
    .sort((a, b) => b.clickcount - a.clickcount)
    .slice(0, limit)
    .map((s) => ({
      name: s.name.trim(),
      url: s.url_resolved,
      country: s.country,
      codec: s.codec,
      bitrate: s.bitrate,
      votes: s.votes,
    }));
}
