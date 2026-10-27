/** Remote artwork and source labels; external URLs are validated before rendering. */
import { escape } from "./format.js";
import { icon } from "./icons.js";
export const source = (track) =>
  /soundcloud\.com/i.test(track?.url)
    ? "SoundCloud"
    : /youtu\.?be/i.test(track?.url)
      ? "YouTube"
      : "Stream";
export function imageUrl(track) {
  if (track?.thumbnail && /^https?:\/\//i.test(track.thumbnail)) return track.thumbnail;
  try {
    const u = new URL(track.url);
    const id =
      u.hostname === "youtu.be"
        ? u.pathname.slice(1)
        : /(^|\.)youtube\.com$/.test(u.hostname)
          ? u.searchParams.get("v")
          : null;
    return id && /^[\w-]{11}$/.test(id) ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : "";
  } catch {
    return "";
  }
}
export function art(track, classes, index = 0, extra = "") {
  const url = imageUrl(track);
  return (
    '<div class="cover-art ' +
    classes +
    " tone-" +
    (index % 5) +
    '">' +
    icon("music") +
    (url
      ? '<img src="' + escape(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : "") +
    extra +
    "</div>"
  );
}
