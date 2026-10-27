import type { Track } from "./player.ts";

/** Groups songs by artist; YouTube's "Artist - Topic" and VEVO channels count as the artist. Unknown artists never match. */
export function artistKey(track: Pick<Track, "artist" | "url">): string {
  const artist = (track.artist ?? "")
    .trim()
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return artist ? "artist:" + artist : "url:" + track.url;
}

/**
 * A random order that keeps items with the same key (artist) apart whenever the mix
 * allows it: each step picks a random artist weighted by how many songs it has left,
 * never the previous one, and takes an artist early when only that keeps the rest
 * separable. `previous` is the key of what plays right before the first item.
 */
export function spreadShuffle<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  previous?: string,
  random = Math.random,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [group[i], group[j]] = [group[j]!, group[i]!];
    }
  }
  const order: T[] = [];
  let last = previous;
  while (order.length < items.length) {
    const left = items.length - order.length;
    const open = [...groups].filter(([key, group]) => key !== last && group.length > 0);
    // An artist holding more than half of what is left must go now, or its songs end up side by side.
    const forced = open.find(([, group]) => group.length * 2 > left);
    let pick = forced ?? undefined;
    if (!pick && open.length) {
      let roll = random() * open.reduce((sum, [, group]) => sum + group.length, 0);
      pick = open.find(([, group]) => (roll -= group.length) < 0) ?? open[open.length - 1];
    }
    // Only the previous artist has songs left: repeating it is unavoidable.
    pick ??= [...groups].find(([, group]) => group.length > 0)!;
    order.push(pick[1].pop()!);
    last = pick[0];
  }
  return order;
}
