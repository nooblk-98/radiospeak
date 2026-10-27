/** Shared, stateless panel components. State and events belong to the controller. */
import { duration, escape, time } from "./format.js";
import { button, icon, iconButton } from "./icons.js";
import { art, source } from "./media.js";
export { duration, escape, time } from "./format.js";
export { button, icon, iconButton } from "./icons.js";
export { art, imageUrl, source } from "./media.js";
export const empty = (title, text, action = "") =>
  '<div class="empty">' +
  icon("music") +
  "<h3>" +
  escape(title) +
  "</h3><p>" +
  escape(text) +
  "</p>" +
  action +
  "</div>";
export function heading(title, subtitle, actions = "", eyebrow = "") {
  return (
    '<div class="page-heading"><div>' +
    (eyebrow ? '<div class="intro-eyebrow">' + escape(eyebrow) + "</div>" : "") +
    "<h1>" +
    escape(title) +
    "</h1><p>" +
    escape(subtitle) +
    '</p></div><div class="heading-actions">' +
    actions +
    "</div></div>"
  );
}
export function channelSelect(
  bot,
  label = (bot.platform === "discord" ? "Discord" : "TeamSpeak") + " channel",
) {
  const options = bot.channels?.length
    ? bot.channels
        .map(
          (c) =>
            '<option value="' +
            escape(c.id) +
            '" ' +
            (c.id === bot.channelId ? "selected" : "") +
            ">" +
            escape(c.name) +
            "</option>",
        )
        .join("")
    : "<option>Not connected</option>";
  return (
    '<select class="channel-select" data-control="channel" aria-label="' +
    escape(label) +
    '" ' +
    (!bot.connected ? "disabled" : "") +
    ">" +
    options +
    "</select>"
  );
}
export function botCard(bot) {
  const discord = bot.platform === "discord",
    platform = discord ? "Discord" : "TeamSpeak";
  const logo =
    '<img class="platform-logo" src="/' +
    (discord ? "discord" : "teamspeak") +
    '.svg" width="22" height="22" alt="" aria-hidden="true">';
  return (
    '<section class="card card-padding"><div class="card-title"><h2>' +
    platform +
    ' bot</h2><span class="tag ' +
    (bot.connected ? "green" : "") +
    '"><span class="status-dot ' +
    (bot.connected ? "on" : "") +
    '"></span>' +
    (bot.connected ? "Connected" : "Offline") +
    '</span></div><div class="bot-info"><div class="bot-avatar">' +
    logo +
    "</div><div><strong>" +
    escape(bot.nickname || bot.name) +
    '</strong><div class="subtle small">' +
    escape(bot.serverName || platform) +
    '</div></div></div><label class="field-label">CURRENT CHANNEL</label>' +
    channelSelect(bot) +
    '<p class="small subtle channel-home">' +
    (bot.homeChannel
      ? "Rejoins " +
        escape(discord ? bot.channel || bot.homeChannel : bot.homeChannel) +
        " after reconnecting."
      : "Choose a channel; the bot rejoins it after reconnecting.") +
    "</p>" +
    (bot.connectionError
      ? '<p class="small form-error" role="status">' + escape(bot.connectionError) + "</p>"
      : "") +
    '<div class="listeners-row"><span>' +
    icon("users") +
    "<strong>" +
    bot.listeners.length +
    '</strong> listening</span><div class="avatars">' +
    bot.listeners
      .slice(0, 5)
      .map(
        (n) =>
          '<span class="avatar" title="' +
          escape(n) +
          '">' +
          escape(n.slice(0, 1).toUpperCase()) +
          "</span>",
      )
      .join("") +
    '</div></div><div class="setting-line"><div>Audio normalization<p>Keep every track at a consistent level</p></div><button class="switch" data-action="normalization" role="switch" aria-checked="' +
    bot.normalization +
    '" aria-label="Audio normalization"></button></div>' +
    (discord
      ? '<p class="small subtle">Use <code>/radiospeak play</code>, <code>/radiospeak queue</code> or <code>/radiospeak skip</code> in Discord.</p>'
      : '<div class="setting-line"><div>Welcome new listeners<p>Post the main commands in channel chat when someone joins</p></div><button class="switch" data-action="welcome" role="switch" aria-checked="' +
        bot.welcomes +
        '" aria-label="Welcome new listeners"></button></div>') +
    '<div class="setting-line"><div>Idle fallback<p>' +
    escape(
      bot.radio
        ? "Radio / " + bot.radio.name
        : bot.defaultPlaylist.size
          ? bot.defaultPlaylist.name || "Configured playlist"
          : "No default playlist selected",
    ) +
    '</p></div><span class="tag ' +
    (bot.radio || bot.defaultPlaylist.size ? "green" : "") +
    '">' +
    (bot.radio || bot.defaultPlaylist.size ? "Ready" : "Off") +
    "</span></div></section>"
  );
}
export function commands(prefix, platform = "teamspeak") {
  const discord = platform === "discord",
    items = discord
      ? [
          ["play query", "Queue a track"],
          ["skip", "Skip / vote to skip"],
          ["volume level", "Set the volume"],
          ["queue", "See what is next"],
        ]
      : [
          ["play <song>", "Queue a track"],
          ["skip", "Skip this track"],
          ["vol <0-100>", "Set the volume"],
          ["queue", "See what is next"],
        ];
  return (
    '<section class="card command-card"><h3>' +
    icon("terminal") +
    (discord ? "Discord commands" : "From the chat") +
    "</h3>" +
    items
      .map(
        ([cmd, title]) =>
          '<div class="command-row"><code>' +
          escape((discord ? "/radiospeak " : prefix) + cmd) +
          "</code><span>" +
          title +
          "</span></div>",
      )
      .join("") +
    "</section>"
  );
}
export function playlistCard(list, index, isDefault) {
  return (
    '<button class="playlist-card" data-action="open-playlist" data-id="' +
    escape(list.id) +
    '">' +
    art(list.coverTrack || list.tracks[0], "playlist-cover", index) +
    (isDefault ? '<span class="tag green">' + icon("repeat") + "Idle playlist</span>" : "") +
    "<h3>" +
    escape(list.name) +
    "</h3><p>" +
    (list.trackCount ?? list.tracks.length) +
    " tracks · " +
    time(list.totalDuration ?? list.tracks.reduce((n, t) => n + (t.duration || 0), 0)) +
    "</p></button>"
  );
}
export function trackTable(
  tracks,
  scope,
  {
    editable = true,
    queue = false,
    offset = 0,
    estimates = [],
    positions,
    selectable = false,
    selected = [],
  } = {},
) {
  if (!tracks.length)
    return empty(
      queue ? "The floor is yours" : "A little quiet in here",
      queue
        ? "Find a track and give your channel something to listen to."
        : "Search for music or import a public playlist to get started.",
      '<a href="#search" class="button secondary">' + icon("search") + "Find some music</a>",
    );
  return (
    '<div class="table-scroll"><table class="track-table" aria-label="' +
    (queue ? "Up next" : "Playlist tracks") +
    '"><thead><tr><th class="number-col">#</th><th>TRACK</th><th class="source-col">' +
    (queue ? "REQUESTED BY" : "SOURCE") +
    '</th><th class="time-col">' +
    icon("clock") +
    '</th><th class="actions-col">ACTIONS</th></tr></thead><tbody>' +
    tracks
      .map((t, i) => {
        const index = positions?.[i] ?? i + offset;
        const eta = queue
          ? estimates[index] === null
            ? " - time unavailable"
            : estimates[index] !== undefined
              ? " - in ~" + time(estimates[index])
              : ""
          : "";
        const attrs = 'data-scope="' + escape(scope) + '" data-index="' + index + '"';
        return (
          "<tr " +
          attrs +
          (editable ? ' draggable="true"' : "") +
          '><td class="number-col">' +
          (selectable
            ? '<input type="checkbox" data-control="select-track" ' +
              attrs +
              ' aria-label="Select ' +
              escape(t.title) +
              '" ' +
              (selected.includes(index) ? "checked" : "") +
              ">"
            : "") +
          '<span class="track-number">' +
          (editable
            ? '<button class="drag-handle" data-action="reorder" ' +
              attrs +
              ' aria-label="Reorder ' +
              escape(t.title) +
              '" title="Drag to reorder, or click to choose a position">' +
              (index + 1) +
              "</button>"
            : index + 1) +
          '</span></td><td><div class="track-cell">' +
          art(t, "track-art", i) +
          '<div class="track-detail"><span class="track-title" title="' +
          escape(t.title) +
          '">' +
          escape(t.title) +
          '</span><span class="track-artist">' +
          escape(t.artist || source(t)) +
          '<span class="track-eta"' +
          (queue ? ' data-eta-index="' + index + '"' : "") +
          ">" +
          escape(eta) +
          '</span></span></div></div></td><td class="source-col"><span class="track-source">' +
          escape(queue ? (t.auto ? "Idle playlist" : t.requestedBy || "web") : source(t)) +
          '</span></td><td class="time-col"><span class="track-time">' +
          duration(t.duration) +
          '</span></td><td class="actions-col"><div class="row-actions">' +
          (queue
            ? iconButton("next", "Play next", "queue-next", attrs) +
              iconButton("top", "Move to top", "queue-top", attrs)
            : iconButton("plus", "Add to queue", "enqueue-track", attrs)) +
          iconButton("play", "Play now", "play-track", attrs) +
          (editable
            ? iconButton(
                "close",
                queue ? "Remove from queue" : "Delete track",
                "remove-track",
                attrs,
                "danger",
              )
            : iconButton("heart", "Remove favorite", "favorite-track", attrs)) +
          "</div></td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>"
  );
}
export function playlistResultCard(p, i) {
  const attrs = 'data-scope="search" data-index="' + i + '"';
  return (
    '<article class="card result-card playlist-result">' +
    art(
      p,
      "result-cover",
      i,
      '<span class="result-duration">' + icon("library") + "Playlist</span>",
    ) +
    '<div class="result-body"><h3 title="' +
    escape(p.title) +
    '">' +
    escape(p.title) +
    "</h3><p>" +
    escape(p.artist || "YouTube playlist") +
    '</p><div class="result-actions">' +
    button("Queue all", "plus", "search-playlist-queue", attrs) +
    button("Import", "download", "search-playlist-import", attrs, "secondary") +
    "</div></div></article>"
  );
}
export function resultCard(t, i) {
  const attrs = 'data-scope="search" data-index="' + i + '"';
  return (
    '<article class="card result-card">' +
    art(t, "result-cover", i, '<span class="result-duration">' + duration(t.duration) + "</span>") +
    '<div class="result-body"><h3 title="' +
    escape(t.title) +
    '">' +
    escape(t.title) +
    "</h3><p>" +
    escape(t.artist || source(t)) +
    '</p><div class="result-actions">' +
    button("Play now", "play", "play-track", attrs) +
    button("Enqueue", "plus", "enqueue-track", attrs, "secondary") +
    iconButton("library", "Save to playlist", "save-track", attrs) +
    "</div></div></article>"
  );
}
