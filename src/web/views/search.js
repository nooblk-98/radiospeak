/** Search view markup. The controller supplies live state on each render. */
import {
  button,
  escape as e,
  empty,
  heading,
  icon,
  playlistResultCard,
  resultCard,
} from "../ui/components.js";

export function createSearchViews(getContext) {
  function searchView() {
    const { query, searchSource, searchType } = getContext();
    return (
      heading(
        "Find your next favorite.",
        "Search a little. Discover a lot. Set the mood for your channel.",
      ) +
      '<section class="card search-panel"><div class="search-toggles"><div class="source-toggle" aria-label="Search source">' +
      ["youtube", "soundcloud"]
        .map(
          (s) =>
            '<button data-action="search-source" data-id="' +
            s +
            '" class="' +
            (searchSource === s ? "active" : "") +
            '" aria-pressed="' +
            (searchSource === s) +
            '">' +
            icon(s) +
            (s === "youtube" ? "YouTube" : "SoundCloud") +
            "</button>",
        )
        .join("") +
      '</div><div class="source-toggle" aria-label="Search for">' +
      [
        ["tracks", "music", "Songs"],
        ["playlists", "library", "Playlists"],
      ]
        .map(
          ([type, ic, label]) =>
            '<button data-action="search-type" data-id="' +
            type +
            '" class="' +
            (searchType === type ? "active" : "") +
            '" aria-pressed="' +
            (searchType === type) +
            '"' +
            (type === "playlists" && searchSource !== "youtube"
              ? ' disabled title="Playlist search is available for YouTube"'
              : "") +
            ">" +
            icon(ic) +
            label +
            "</button>",
        )
        .join("") +
      '</div></div><form id="search-form"><div class="search-input-wrap">' +
      icon("search") +
      '<input id="search-input" type="search" name="query" autocomplete="off" maxlength="1000" placeholder="Search for a track, artist, or paste a link…" aria-label="Search music" value="' +
      e(query) +
      '"><button class="button primary" type="submit">Search</button></div></form><p class="search-hint">Your next great find is a search away. Public YouTube and SoundCloud links work too.</p></section><div id="search-results">' +
      searchResultsMarkup() +
      "</div>"
    );
  }

  function searchResultsMarkup() {
    const {
      searchSource,
      searchType,
      searchStatus,
      searchError,
      searchResults,
      searchHasMore,
      searchMoreLoading,
    } = getContext();
    if (searchStatus === "loading")
      return (
        '<div class="loading" aria-live="polite">Searching ' +
        (searchSource === "youtube" ? "YouTube" : "SoundCloud") +
        "…</div>"
      );
    if (searchStatus === "error")
      return '<div class="notice" role="alert">' + e(searchError) + "</div>";
    if (searchStatus === "idle")
      return empty(
        "There’s a whole world of music out there",
        "Search by track, artist, or the song you can’t get out of your head.",
      );
    const playlists = searchType === "playlists";
    if (!searchResults.length)
      return playlists
        ? empty("No playlists found", "Try other words, or paste a public playlist link.")
        : empty("No tracks found", "Try another artist, title, or a public media link.");
    return (
      '<div class="section-heading"><h2>' +
      (playlists ? "Playlists" : "Search results") +
      ' <span class="count-badge">' +
      searchResults.length +
      '</span></h2></div><div class="results-grid">' +
      searchResults.map(playlists ? playlistResultCard : resultCard).join("") +
      "</div>" +
      (searchHasMore
        ? '<div class="search-more">' +
          button(
            searchMoreLoading ? "Loading more…" : "Show more results",
            searchMoreLoading ? "clock" : "plus",
            "search-more",
            searchMoreLoading ? 'disabled aria-busy="true"' : "",
            "secondary",
          ) +
          "</div>"
        : "")
    );
  }

  return { searchView, searchResultsMarkup };
}
