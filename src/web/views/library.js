/** Library view markup. The controller supplies live state on each render. */
import {
  art,
  button,
  escape as e,
  heading,
  iconButton as ib,
  icon,
  playlistCard,
  time,
  trackTable,
} from "../ui/components.js";
import { playlistTools } from "./management.js";

export function createLibraryViews(getContext) {
  function library(b) {
    const {
      state,
      playlist,
      playlistErrors,
      pages,
      trackCount,
      PAGE_SIZE,
      filterFor,
      playlistCache,
      ensurePlaylist,
      libraryFilter,
    } = getContext();
    const list = playlist();
    if (list) {
      if (playlistErrors.has(list.id))
        return (
          heading(list.name, "Could not load this page.") +
          '<div class="notice">' +
          e(playlistErrors.get(list.id)) +
          "</div>" +
          button("Retry loading", "repeat", "retry-playlist", 'data-id="' + e(list.id) + '"')
        );
      const meta = state.playlists.find((p) => p.id === list.id);
      pages.set(
        list.id,
        Math.min(pages.get(list.id) || 0, Math.max(0, Math.ceil(trackCount(meta) / PAGE_SIZE) - 1)),
      );
      if (
        list.version !== meta?.version ||
        !playlistCache.has(list.id) ||
        list.offset !== (pages.get(list.id) || 0) * PAGE_SIZE ||
        list.filter !== JSON.stringify(filterFor(list.id))
      ) {
        void ensurePlaylist(list.id);
        return (
          heading(list.name, "Loading playlist tracks?") +
          '<div class="loading">Loading tracks?</div>'
        );
      }
      return playlistDetail(b, list);
    }
    const favorites = libraryFilter === "favorites",
      collection = state.collections.find((c) => c.id === libraryFilter);
    const lists = state.playlists.filter(
      (p) =>
        libraryFilter === "all" ||
        (libraryFilter === "standalone" ? !p.collectionId : p.collectionId === libraryFilter),
    );
    return (
      heading(
        "A home for every mood.",
        "Collect the tracks you love. Keep your channel’s soundtrack close.",
        button("New collection", "folder", "new-collection", "", "secondary") +
          button("New playlist", "plus", "new-playlist"),
      ) +
      '<div class="library-toolbar">' +
      [
        ["all", "All playlists"],
        ["standalone", "Standalone"],
        ["favorites", "Favorites"],
        ...state.collections.map((c) => [c.id, c.name]),
      ]
        .map(
          ([id, name]) =>
            '<button class="filter-button ' +
            (libraryFilter === id ? "active" : "") +
            '" data-action="filter" data-id="' +
            e(id) +
            '" aria-pressed="' +
            (libraryFilter === id) +
            '">' +
            e(name) +
            "</button>",
        )
        .join("") +
      "</div>" +
      (collection
        ? '<div class="collection-heading">' +
          icon("folder") +
          "<h2>" +
          e(collection.name) +
          "</h2>" +
          ib(
            "edit",
            "Rename collection",
            "rename-collection",
            'data-id="' + e(collection.id) + '"',
          ) +
          ib(
            "trash",
            "Delete collection",
            "delete-collection",
            'data-id="' + e(collection.id) + '"',
            "danger",
          ) +
          "</div>"
        : "") +
      (favorites
        ? '<div class="section-heading"><h2>Favorite tracks <span class="count-badge">' +
          state.favorites.length +
          "</span></h2></div>" +
          trackTable(state.favorites, "favorites", { editable: false })
        : '<div class="library-cards library-grid">' +
          lists.map((p, i) => playlistCard(p, i, state.defaults[b.name] === p.id)).join("") +
          '<button class="playlist-card new-playlist-card" data-action="new-playlist">' +
          icon("plus") +
          "<span>Create a playlist</span></button></div>") +
      '<section class="card import-card"><h3>' +
      icon("download") +
      ' Bring your playlist with you</h3><p>Import every track from a public YouTube playlist into your library.</p><form id="quick-import" class="inline-form"><input class="field" name="url" type="url" required placeholder="https://www.youtube.com/playlist?list=…" aria-label="Public playlist URL">' +
      '<button class="button secondary" type="submit">' +
      icon("download") +
      "Import playlist</button></form></section>"
    );
  }

  function playlistDetail(b, list) {
    const { state, trackCount, filterFor, selectionFor, pageControls } = getContext();
    const isDefault = state.defaults[b.name] === list.id;
    const selection = selectionFor(list),
      filter = filterFor(list.id);
    return (
      '<button class="text-button" data-action="library-back" style="margin-bottom:22px">' +
      icon("back") +
      'Back to your library</button><div class="playlist-header">' +
      art(list.tracks[0], "playlist-cover") +
      '<div><div class="intro-eyebrow">' +
      e(state.collections.find((c) => c.id === list.collectionId)?.name || "STANDALONE PLAYLIST") +
      "</div><h1>" +
      e(list.name) +
      '</h1><p class="small subtle">' +
      trackCount(list) +
      " tracks · " +
      time(state.playlists.find((p) => p.id === list.id)?.totalDuration || 0) +
      '</p><div class="heading-actions">' +
      button(
        "Play now",
        "play",
        "play-playlist-now",
        'data-id="' +
          e(list.id) +
          '" title="Clear the queue and play this playlist" ' +
          (!trackCount(list) ? "disabled" : ""),
      ) +
      button(
        "Add to queue",
        "plus",
        "queue-playlist",
        'data-id="' + e(list.id) + '" ' + (!trackCount(list) ? "disabled" : ""),
        "secondary",
      ) +
      button(
        isDefault ? "Idle playlist · On" : "Set as idle playlist",
        "repeat",
        "default-playlist",
        'data-id="' + e(list.id) + '" ' + (!trackCount(list) && !isDefault ? "disabled" : ""),
        "secondary",
      ) +
      ib("edit", "Edit playlist", "edit-playlist", 'data-id="' + e(list.id) + '"') +
      ib("trash", "Delete playlist", "delete-playlist", 'data-id="' + e(list.id) + '"', "danger") +
      "</div></div></div>" +
      (isDefault
        ? '<div class="notice">This playlist automatically plays when user requests finish. Radio fallback takes priority if enabled.</div>'
        : "") +
      playlistTools(list, filter, selection) +
      trackTable(list.tracks, list.id, {
        offset: list.offset || 0,
        positions: list.positions,
        selectable: state.viewer?.role !== "listener",
        selected: selection.allMatching
          ? list.positions.filter((i) => !selection.excluded.includes(i))
          : selection.indices,
      }) +
      pageControls(list.id, list.total) +
      '<section class="card import-card"><h3>Add a track or import a playlist</h3><p>Paste a YouTube or SoundCloud URL, a public playlist, or search words.</p><form id="playlist-import" class="inline-form"><input class="field" name="input" required placeholder="Paste a link or search for a song…" aria-label="Track or playlist to import"><label class="check-label"><input type="checkbox" name="skipDuplicates" checked> Skip duplicates</label><button class="button primary" type="submit">' +
      icon("plus") +
      "Add music</button></form></section>"
    );
  }

  return { library, playlistDetail };
}
