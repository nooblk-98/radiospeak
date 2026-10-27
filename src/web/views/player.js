/** Player view markup. The controller supplies live state on each render. */
import {
  art,
  duration,
  escape as e,
  iconButton as ib,
  icon,
  source,
  time,
} from "../ui/components.js";
import { platformIcon, platformName } from "../ui/platforms.js";

export function createPlayerViews(getContext) {
  function dock(b) {
    const { state, currentTrack, paused } = getContext();
    const t = currentTrack(),
      isPaused = paused(b),
      liked = state.favorites.some((f) => f.url === t?.url),
      canStart = t || b.queue.length || b.defaultPlaylist.size;
    return (
      '<div class="dock-track">' +
      art(t, "dock-art") +
      '<div class="dock-info"><div class="dock-title" title="' +
      e(t?.title || "Nothing playing yet") +
      '"><span>' +
      e(t?.title || "Nothing playing yet") +
      '</span></div><div class="dock-artist">' +
      e(t?.artist || (t ? source(t) : "Your next track is waiting")) +
      "</div></div>" +
      ib(
        "heart",
        liked ? "Remove from favorites" : "Favorite current track",
        "favorite-current",
        'aria-pressed="' + liked + '" ' + (!t ? "disabled" : ""),
        "dock-heart " + (liked ? "active" : ""),
      ) +
      ib(
        "trash",
        b.currentPlaylist
          ? "Delete this song from " + b.currentPlaylist.name
          : b.track
            ? "Only songs from a saved playlist can be deleted"
            : "Nothing to delete",
        "delete-current",
        !b.currentPlaylist ? "disabled" : "",
        "dock-delete danger",
      ) +
      '</div><div class="dock-center"><div class="transport">' +
      ib(
        "shuffle",
        "Shuffle queue",
        "shuffle",
        'aria-pressed="' + b.shuffle + '"',
        "shuffle-button " + (b.shuffle ? "active" : ""),
      ) +
      ib("previous", "Previous track", "previous", b.canGoBack ? "" : "disabled") +
      '<button class="dock-play" data-action="toggle-play" aria-label="' +
      (t && !isPaused ? "Pause" : "Play") +
      '" ' +
      (!canStart ? "disabled" : "") +
      ">" +
      icon(t && !isPaused ? "pause" : "play") +
      "</button>" +
      ib(
        "stop",
        "Stop playback and clear queue",
        "stop",
        !t && !b.queue.length ? "disabled" : "",
        "stop-button",
      ) +
      ib("next", "Next track", "skip", !b.track ? "disabled" : "") +
      '<button class="icon-button repeat-button ' +
      (b.loop !== "off" ? "active" : "") +
      '" data-action="repeat" aria-label="Repeat: ' +
      b.loop +
      '" title="Repeat: ' +
      b.loop +
      '" aria-pressed="' +
      (b.loop !== "off") +
      '">' +
      icon("repeat") +
      (b.loop === "one" ? '<span class="repeat-one">1</span>' : "") +
      "</button></div>" +
      '<div class="timeline"><span id="elapsed">' +
      time(b.elapsed) +
      '</span><input id="seek" type="range" min="0" max="' +
      (b.track?.duration || 1) +
      '" value="' +
      b.elapsed +
      '" aria-label="Playback position" ' +
      (!b.track?.duration ? "disabled" : "") +
      "><span>" +
      (t ? duration(b.track?.duration) : "0:00") +
      "</span></div></div>" +
      '<div class="dock-right"><div class="volume-controls">' +
      ib(
        b.volume ? "volume" : "mute",
        b.volume ? "Mute bot" : "Unmute bot",
        "mute",
        'aria-pressed="' + (b.volume === 0) + '"',
      ) +
      '<input type="range" id="volume" min="0" max="100" value="' +
      b.volume +
      '" aria-label="Bot volume gain" aria-valuetext="' +
      b.volume +
      '%" title="Bot volume: ' +
      b.volume +
      '%" style="--fill:' +
      b.volume +
      '%"><span class="volume-number" id="volume-number">' +
      b.volume +
      '</span></div><div class="output-info"><div class="output-label">' +
      platformIcon(b) +
      platformName(b) +
      '</div><div class="small">' +
      e(
        b.radio
          ? "Radio fallback · " + (!b.track ? "Active" : "Ready")
          : b.defaultPlaylist.size
            ? "Idle playlist · " + (b.track?.auto ? "Active" : "Ready")
            : b.channel || "Not connected",
      ) +
      "</div></div></div>"
    );
  }

  return { dock };
}
