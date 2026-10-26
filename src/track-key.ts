/** Collapse alternate YouTube links without stripping meaningful stream URL parameters. */
export function trackKey(link: string): string {
  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./, "");
    const id = host === "youtu.be" ? url.pathname.split("/")[1]
      : ["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)
        ? url.searchParams.get("v") ?? (/^\/(shorts|embed)\//.test(url.pathname) ? url.pathname.split("/")[2] : null) : null;
    if (id) return "youtube:" + id;
    url.hash = "";
    return url.href;
  } catch { return link; }
}
