/** Dashboard view markup. The controller supplies live state on each render. */
import {
  art,
  botCard,
  button,
  commands,
  duration,
  escape as e,
  heading,
  iconButton as ib,
  icon,
  playlistCard,
  source,
  trackTable,
} from "../ui/components.js";
import { platformName } from "../ui/platforms.js";

export function createDashboardViews(getContext) {
  function hero(b) {
    const { currentTrack, paused } = getContext();
    const t = currentTrack(),
      isPaused = paused(b),
      idle = !t;
    const label = b.autoPaused
      ? "PAUSED · NO LISTENERS"
      : isPaused
        ? "PLAYBACK PAUSED"
        : t
          ? "ON THE AIR"
          : "READY WHEN YOU ARE";
    return (
      '<section class="hero" aria-label="Now playing">' +
      art(t, "hero-art") +
      '<div class="hero-copy"><div class="eyebrow"><span class="status-dot ' +
      (t && !isPaused ? "on" : "") +
      '"></span>' +
      label +
      "</div><h2>" +
      e(t?.title || "Your channel.\nYour soundtrack.") +
      '</h2><div class="artist">' +
      e(t?.artist || (idle ? "Good music sounds better together." : source(t))) +
      '</div><div class="hero-meta">' +
      (t
        ? "<span>" +
          (b.track ? duration(b.track.duration) : "LIVE STREAM") +
          "</span><span>·</span><span>" +
          e(
            b.track?.auto
              ? "From your idle playlist"
              : b.track
                ? "Requested by " + (b.track.requestedBy || "web")
                : "Radio fallback",
          ) +
          "</span>"
        : "<span>YouTube</span><span>·</span><span>SoundCloud</span><span>·</span><span>Live radio</span>") +
      '</div><div class="hero-actions">' +
      (idle
        ? '<a href="#search" class="button primary">' + icon("plus") + "Find your first track</a>"
        : button(isPaused ? "Resume" : "Pause", isPaused ? "play" : "pause", "toggle-play")) +
      (t
        ? ib("next", "Skip track", "skip", !b.track ? "disabled" : "") +
          ib("library", "Save to playlist", "save-current")
        : "") +
      '</div></div><div class="hero-indicator ' +
      (idle || isPaused ? "paused" : "") +
      '" aria-hidden="true"><i></i><i></i><i></i><i></i></div></section>'
    );
  }

  function queueSection(b, full = false) {
    const { pages, PAGE_SIZE, pageControls } = getContext();
    const offset = full
      ? Math.min(pages.get("queue") || 0, Math.max(0, Math.ceil(b.queue.length / PAGE_SIZE) - 1)) *
        PAGE_SIZE
      : 0;
    const tracks = full ? b.queue.slice(offset, offset + PAGE_SIZE) : b.queue.slice(0, 5);
    let wait = b.track ? (b.track.duration ? Math.max(0, b.track.duration - b.elapsed) : null) : 0;
    const estimates = b.queue.map((t) => {
      const estimate = wait;
      wait = wait === null || !t.duration ? null : wait + t.duration;
      return estimate;
    });
    return (
      '<section><div class="section-heading"><h2>Up next <span class="count-badge">' +
      b.queue.length +
      "</span></h2>" +
      (full
        ? '<div class="heading-actions">' +
          button(
            "Save queue",
            "library",
            "save-queue",
            b.queue.length || b.track ? "" : "disabled",
            "secondary",
          ) +
          button(
            "Clear queue",
            "trash",
            "clear-queue",
            b.queue.length ? "" : "disabled",
            "secondary",
          ) +
          "</div>"
        : '<a href="#queue" class="text-button">View queue ' + icon("arrow") + "</a>") +
      '</div><div class="queue-tabs"><span class="queue-tab active"><span class="status-dot on"></span>Queued by users · ' +
      b.queue.length +
      '</span><span class="queue-tab">' +
      icon("repeat") +
      "Idle autoplay " +
      (b.track?.auto || (!b.track && b.radio) ? "· Active" : "· Standby") +
      "</span></div>" +
      trackTable(tracks, "queue", { queue: true, offset, estimates }) +
      (full ? pageControls("queue", b.queue.length) : "") +
      '<div class="queue-footer">' +
      icon("repeat") +
      "<span>" +
      e(
        b.radio
          ? "Radio plays when the queue is empty."
          : b.defaultPlaylist.size
            ? (b.defaultPlaylist.name || "Default playlist") +
              " takes over when the queue is empty."
            : "Keep the music going with a default idle playlist.",
      ) +
      '</span><a href="#library">Manage playlists ' +
      icon("arrow") +
      "</a></div>" +
      (full && b.track?.auto
        ? '<div class="notice">Auto-playing from <strong>' +
          e(b.defaultPlaylist.name || "Default playlist") +
          "</strong>. User requests play immediately and take priority.</div>"
        : "") +
      (full
        ? '<p class="small subtle">Drag a row to reorder, or select its number to choose a position. “Play next” and “Move to top” place a track directly after the current song.</p>'
        : "") +
      "</section>"
    );
  }

  function playlistsSection(b) {
    const { state } = getContext();
    return (
      '<section><div class="section-heading"><h2>Made for your moments</h2><a href="#library" class="text-button">Your library ' +
      icon("arrow") +
      '</a></div><div class="library-cards">' +
      state.playlists
        .slice(0, 3)
        .map((p, i) => playlistCard(p, i, state.defaults[b.name] === p.id))
        .join("") +
      (state.playlists.length < 3
        ? '<button class="playlist-card new-playlist-card" data-action="new-playlist">' +
          icon("plus") +
          "<span>Create a playlist</span></button>"
        : "") +
      "</div></section>"
    );
  }

  function dashboard(b) {
    const { state } = getContext();
    return (
      heading(
        "Let the good tracks roll.",
        "A little music. A better channel. You’re in control.",
        '<a href="#search" class="button secondary">' +
          icon("download") +
          'Import music</a><a href="#search" class="button primary">' +
          icon("plus") +
          "Add to queue</a>",
        "YOUR CHANNEL’S SOUNDTRACK",
      ) +
      '<div class="overview-layout"><div class="content-stack">' +
      hero(b) +
      queueSection(b) +
      playlistsSection(b) +
      '</div><aside class="overview-aside">' +
      botCard(b) +
      commands(state.commandPrefix, b.platform) +
      '<p class="aside-note">' +
      icon("shield") +
      "<span>Built for your community.<br>Music streams directly to " +
      platformName(b) +
      ".</span></p></aside></div>"
    );
  }

  return { hero, queueSection, playlistsSection, dashboard };
}
