/** Panel controller: owns live state, navigation, rendering coordination and delegated events. */
import { EnqueueControl } from "./features/enqueue.js";
import { PlayControl } from "./features/play.js";
import { playbackStatus } from "./ui/playback.js";
import { NotificationCenter } from "./features/notifications.js";
import { VolumeControl } from "./features/volume.js";
import { SeekControl } from "./features/seek.js";
import { request, StateConnection } from "./state/connection.js";
import {
  button,
  channelSelect,
  duration,
  escape as e,
  heading,
  iconButton as ib,
  icon,
  time,
} from "./ui/components.js";
import { discordFields, platformBadge, platformIcon, platformName } from "./ui/platforms.js";
import { createDashboardViews } from "./views/dashboard.js";
import { createLibraryViews } from "./views/library.js";
import { managementMarkup } from "./views/management.js";
import { createPlayerViews } from "./views/player.js";
import { createRadioViews } from "./views/radio.js";
import { createSearchViews } from "./views/search.js";
import { createSettingsViews } from "./views/settings.js";

import {
  accessMarkup,
  historyMarkup,
  operationsMarkup,
  scheduleData,
  scheduleFields,
} from "./views/operations.js";
const $ = (selector) => document.querySelector(selector);
const connection = new StateConnection();
const notifications = new NotificationCenter();
let state,
  botName = localStorage.getItem("radiospeak.bot") || "",
  activeView = "",
  libraryFilter = "all",
  playlistId = null;
let panelNeedsReload = false;
let accessData = null,
  accessPending = false;
let auditData = null,
  managementPending = false;
async function loadManagement(offset = 0) {
  if (managementPending || state?.viewer?.role !== "admin") return;
  managementPending = true;
  try {
    const audit = await request("/api/audit?offset=" + offset);
    auditData = { ...audit, offset };
    renderedView = "";
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    managementPending = false;
  }
}
const playlistFilters = new Map(),
  playlistSelections = new Map();
const filterFor = (id) => playlistFilters.get(id) || { q: "", duplicates: false };
function selectionFor(list) {
  let selection = playlistSelections.get(list.id);
  if (!selection || selection.version !== list.version) {
    selection = { version: list.version, indices: [], excluded: [], allMatching: false };
    playlistSelections.set(list.id, selection);
  }
  return selection;
}
const historyCache = new Map();
function ensureAccess() {
  if (accessData || accessPending || state?.viewer?.role !== "admin") return;
  accessPending = true;
  void request("/api/access")
    .then((data) => {
      accessData = data;
      renderedView = "";
      render();
    })
    .catch((error) => toast(error.message, true))
    .finally(() => {
      accessPending = false;
    });
}
function historyView(b) {
  let cached = historyCache.get(b.name);
  if (!cached || cached.version !== b.historyVersion) {
    if (!cached?.pending) {
      cached = { ...cached, pending: true };
      historyCache.set(b.name, cached);
      void request("/api/bots/" + encodeURIComponent(b.name) + "/history")
        .then((data) => {
          historyCache.set(b.name, {
            entries: data.entries,
            version: b.historyVersion,
            pending: false,
          });
          renderedView = "";
          if (activeView === "history") render();
        })
        .catch((error) => {
          historyCache.delete(b.name);
          toast(error.message, true);
        });
    }
  }
  return historyMarkup(b, cached?.entries);
}
function enforcePermissions() {
  const role = state?.viewer?.role || "admin",
    rank = { listener: 0, dj: 1, admin: 2 };
  document.querySelectorAll("[data-min-role]").forEach((el) => {
    el.hidden = rank[role] < rank[el.dataset.minRole];
  });
  if (role === "admin") return;
  const adminActions = new Set([
    "edit-connection",
    "new-instance",
    "remove-instance",
    "delete-instance",
    "delete-account",
  ]);
  const listenerActions = new Set([
    "menu",
    "close-menu",
    "close-modal",
    "reload-panel",
    "logout",
    "sign-out",
    "collection",
    "filter",
    "favorites",
    "library-back",
    "open-playlist",
    "page",
    "search-source",
    "search-type",
    "search-more",
    "search-playlist-queue",
    "enqueue-track",
    "queue-playlist",
    "history-enqueue",
    "skip",
    "undo",
    "switch-bot",
    "toggle-switcher",
    "switcher",
    "notifications-read",
  ]);
  document.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    let allowed = role === "dj" ? !adminActions.has(action) : listenerActions.has(action);
    if (role === "listener" && action === "remove-track" && el.dataset.scope === "queue")
      allowed = bot()?.queue[Number(el.dataset.index)]?.requesterId === state.viewer.id;
    if (!allowed) el.disabled = true;
    if (role === "listener" && action === "skip") {
      el.setAttribute("aria-label", "Vote to skip");
      el.title = "Vote to skip";
    }
  });
  if (role === "listener")
    document
      .querySelectorAll(
        "#view form:not(#search-form):not(#playlist-filter) input,#view form:not(#search-form):not(#playlist-filter) select,#view form:not(#search-form):not(#playlist-filter) textarea,#view form:not(#search-form):not(#playlist-filter) button,#volume,#seek,#modal-submit",
      )
      .forEach((el) => {
        el.disabled = true;
      });
}
let query = "",
  searchSource = "youtube",
  searchResults = [],
  searchStatus = "idle",
  searchError = "",
  searchController,
  searchTimer;
// Songs or playlists, fetched SEARCH_PAGE results at a time, up to SEARCH_PAGES pages.
let searchType = "tracks",
  searchPage = 1,
  searchHasMore = false,
  searchMoreLoading = false;
const SEARCH_PAGE = 10,
  SEARCH_PAGES = 5;
let dragging = null,
  sliderActive = false,
  seekGesture = null,
  modalSubmit,
  renderedView = "",
  renderedDock = "",
  renderedChrome = "";
let receivedAt = 0,
  lastRenderBot = "";
let lastEtaKey = "";
const lastVolumes = new Map();
const requestedVolumes = new Map();
const volumeControl = new VolumeControl({
  send: async (name, volume) => {
    const result = await request("/api/bots/" + encodeURIComponent(name) + "/volume", { volume });
    connection.applyPlayback(result.playback);
  },
  onValue: (name, value) => {
    requestedVolumes.set(name, value);
    if (value > 0) lastVolumes.set(name, value);
    paintVolume(name, value);
  },
  onSettled: (name, value) => {
    if (state?.bots.find((b) => b.name === name)?.volume === value) requestedVolumes.delete(name);
    render();
  },
  onError: (name, error) => {
    requestedVolumes.delete(name);
    toast("Could not change volume: " + error.message, true);
    if (bot()?.name === name) paintVolume(name, bot().volume);
    void connection.refresh(true).then(() => render());
  },
});
const seekControl = new SeekControl({
  send: async (name, url, seconds) => {
    const result = await request("/api/bots/" + encodeURIComponent(name) + "/seek", {
      seconds,
      url,
    });
    connection.applyPlayback(result.playback);
  },
  onValue: () => updateProgress(),
  onSettled: () => {
    updateProgress();
    renderBackground();
  },
  onError: (_name, error) => {
    toast(error.message, true);
    void connection.refresh(true).then(() => updateProgress());
  },
});
function paintVolume(name, value) {
  if (bot()?.name !== name) return;
  const slider = $("#volume");
  if (slider) {
    slider.value = value;
    slider.style.setProperty("--fill", value + "%");
    slider.setAttribute("aria-valuetext", value + "%");
    slider.title = "Bot volume: " + value + "%";
  }
  if ($("#volume-number")) $("#volume-number").textContent = value;
  const mute = $('#player-dock [data-action="mute"]');
  if (mute) {
    mute.innerHTML = icon(value ? "volume" : "mute");
    mute.setAttribute("aria-pressed", String(value === 0));
    mute.setAttribute("aria-label", value ? "Mute bot" : "Unmute bot");
    mute.title = value ? "Mute bot" : "Unmute bot";
  }
}
let viewTracks = new Map();
const playlistCache = new Map(),
  playlistRequests = new Map(),
  pages = new Map(),
  viewVersions = new Map();
const PAGE_SIZE = 50;
const playlistErrors = new Map();
const views = {
  dashboard: "Now playing",
  queue: "Up next",
  library: "Collections & playlists",
  search: "Search & import",
  radio: "Radio stations",
  history: "Playback history",
  settings: "Bots & platforms",
};
const bot = () => state?.bots.find((b) => b.name === botName) || state?.bots[0];
const trackCount = (p) => p?.trackCount ?? p?.total ?? p?.tracks?.length ?? 0;
const playlist = () =>
  playlistCache.get(playlistId) || state?.playlists.find((p) => p.id === playlistId);
const listPath = (id) => "/api/playlists/" + encodeURIComponent(id);
const currentTrack = () =>
  bot()?.track ||
  (bot()?.radio
    ? { url: bot().radio.url, title: bot().radioTitle || bot().radio.name, artist: "Live radio" }
    : null);
const paused = (b) => b.userPaused || b.autoPaused || b.connectionPaused;

// View factories resolve current state for every render, including SSE updates.
const { hero, queueSection, dashboard } = createDashboardViews(() => ({
  state,
  currentTrack,
  paused,
  pages,
  PAGE_SIZE,
  pageControls,
}));
const { library } = createLibraryViews(() => ({
  state,
  playlist,
  playlistErrors,
  pages,
  trackCount,
  PAGE_SIZE,
  filterFor,
  playlistCache,
  ensurePlaylist,
  selectionFor,
  pageControls,
  libraryFilter,
}));
const { searchView, searchResultsMarkup } = createSearchViews(() => ({
  query,
  searchSource,
  searchType,
  searchStatus,
  searchError,
  searchResults,
  searchHasMore,
  searchMoreLoading,
}));
const { radioView } = createRadioViews(() => ({ state, paused }));
const { settings } = createSettingsViews(() => ({
  ensureAccess,
  auditData,
  loadManagement,
  instancesCard,
  state,
  trackCount,
}));
const { dock } = createPlayerViews(() => ({ state, currentTrack, paused }));

const enqueueControl = new EnqueueControl({
  send: (name, track) =>
    mutate("/api/bots/" + encodeURIComponent(name) + "/enqueue", { tracks: [track], unique: true }),
  onChange: paintEnqueueButtons,
});
const playControl = new PlayControl({
  send: (name, track) =>
    mutate("/api/bots/" + encodeURIComponent(name) + "/play-now", {
      tracks: [track],
      unique: true,
    }),
  onChange: paintPlayButtons,
});
function paintPlayButtons() {
  const b = bot();
  if (!b) return;
  document.querySelectorAll('[data-action="play-track"]').forEach((el) => {
    const track = tracksFor(el.dataset.scope)[Number(el.dataset.index)];
    if (!track) return;
    const phase = playControl.state(b, track),
      busy = phase !== "idle";
    const label =
      phase === "requesting" ? "Starting…" : phase === "preparing" ? "Preparing…" : "Play now";
    if (el.dataset.playState !== phase) {
      el.dataset.playState = phase;
      el.innerHTML =
        icon(busy && phase !== "busy" ? "clock" : "play") +
        (el.classList.contains("icon-button") ? "" : label);
    }
    el.disabled = busy || state?.viewer?.role === "listener";
    el.setAttribute("aria-busy", String(phase === "requesting" || phase === "preparing"));
    el.setAttribute("aria-label", label + ": " + track.title);
    el.title =
      phase === "preparing" ? "Preparing this song; clicking again would restart it" : label;
  });
}
function enqueueTrackFor(el, b) {
  return el.dataset.action === "history-enqueue"
    ? historyCache.get(b.name)?.entries.find((item) => item.id === el.dataset.id)?.track
    : tracksFor(el.dataset.scope)[Number(el.dataset.index)];
}
function paintEnqueueButtons() {
  const b = bot();
  if (!b) return;
  const controls = document.querySelectorAll(
    '[data-action="enqueue-track"],[data-action="history-enqueue"]',
  );
  if (!controls.length) return;
  const phaseFor = enqueueControl.statesFor(b);
  controls.forEach((el) => {
    const track = enqueueTrackFor(el, b);
    if (!track) return;
    const phase = phaseFor(track),
      label = {
        idle: "Enqueue",
        adding: "Adding…",
        queued: "Queued",
        preparing: "Preparing…",
        playing: "Playing",
      }[phase];
    if (el.dataset.enqueueState !== phase) {
      el.dataset.enqueueState = phase;
      el.innerHTML =
        icon(
          {
            idle: "plus",
            adding: "clock",
            queued: "check",
            preparing: "clock",
            playing: "headphones",
          }[phase],
        ) + (el.classList.contains("icon-button") ? "" : label);
    }
    el.disabled = phase !== "idle";
    el.classList.toggle("enqueue-confirmed", phase === "queued" || phase === "playing");
    el.setAttribute("aria-busy", String(phase === "adding" || phase === "preparing"));
    el.setAttribute("aria-label", label + ": " + track.title);
    el.title =
      phase === "idle"
        ? "Add to queue"
        : phase === "adding"
          ? "Adding to queue…"
          : phase === "preparing"
            ? "Preparing this song for playback"
            : phase === "playing"
              ? "This track is already playing"
              : "This track is already in Up next";
  });
}
function toast(message, error = false, undoToken, undoBot) {
  notifications.add(message, error, undoToken, undoBot || bot()?.name);
}
async function mutate(path, body = {}, method = "POST") {
  if (panelNeedsReload) throw new Error("Reload the panel to use the updated controls.");
  try {
    const result = await request(path, body, method);
    await connection.refresh(true);
    render();
    if (result.message)
      toast(
        result.message,
        false,
        result.undoToken,
        path.startsWith("/api/bots/") ? decodeURIComponent(path.split("/")[3]) : undefined,
      );
    return result;
  } catch (error) {
    await connection.refresh(true);
    render();
    throw error;
  }
}
function action(name, body = {}) {
  if (!bot()) throw new Error("No music bot is available");
  return mutate("/api/bots/" + encodeURIComponent(bot().name) + "/" + name, body);
}
function tracksFor(scope) {
  if (scope === "queue") return viewTracks.get(scope) || bot()?.queue || [];
  if (scope === "search") return searchResults;
  if (scope === "favorites") return state?.favorites || [];
  return viewTracks.get(scope) || state?.playlists.find((p) => p.id === scope)?.tracks || [];
}
function orderData(scope) {
  return scope === "queue"
    ? { expected: tracksFor(scope).map((t) => t.url) }
    : { expectedVersion: viewVersions.get(scope) };
}
async function ensurePlaylist(id) {
  const meta = state.playlists.find((p) => p.id === id);
  if (!meta) return;
  const filter = filterFor(id);
  const page = Math.min(
    pages.get(id) || 0,
    Math.max(0, Math.ceil((playlistCache.get(id)?.total ?? trackCount(meta)) / PAGE_SIZE) - 1),
  );
  pages.set(id, page);
  const current = playlistCache.get(id);
  if (
    current?.version === meta.version &&
    current.offset === page * PAGE_SIZE &&
    current.filter === JSON.stringify(filter)
  )
    return;
  const key = id + ":" + page + ":" + meta.version + ":" + JSON.stringify(filter);
  if (playlistRequests.has(key)) return playlistRequests.get(key);
  const promise = request(
    listPath(id) +
      "?offset=" +
      page * PAGE_SIZE +
      "&limit=" +
      PAGE_SIZE +
      "&q=" +
      encodeURIComponent(filter.q) +
      "&duplicates=" +
      filter.duplicates,
    undefined,
    "GET",
    AbortSignal.timeout(10000),
  )
    .then((detail) => {
      if (
        state.playlists.find((p) => p.id === id)?.version !== detail.version ||
        (pages.get(id) || 0) !== page ||
        JSON.stringify(filterFor(id)) !== JSON.stringify(filter)
      )
        return;
      detail.filter = JSON.stringify(filter);
      playlistErrors.delete(id);
      playlistCache.set(id, detail);
      renderedView = "";
      render();
    })
    .catch((error) => {
      playlistErrors.set(id, error.message);
      renderedView = "";
      render();
    })
    .finally(() => playlistRequests.delete(key));
  playlistRequests.set(key, promise);
  return promise;
}
function pageControls(scope, total) {
  if (total <= PAGE_SIZE) return "";
  const max = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1),
    page = Math.min(pages.get(scope) || 0, max);
  pages.set(scope, page);
  return (
    '<div class="pagination" aria-label="Track pages"><button class="button secondary" data-action="page" data-scope="' +
    e(scope) +
    '" data-page="' +
    (page - 1) +
    '" ' +
    (!page ? "disabled" : "") +
    ">Previous</button><span>" +
    (page * PAGE_SIZE + 1) +
    "–" +
    Math.min(total, (page + 1) * PAGE_SIZE) +
    " of " +
    total +
    '</span><button class="button secondary" data-action="page" data-scope="' +
    e(scope) +
    '" data-page="' +
    (page + 1) +
    '" ' +
    (page === max ? "disabled" : "") +
    ">Next</button></div>"
  );
}
function showModal(title, body, submit, label = "Save", danger = false) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-error").textContent = "";
  $("#modal-submit").textContent = label;
  $("#modal-submit").className = "button " + (danger ? "danger-button" : "primary");
  $("#modal-submit").disabled = false;
  modalSubmit = submit;
  $("#modal").showModal();
  requestAnimationFrame(() => $("#modal-body input, #modal-body select")?.focus());
}
function clearModalSecrets() {
  $("#modal-body")
    .querySelectorAll('input[type="password"]')
    .forEach((input) => {
      input.value = "";
    });
}
$("#modal").addEventListener("close", clearModalSecrets);
function confirmAction(title, text, submit, label = "Delete") {
  showModal(title, "<p>" + e(text) + "</p>", submit, label, true);
}
function collectionOptions(value = null) {
  return (
    '<option value="">Standalone playlist</option>' +
    state.collections
      .map(
        (c) =>
          '<option value="' +
          e(c.id) +
          '" ' +
          (value === c.id ? "selected" : "") +
          ">" +
          e(c.name) +
          "</option>",
      )
      .join("")
  );
}
function playlistEditor(list) {
  showModal(
    list ? "Edit playlist" : "Create a playlist",
    '<label class="field-label" for="list-name">Playlist name</label><input id="list-name" name="name" class="field" required maxlength="80" placeholder="e.g. Late night sessions" value="' +
      e(list?.name) +
      '"><label class="field-label" for="list-collection">Collection</label><select name="collectionId" id="list-collection">' +
      collectionOptions(
        list?.collectionId ??
          (state.collections.some((c) => c.id === libraryFilter) ? libraryFilter : null),
      ) +
      "</select>",
    async (data) => {
      const result = await mutate(
        list ? listPath(list.id) : "/api/playlists",
        { name: data.get("name"), collectionId: data.get("collectionId") || null },
        list ? "PATCH" : "POST",
      );
      if (!list) {
        playlistId = result.playlist.id;
        location.hash = "library";
        render(true);
      }
    },
    list ? "Save changes" : "Create playlist",
  );
}
function collectionEditor(collection) {
  showModal(
    collection ? "Rename collection" : "Create a collection",
    '<p>Group your playlists by mood, genre, or occasion.</p><label class="field-label" for="collection-name">Collection name</label><input class="field" id="collection-name" name="name" required maxlength="80" placeholder="e.g. Gaming BGM" value="' +
      e(collection?.name) +
      '">',
    (data) =>
      mutate(
        "/api/collections" + (collection ? "/" + encodeURIComponent(collection.id) : ""),
        { name: data.get("name") },
        collection ? "PATCH" : "POST",
      ),
    collection ? "Rename" : "Create collection",
  );
}
function saveTrack(track) {
  if (!track) throw new Error("No track selected");
  showModal(
    "Save to a playlist",
    "<p>" +
      e(track.title) +
      "</p>" +
      (state.playlists.length
        ? '<label class="field-label" for="save-playlist">Choose playlist</label><select name="playlist" id="save-playlist"><option value="">Create a new playlist…</option>' +
          state.playlists
            .map((p) => '<option value="' + e(p.id) + '">' + e(p.name) + "</option>")
            .join("") +
          "</select>"
        : "") +
      '<label class="field-label" for="new-list-name">New playlist name (if creating)</label><input class="field" id="new-list-name" name="name" maxlength="80" placeholder="e.g. Favorites for Friday">',
    async (data) => {
      let id = data.get("playlist");
      if (!id) {
        if (!String(data.get("name") || "").trim())
          throw new Error("Name your new playlist or choose an existing one.");
        id = (await mutate("/api/playlists", { name: data.get("name") })).playlist.id;
      }
      await mutate(listPath(id) + "/add", { tracks: [track] });
    },
    "Save track",
  );
}
function stationEditor(station) {
  showModal(
    station ? "Edit radio station" : "Add a radio station",
    '<label class="field-label" for="station-name">Station name</label><input class="field" id="station-name" name="name" required maxlength="80" placeholder="e.g. Late night jazz" value="' +
      e(station?.name) +
      '"><label class="field-label" for="station-url">Stream URL</label><input class="field" id="station-url" name="url" type="url" required placeholder="https://station.example.com/live" value="' +
      e(station?.url) +
      '"><p class="small subtle">HTTP, Icecast and SHOUTcast streams work.</p>',
    (data) =>
      mutate(
        "/api/radio-stations" + (station ? "/" + encodeURIComponent(station.id) : ""),
        { name: data.get("name"), url: data.get("url") },
        station ? "PATCH" : "POST",
      ),
    station ? "Save station" : "Add station",
  );
}
function reorderDialog(scope, index) {
  const tracks = tracksFor(scope),
    track = tracks[index],
    expected = orderData(scope);
  if (!track) return;
  showModal(
    "Move track",
    "<p>" +
      e(track.title) +
      '</p><label class="field-label" for="track-position">New position (1–' +
      tracks.length +
      ')</label><input class="field" id="track-position" name="position" type="number" min="1" max="' +
      tracks.length +
      '" value="' +
      (index + 1) +
      '" required>',
    (data) => moveTrack(scope, index + 1, Number(data.get("position")), expected),
    "Move track",
  );
}
function moveTrack(scope, from, to, expected = orderData(scope)) {
  if (scope === "queue") return action("move", { from, to, ...expected });
  return mutate(listPath(scope) + "/move", { from, to, ...expected });
}

function renderBackground() {
  const b = bot();
  if (!b) return;
  const h = b.health || {},
    system = state.system || {},
    container = $("#health-values");
  const playback = playbackStatus(b);
  const stage = $("#playback-stage");
  const label = playback.loading || playback.phase === "paused" ? playback.label : "";
  if (stage && stage.textContent !== label) stage.textContent = label;
  document.querySelectorAll("[data-playback-label]").forEach((el) => {
    if (el.textContent !== playback.label.toUpperCase())
      el.textContent = playback.label.toUpperCase();
  });
  document.querySelectorAll("[data-playback-dot]").forEach((el) => {
    el.className =
      "status-dot " + (playback.phase === "playing" ? "on" : playback.loading ? "warning" : "");
  });
  document
    .querySelectorAll("[data-playback-indicator]")
    .forEach((el) => el.classList.toggle("paused", playback.phase !== "playing"));
  const statusText = !b.connected
    ? "Offline"
    : playback.phase === "idle"
      ? "Connected · Idle"
      : playback.phase === "playing"
        ? "Playing"
        : playback.label;
  const statusNode = $("#connection-label");
  if (statusNode && statusNode.textContent !== statusText) statusNode.textContent = statusText;
  paintPlayButtons();
  paintEnqueueButtons();
  if (container) {
    const metrics = [
      ["Server uptime", time(Math.floor(system.uptime || 0))],
      ["Node process memory", (system.memoryMB || 0) + " MB"],
      ["Process ID", system.pid || "—"],
      ["Reconnects", h.reconnectCount || 0],
      ["Audio buffer", Number(h.bufferedSeconds || 0).toFixed(1) + "s"],
      [
        "Audio startup",
        h.startupMs === null || h.startupMs === undefined
          ? "Waiting for audio"
          : h.startupMs + " ms",
      ],
      [
        "Source lookup",
        h.sourceLookupMs === null || h.sourceLookupMs === undefined
          ? "—"
          : h.sourceLookupMs + " ms",
      ],
      ["Buffer underruns", h.underruns || 0],
      ["Event loop delay", (system.eventLoopLagMs ?? "—") + " ms"],
      [
        "Playback recovery",
        h.retrying
          ? "Retrying (" + h.retryAttempt + "/2)"
          : h.restoredCheckpoint
            ? "Checkpoint restored"
            : "Ready",
      ],
      [
        "Checkpoint",
        !h.checkpoint
          ? "Not enabled"
          : h.checkpoint.error
            ? "Save failed"
            : h.checkpoint.pending
              ? "Saving…"
              : h.checkpoint.lastSavedAt
                ? "Saved " + new Date(h.checkpoint.lastSavedAt).toLocaleTimeString()
                : "Waiting",
      ],
      [
        "Media lookups",
        (system.media?.active || 0) + " active · " + (system.media?.queued || 0) + " queued",
      ],
      ["Event loop p99", (system.eventLoopP99Ms ?? "—") + " ms"],
      ["Audio profile", h.audioProfile || "high"],
      ["Shared preparations", (h.prebufferSlots || 0) + " / 2"],
      ["Paused audio", h.parked ? "Released; resumes from saved position" : "Ready"],
    ];
    container.innerHTML =
      '<dl class="detail-list">' +
      metrics
        .map(([label, value]) => "<dt>" + e(label) + "</dt><dd>" + e(value) + "</dd>")
        .join("") +
      "</dl>" +
      (b.lastDisconnect
        ? '<p class="small subtle">Last disconnect: ' +
          e(b.lastDisconnect.reason) +
          " · " +
          e(new Date(b.lastDisconnect.at).toLocaleString()) +
          "</p>"
        : "") +
      (h.lastError ? '<p class="small subtle">Last audio error: ' + e(h.lastError) + "</p>" : "");
    if (system.libraryError)
      container.innerHTML +=
        '<p class="notice">Library save failed: ' + e(system.libraryError) + "</p>";
    if (h.failoverReason)
      container.innerHTML +=
        '<p class="small subtle">Radio fallback: ' + e(h.failoverReason) + "</p>";
  }
  const toggle = $('[data-action="prebuffer"]');
  if (toggle) toggle.setAttribute("aria-checked", String(!!h.prebufferEnabled));
  if ($("#prebuffer-status"))
    $("#prebuffer-status").textContent =
      "Next track: " +
      (h.prebufferStatus || "off") +
      " · " +
      (h.activeProcesses || 0) +
      " audio processes";
  notifications.update(state);
  const meter = $("#audio-level");
  if (meter) {
    meter.value = Math.max(-60, b.health?.level?.rmsDb ?? -60);
    meter.textContent = (b.health?.level?.rmsDb ?? -96).toFixed(1) + " dB";
  }
}

const instanceSummaries = () =>
  state.bots.map((x) => [
    x.platform,
    x.serverName,
    x.connectionError,
    x.discord,
    x.name,
    x.nickname,
    x.connected,
    x.channel,
    x.removable,
    nowLine(x),
  ]);
const nowLine = (x) =>
  x.track
    ? "Playing " + x.track.title
    : x.radio
      ? "Radio · " + (x.radioTitle || x.radio.name)
      : "Idle";
const instanceAvatar = (x) =>
  '<span class="switcher-avatar" title="' +
  platformName(x) +
  '">' +
  platformIcon(x) +
  '<span class="status-dot ' +
  (x.connected ? "on" : "") +
  '"></span></span>';
function renderSwitcher(b) {
  const keep = $("#bot-switcher").contains(document.activeElement)
    ? { ...document.activeElement.dataset }
    : null;
  $("#switcher-button").innerHTML =
    instanceAvatar(b) +
    '<span class="switcher-text"><strong>' +
    e(b.nickname || b.name) +
    "</strong><small>" +
    platformName(b) +
    " / " +
    e(b.connected ? b.channel || "Connected" : "Offline") +
    "</small></span>" +
    icon("chevron");
  $("#switcher-button").title = "Bot instance: " + (b.nickname || b.name);
  $("#switcher-menu").innerHTML =
    '<div class="switcher-label"><span>BOT INSTANCES</span><span>' +
    state.bots.length +
    "</span></div>" +
    state.bots
      .map(
        (x) =>
          '<button type="button" class="switcher-item" role="menuitemradio" aria-checked="' +
          (x.name === b.name) +
          '" data-action="switch-bot" data-id="' +
          e(x.name) +
          '">' +
          instanceAvatar(x) +
          '<span class="switcher-text"><strong>' +
          e(x.nickname || x.name) +
          "</strong><small>" +
          platformName(x) +
          " / " +
          e(x.connected ? x.channel || "Connected" : "Offline") +
          '</small><small class="switcher-now">' +
          e(nowLine(x)) +
          "</small></span>" +
          (x.name === b.name ? icon("check") : "") +
          "</button>",
      )
      .join("") +
    '<div class="switcher-footer">' +
    button(
      "Add instance",
      "plus",
      "new-instance",
      state.bots.length >= state.maxInstances ? "disabled" : "",
      "secondary",
    ) +
    '<a class="button secondary" href="#settings" data-action="close-switcher">' +
    icon("settings") +
    "Manage</a></div>";
  if (keep?.action)
    [...$("#bot-switcher").querySelectorAll("[data-action]")]
      .find((el) => el.dataset.action === keep.action && el.dataset.id === keep.id)
      ?.focus({ preventScroll: true });
}
function toggleSwitcher(open = $("#switcher-menu").hidden) {
  $("#switcher-menu").hidden = !open;
  $("#switcher-button").setAttribute("aria-expanded", String(open));
  if (open) $('#switcher-menu [aria-checked="true"]')?.focus();
}
function selectBot(name) {
  botName = name;
  try {
    localStorage.setItem("radiospeak.bot", name);
  } catch {}
  receivedAt = Date.now();
  toggleSwitcher(false);
  render(true);
}
function instancesCard(b) {
  return (
    '<section class="card card-padding instances-card"><div class="card-title"><h2>Bot instances <span class="count-badge">' +
    state.bots.length +
    "</span></h2>" +
    button(
      "Add instance",
      "plus",
      "new-instance",
      state.bots.length >= state.maxInstances ? "disabled" : "",
    ) +
    "</div>" +
    '<p class="small subtle">Each Discord or TeamSpeak instance has a separate voice channel, queue, volume and idle playlist. Switch between them here or from the top bar.</p>' +
    state.bots
      .map(
        (x) =>
          '<div class="instance-row ' +
          (x.name === b.name ? "current" : "") +
          '">' +
          instanceAvatar(x) +
          '<div class="switcher-text"><strong>' +
          e(x.nickname || x.name) +
          ' <span class="instance-id">' +
          e(x.name) +
          "</span></strong>" +
          platformBadge(x) +
          "<small>" +
          e(x.connected ? x.channel || "Connected" : "Offline") +
          " · " +
          e(nowLine(x)) +
          '</small></div><div class="instance-actions">' +
          (x.name === b.name
            ? '<span class="tag green">Selected</span>'
            : button("Switch", "arrow", "switch-bot", 'data-id="' + e(x.name) + '"', "secondary")) +
          (x.platform === "discord" && x.removable
            ? ib(
                "settings",
                "Edit Discord connection",
                "edit-connection",
                'data-id="' + e(x.name) + '"',
              )
            : "") +
          (x.removable
            ? ib(
                "trash",
                "Remove " + (x.nickname || x.name),
                "delete-instance",
                'data-id="' + e(x.name) + '"',
                "danger",
              )
            : '<span class="tag" title="Defined in the server configuration">Config</span>') +
          "</div></div>",
      )
      .join("") +
    "</section>"
  );
}
function syncPlatformFields() {
  const platform = $("#instance-platform")?.value || "teamspeak";
  document.querySelectorAll("#modal-body [data-platform-fields]").forEach((block) => {
    const hidden = block.dataset.platformFields !== platform;
    block.hidden = hidden;
    block.querySelectorAll("input,select").forEach((el) => {
      el.disabled = hidden;
    });
  });
}
function instanceEditor() {
  const channels = state.bots.find((b) => b.platform !== "discord" && b.connected)?.channels || [];
  showModal(
    "Add a bot instance",
    '<label class="field-label" for="instance-platform">Platform</label><select class="field" id="instance-platform" name="platform"><option value="teamspeak">TeamSpeak</option><option value="discord" ' +
      (bot()?.platform === "discord" ? "selected" : "") +
      '>Discord</option></select><p class="small subtle">Each instance has its own queue, volume and idle playlist.</p><label class="field-label" for="instance-nickname">Bot name</label><input class="field" id="instance-nickname" name="nickname" required maxlength="30" placeholder="e.g. Lobby Radio">' +
      '<label class="field-label" for="instance-id">Instance ID</label><input class="field" id="instance-id" name="name" required maxlength="24" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" placeholder="e.g. lobby-radio"><p class="small subtle">Used in logs and file names: letters, numbers, - and _.</p><div data-platform-fields="teamspeak"><p>A new TeamSpeak client joins the configured server with its own persistent identity.</p><label class="field-label" for="instance-channel">Channel</label><select id="instance-channel" name="channelId"><option value="">Server default (choose later)</option>' +
      channels.map((c) => '<option value="' + e(c.id) + '">' + e(c.name) + "</option>").join("") +
      '</select></div><div data-platform-fields="discord" hidden>' +
      discordFields(null) +
      "</div>",
    async (data) => {
      const platform = data.get("platform");
      const result = await mutate("/api/bots", {
        name: data.get("name"),
        nickname: data.get("nickname"),
        platform,
        channelId: data.get("channelId") || undefined,
        ...(platform === "discord"
          ? { guildId: data.get("guildId"), token: data.get("token") }
          : {}),
      });
      selectBot(result.bot);
    },
    "Add instance",
  );
  syncPlatformFields();
}
function connectionEditor(id) {
  const target = state.bots.find((b) => b.name === id);
  if (!target) return;
  showModal(
    "Discord connection",
    discordFields(target, false),
    (data) =>
      mutate("/api/bots/" + encodeURIComponent(id) + "/connection", {
        token: data.get("token"),
        guildId: data.get("guildId"),
        channelId: data.get("channelId"),
      }),
    "Save & reconnect",
  );
}

function renderChrome(b) {
  const signature = JSON.stringify([
    b.name,
    b.nickname,
    b.connected,
    b.channel,
    b.track?.url,
    b.userPaused,
    b.autoPaused,
    b.queue.length,
    state.collections,
    state.playlists.map((p) => p.collectionId),
    state.favorites.length,
    b.listeners,
    b.channels,
    b.normalization,
    b.defaultPlaylist,
    b.radio,
    instanceSummaries(),
  ]);
  if (signature === renderedChrome) return;
  renderedChrome = signature;
  $("#sign-out").hidden = !state.authEnabled;
  const status = !b.connected
    ? "Offline"
    : paused(b)
      ? "Paused"
      : currentTrack()
        ? "Playing"
        : "Connected · Idle";
  $("#connection").innerHTML =
    '<span class="status-dot ' +
    (b.connected ? "on" : "") +
    '"></span><span id="connection-label">' +
    e(status) +
    "</span>";
  $("#queue-badge").textContent = b.queue.length;
  $("#favorite-count").textContent = state.favorites.length;
  $("#sidebar-bot").textContent = b.nickname || b.name;
  $("#sidebar-channel").textContent = b.channel || "Not connected";
  $("#sidebar-dot").className = "status-dot " + (b.connected ? "on" : "");
  $("#sidebar-collections").innerHTML = state.collections.length
    ? state.collections
        .map(
          (c) =>
            '<button class="collection-link" data-action="collection" data-id="' +
            e(c.id) +
            '">' +
            icon("folder") +
            '<span class="name">' +
            e(c.name) +
            '</span><span class="small subtle" style="margin-left:auto">' +
            state.playlists.filter((p) => p.collectionId === c.id).length +
            "</span></button>",
        )
        .join("")
    : '<p class="subtle small">A home for every mood.</p>';
  renderSwitcher(b);
  $("#statusbar").innerHTML =
    '<span><span class="status-dot ' +
    (b.connected ? "on" : "") +
    '"></span>' +
    (b.connected ? "Connected to " + platformName(b) : platformName(b) + " bot offline") +
    "</span><span>" +
    icon("headphones") +
    channelSelect(b, "Move bot to channel") +
    "</span><span>" +
    icon("users") +
    b.listeners.length +
    ' listeners</span><button data-action="normalization" aria-pressed="' +
    b.normalization +
    '">' +
    icon("check") +
    "Normalization " +
    (b.normalization ? "on" : "off") +
    '</button><span class="status-end">Made for listening, together.</span>';
}
function render(force = false) {
  const actual = bot();
  const b = actual
    ? {
        ...actual,
        volume:
          volumeControl.get(actual.name) ?? requestedVolumes.get(actual.name) ?? actual.volume,
      }
    : actual;
  if (!b) return;
  botName = b.name;
  renderChrome(b);
  if (!state.playlists.some((p) => p.id === playlistId)) playlistId = null;
  if (
    !["all", "standalone", "favorites"].includes(libraryFilter) &&
    !state.collections.some((c) => c.id === libraryFilter)
  )
    libraryFilter = "all";
  const bWithoutProgress = { ...b };
  delete bWithoutProgress.elapsed;
  delete bWithoutProgress.health;
  delete bWithoutProgress.revision;
  const signature = JSON.stringify([
    activeView,
    playlistId,
    libraryFilter,
    [...pages],
    bWithoutProgress,
    state.playlists,
    state.collections,
    state.defaults,
    state.favorites,
    state.radioStations,
    state.schedules,
    state.viewer?.role,
    instanceSummaries(),
    searchSource,
    searchType,
  ]);
  const active = document.activeElement;
  const editing = $("#view").contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
  if ((force || signature !== renderedView) && !dragging && (!editing || force)) {
    const focusId = active?.id,
      selection =
        active?.tagName === "INPUT" && active.type === "search"
          ? [active.selectionStart, active.selectionEnd]
          : null;
    const focusData = $("#view").contains(active) ? { ...active.dataset } : null;
    renderedView = signature;
    viewTracks = new Map([["queue", [...b.queue]]]);
    viewVersions.clear();
    for (const [id, detail] of playlistCache) {
      const sparse = Array(detail.trackCount ?? detail.total);
      detail.tracks.forEach((t, i) => {
        sparse[detail.positions?.[i] ?? detail.offset + i] = t;
      });
      viewTracks.set(id, sparse);
      viewVersions.set(id, detail.version);
    }
    $("#view").innerHTML = (
      {
        dashboard,
        queue: (b) =>
          heading(
            "Good things are up next.",
            "Your channel’s requests, in the order you want to hear them.",
            '<a href="#search" class="button primary">' + icon("plus") + "Add tracks</a>",
          ) +
          hero(b) +
          '<div style="margin-top:28px">' +
          queueSection(b, true) +
          "</div>",
        library,
        search: searchView,
        radio: radioView,
        history: historyView,
        settings: (b) =>
          settings(b) +
          operationsMarkup(state, b) +
          (state.viewer?.role === "admin"
            ? managementMarkup(auditData) + accessMarkup(accessData)
            : ""),
      }[activeView] || dashboard
    )(b);
    if (focusId && document.getElementById(focusId)) {
      document.getElementById(focusId).focus({ preventScroll: true });
      if (selection) document.getElementById(focusId).setSelectionRange(...selection);
    } else if (focusData?.action) {
      [...$("#view").querySelectorAll("[data-action]")]
        .find((el) =>
          ["action", "id", "scope", "index"].every((key) => el.dataset[key] === focusData[key]),
        )
        ?.focus({ preventScroll: true });
    }
  }
  const dockSignature = JSON.stringify([
    b.name,
    b.track,
    b.currentPlaylist,
    b.radio,
    b.radioTitle,
    b.userPaused,
    b.autoPaused,
    b.loop,
    b.shuffle,
    b.canGoBack,
    b.volume,
    state.favorites.map((t) => t.url),
    b.defaultPlaylist,
    state.viewer?.role,
  ]);
  // Keep the native range attached until its change event commits the drag preview.
  if (dockSignature !== renderedDock && !sliderActive && !seekGesture?.changed) {
    const focused = $("#player-dock").contains(document.activeElement)
      ? { id: document.activeElement.id, action: document.activeElement.dataset.action }
      : null;
    renderedDock = dockSignature;
    $("#player-dock").innerHTML = dock(b);
    if (focused?.id) document.getElementById(focused.id)?.focus({ preventScroll: true });
    else if (focused?.action)
      [...$("#player-dock").querySelectorAll("[data-action]")]
        .find((el) => el.dataset.action === focused.action)
        ?.focus({ preventScroll: true });
    const title = $(".dock-title"),
      text = $(".dock-title>span");
    if (text && text.scrollWidth > title.clientWidth) {
      title.style.setProperty(
        "--marquee-distance",
        title.clientWidth - text.scrollWidth - 10 + "px",
      );
      title.classList.add("is-long");
    }
  }
  updateProgress();
  renderBackground();
  paintEnqueueButtons();
  enforcePermissions();
}
function updateProgress() {
  const b = bot(),
    seek = $("#seek");
  if (!b || !seek || sliderActive === "seek") return;
  const pending = seekControl.get(b.name, b.track?.url);
  const extra =
    !paused(b) && b.track && !b.health?.buffering
      ? Math.min(1.5, (Date.now() - receivedAt) / 1000)
      : 0;
  const elapsed = Math.min(b.track?.duration || Infinity, pending ?? b.elapsed + extra);
  seek.setAttribute("aria-busy", String(pending !== undefined || !!b.health?.buffering));
  seek.value = elapsed;
  seek.style.setProperty(
    "--fill",
    b.track?.duration ? (elapsed / b.track.duration) * 100 + "%" : "0%",
  );
  seek.setAttribute(
    "aria-valuetext",
    time(Math.floor(elapsed)) +
      " of " +
      (b.track?.duration ? duration(b.track.duration) : "live stream"),
  );
  $("#elapsed").textContent = time(Math.floor(elapsed));
  const etaKey = b.name + "|" + b.revision + "|" + Math.floor(elapsed);
  if (lastEtaKey === etaKey) return;
  lastEtaKey = etaKey;
  let wait = b.track ? (b.track.duration ? Math.max(0, b.track.duration - elapsed) : null) : 0;
  const estimates = b.queue.map((t) => {
    const estimate = wait;
    wait = wait === null || !t.duration ? null : wait + t.duration;
    return estimate;
  });
  document.querySelectorAll("[data-eta-index]").forEach((el) => {
    const estimate = estimates[Number(el.dataset.etaIndex)];
    el.textContent =
      b.loop === "one" && !b.track?.auto
        ? " · after repeat is off"
        : estimate === null
          ? " · time unavailable"
          : estimate === undefined
            ? ""
            : " · ~" + time(Math.ceil(estimate)) + (paused(b) ? " after resume" : " until play");
  });
}
function navigate() {
  activeView = location.hash.slice(1) in views ? location.hash.slice(1) : "dashboard";
  $("#breadcrumb").textContent = views[activeView];
  document.title = views[activeView] + " · radiospeak";
  document.querySelectorAll("nav a").forEach((a) => {
    const active = a.dataset.view === activeView;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#sidebar").classList.remove("open");
  $('[data-action="menu"]').setAttribute("aria-expanded", "false");
  render(true);
}

const searchUrl = (page) =>
  "/api/search?q=" +
  encodeURIComponent(query.trim()) +
  "&source=" +
  searchSource +
  "&type=" +
  searchType +
  "&page=" +
  page;
/** Appends the next page of results, skipping any already shown. */
async function loadMoreResults() {
  if (searchMoreLoading || !searchHasMore) return;
  const controller = searchController;
  searchMoreLoading = true;
  if ($("#search-results")) $("#search-results").innerHTML = searchResultsMarkup();
  try {
    const results = await request(searchUrl(searchPage + 1), undefined, "GET", controller?.signal);
    if (searchController !== controller) return;
    const shown = new Set(searchResults.map((t) => t.url));
    searchResults = [...searchResults, ...results.filter((t) => !shown.has(t.url))];
    searchPage++;
    searchHasMore = results.length >= SEARCH_PAGE && searchPage < SEARCH_PAGES;
  } catch (error) {
    if (searchController === controller && error.name !== "AbortError") toast(error.message, true);
  } finally {
    searchMoreLoading = false;
    if (searchController === controller && $("#search-results")) {
      $("#search-results").innerHTML = searchResultsMarkup();
      paintEnqueueButtons();
      enforcePermissions();
    }
  }
}
/** Previews a public playlist, then imports it into a new library playlist. */
async function importPlaylist(url) {
  const preview = await request("/api/imports/preview", { input: url });
  let importedId = null;
  showModal(
    "Import a public playlist",
    "<p>" +
      e(
        preview.total
          ? preview.total + " entries found."
          : "Preview loaded; the provider has not reported the total.",
      ) +
      " Imports run in batches of up to " +
      preview.batchLimit +
      " entries. Continue larger playlists from Notifications (the bell at the top right).</p><details><summary>Preview " +
      preview.tracks.length +
      " tracks</summary><ol>" +
      preview.tracks.map((t) => "<li>" + e(t.title) + "</li>").join("") +
      '</ol></details><label class="field-label" for="import-target">Import into</label><select id="import-target" name="target"><option value="">A new playlist</option>' +
      state.playlists
        .map(
          (p) =>
            '<option value="' +
            e(p.id) +
            '">' +
            e(p.name) +
            " (" +
            trackCount(p) +
            " tracks)</option>",
        )
        .join("") +
      '</select><div class="import-new"><label class="field-label" for="import-name">New playlist name</label><input class="field" id="import-name" name="name" required maxlength="80" value="' +
      e(preview.name) +
      '" placeholder="e.g. Weekend rotation"></div><label class="check-label"><input type="checkbox" name="skipDuplicates" checked> Skip duplicate tracks</label>',
    async (d) => {
      // An existing playlist, or a new one created once even if the import is retried.
      const target = String(d.get("target") || "");
      if (!target && !importedId)
        importedId = (
          await mutate("/api/playlists", {
            name: d.get("name"),
            collectionId: state.collections.some((c) => c.id === libraryFilter)
              ? libraryFilter
              : null,
          })
        ).playlist.id;
      // Keep the playlist selected even if the provider rejects the import.
      playlistId = target || importedId;
      location.hash = "library";
      render(true);
      await mutate("/api/imports", {
        playlistId,
        input: url,
        skipDuplicates: d.get("skipDuplicates") === "on",
      });
    },
    "Import playlist",
  );
}
async function search() {
  clearTimeout(searchTimer);
  searchController?.abort();
  if (!query.trim()) {
    searchStatus = "idle";
    searchResults = [];
    $("#search-results") && ($("#search-results").innerHTML = searchResultsMarkup());
    return;
  }
  const controller = new AbortController();
  searchController = controller;
  const timeout = setTimeout(
    () => controller.abort(new Error("Search timed out. Please try again.")),
    95000,
  );
  searchStatus = "loading";
  if ($("#search-results")) $("#search-results").innerHTML = searchResultsMarkup();
  try {
    const results = await request(searchUrl(1), undefined, "GET", controller.signal);
    if (searchController !== controller) return;
    searchResults = results;
    searchStatus = "done";
    searchPage = 1;
    searchHasMore = results.length >= SEARCH_PAGE;
  } catch (error) {
    if (searchController !== controller || error.name === "AbortError") return;
    searchError = error.message;
    searchStatus = "error";
  } finally {
    clearTimeout(timeout);
    if (searchController === controller && $("#search-results")) {
      $("#search-results").innerHTML = searchResultsMarkup();
      paintEnqueueButtons();
      enforcePermissions();
    }
  }
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  // Clicking anywhere outside the instance switcher closes it.
  if (!$("#switcher-menu").hidden && !event.target.closest("#bot-switcher")) toggleSwitcher(false);
  if (!el || el.disabled) return;
  const { action: kind, id, scope } = el.dataset,
    index = Number(el.dataset.index),
    b = bot();
  if (kind === "reload-panel") {
    location.reload();
    return;
  }
  if (kind === "toggle-switcher") {
    toggleSwitcher();
    return;
  }
  if (kind === "close-switcher") {
    toggleSwitcher(false);
    return;
  }
  if (kind === "switch-bot") {
    selectBot(id);
    return;
  }
  if (kind === "sign-out") {
    connection.stop();
    try {
      await request("/api/logout", {});
    } catch {}
    location.replace("/login");
    return;
  }
  if (kind === "notifications-read") return;
  if (panelNeedsReload && kind !== "close-modal") {
    toast("Reload the panel to use the updated controls.", true);
    return;
  }
  try {
    switch (kind) {
      case "export-library": {
        const archive = await request("/api/transfer");
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "radiospeak-" + new Date().toISOString().slice(0, 10) + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("Settings and playlists exported.");
        return;
      }
      case "refresh-audit":
        await loadManagement();
        return;
      case "audit-page":
        await loadManagement(Number(el.dataset.offset));
        return;
      case "select-page": {
        const list = playlist();
        if (list) {
          const selected = selectionFor(list);
          selected.allMatching = false;
          selected.indices = [...new Set([...selected.indices, ...list.positions])];
          render(true);
        }
        return;
      }
      case "select-matches": {
        const list = playlist();
        if (list) {
          selectionFor(list).allMatching = true;
          selectionFor(list).excluded = [];
          render(true);
        }
        return;
      }
      case "clear-selection":
        playlistSelections.delete(playlistId);
        render(true);
        return;
      case "delete-current": {
        const t = b.track,
          list = b.currentPlaylist;
        if (!t || !list) throw new Error("Only songs from a saved playlist can be deleted.");
        return confirmAction(
          "Delete this song?",
          "“" + t.title + "” is removed from " + list.name + " and the next song starts.",
          () => action("delete-current", { url: t.url }),
          "Delete song",
        );
      }
      case "delete-selected": {
        const list = playlist(),
          selection = selectionFor(list),
          count = selection.allMatching
            ? list.total - selection.excluded.length
            : selection.indices.length;
        if (!count) throw new Error("Select tracks first.");
        return confirmAction(
          "Delete " + count + " track" + (count === 1 ? "" : "s") + "?",
          "They are removed from " + list.name + ". This cannot be undone.",
          async () => {
            await mutate(listPath(list.id) + "/bulk", {
              ...selection,
              ...filterFor(list.id),
              action: "remove",
              expectedVersion: list.version,
            });
            playlistSelections.delete(list.id);
            render(true);
          },
          "Delete tracks",
        );
      }
      case "bulk-tracks": {
        const list = playlist(),
          selection = selectionFor(list);
        if (!selection.allMatching && !selection.indices.length)
          throw new Error("Select tracks first.");
        const destinationOptions = state.playlists
          .filter((p) => p.id !== list.id)
          .map((p) => '<option value="' + e(p.id) + '">' + e(p.name) + "</option>")
          .join("");
        return showModal(
          "Edit selected tracks",
          "<p>" +
            (selection.allMatching
              ? list.total - selection.excluded.length
              : selection.indices.length) +
            ' tracks selected. Changes apply to the saved order across every page.</p><label>Action<select class="field" name="operation"><option value="copy">Copy to playlist</option><option value="move">Move to playlist</option><option value="remove">Remove selected tracks</option><option value="deduplicate">Remove duplicate copies (keep first occurrence)</option><option value="sort">Sort selected tracks in place</option></select></label><label>Destination (copy / move)<select class="field" name="destination">' +
            destinationOptions +
            '</select></label><label>Sort by<select class="field" name="sort"><option value="title">Title</option><option value="artist">Artist</option><option value="duration">Duration</option></select></label>',
          async (data) => {
            const destination = state.playlists.find((p) => p.id === data.get("destination"));
            await mutate(listPath(list.id) + "/bulk", {
              ...selection,
              ...filterFor(list.id),
              action: data.get("operation"),
              destination: destination?.id,
              destinationVersion: destination?.version,
              sort: data.get("sort"),
              expectedVersion: list.version,
            });
            playlistSelections.delete(list.id);
            render(true);
          },
          "Apply changes",
        );
      }
      case "page":
        pages.set(scope, Math.max(0, Number(el.dataset.page)));
        renderedView = "";
        render();
        return;
      case "retry-playlist":
        playlistErrors.delete(id);
        renderedView = "";
        render();
        return;
      case "undo":
        await mutate("/api/bots/" + encodeURIComponent(el.dataset.bot) + "/undo", {
          token: el.dataset.token,
        });
        return;
      case "prebuffer":
        await action("prebuffer", { enabled: !b.health?.prebufferEnabled });
        render(true);
        return;
      case "cancel-import":
        await mutate("/api/imports/" + encodeURIComponent(id) + "/cancel", {});
        return;
      case "dismiss-import":
        await mutate("/api/imports/" + encodeURIComponent(id), {}, "DELETE");
        renderBackground();
        return;
      case "resume-import":
        await mutate("/api/imports/" + encodeURIComponent(id) + "/resume", {});
        return;
      case "retry-import":
        await mutate("/api/imports/" + encodeURIComponent(id) + "/retry", {});
        return;
      case "history-enqueue": {
        const track = historyCache.get(b.name)?.entries.find((h) => h.id === id)?.track;
        if (track) await enqueueControl.add(b, track);
        return;
      }
      case "edit-schedule": {
        const schedule = state.schedules.find((s) => s.id === id);
        if (!schedule) return;
        return showModal("Edit playlist schedule", scheduleFields(state, b, schedule), (data) =>
          mutate("/api/schedules/" + encodeURIComponent(id), scheduleData(data, b.name), "PATCH"),
        );
      }
      case "delete-schedule":
        return confirmAction(
          "Remove schedule?",
          "The saved playlist stays in your library.",
          () => mutate("/api/schedules/" + encodeURIComponent(id), {}, "DELETE"),
          "Remove",
        );
      case "delete-account":
        return confirmAction(
          "Remove " + id + "?",
          "This account will be signed out and lose panel access.",
          async () => {
            await mutate("/api/accounts/" + encodeURIComponent(id), {}, "DELETE");
            accessData = null;
            render(true);
          },
          "Remove account",
        );
      case "close-menu":
        $("#sidebar").classList.remove("open");
        $('[data-action="menu"]').setAttribute("aria-expanded", "false");
        return;
      case "menu": {
        const open = $("#sidebar").classList.toggle("open");
        el.setAttribute("aria-expanded", String(open));
        return;
      }
      case "close-modal":
        clearModalSecrets();
        $("#modal").close();
        return;
      case "edit-connection":
        return connectionEditor(id);
      case "new-instance":
        toggleSwitcher(false);
        return instanceEditor();
      case "delete-instance": {
        const target = state.bots.find((x) => x.name === id);
        return confirmAction(
          "Remove " + (target?.nickname || id) + "?",
          "The bot disconnects and its queue, channel and idle playlist settings are deleted. Saved playlists and radio stations are kept.",
          () => mutate("/api/bots/" + encodeURIComponent(id), {}, "DELETE"),
          "Remove instance",
        );
      }
      case "new-collection":
        return collectionEditor();
      case "new-playlist":
        return playlistEditor();
      case "rename-collection":
        return collectionEditor(state.collections.find((c) => c.id === id));
      case "delete-collection":
        return confirmAction(
          "Delete collection?",
          "Its playlists will be kept as standalone playlists.",
          async () => {
            await mutate("/api/collections/" + encodeURIComponent(id), {}, "DELETE");
            libraryFilter = "all";
            render(true);
          },
        );
      case "collection":
      case "filter":
        libraryFilter = id;
        playlistId = null;
        location.hash = "library";
        render(true);
        return;
      case "favorites":
        libraryFilter = "favorites";
        playlistId = null;
        location.hash = "library";
        render(true);
        return;
      case "open-playlist":
        playlistId = id;
        location.hash = "library";
        render(true);
        return;
      case "library-back":
        playlistId = null;
        render(true);
        return;
      case "edit-playlist":
        return playlistEditor(state.playlists.find((p) => p.id === id));
      case "delete-playlist":
        return confirmAction(
          "Delete playlist?",
          "This deletes the playlist and its saved tracks. If it is an idle playlist, that fallback will be disabled.",
          async () => {
            await mutate(listPath(id), {}, "DELETE");
            playlistId = null;
            render(true);
          },
        );
      case "queue-playlist":
        await mutate(listPath(id) + "/play", { bot: b.name });
        return;
      case "play-playlist-now":
        await mutate(listPath(id) + "/play-now", { bot: b.name });
        return;
      case "default-playlist":
        await action("default", { playlistId: state.defaults[b.name] === id ? null : id });
        return;
      case "toggle-play":
        if (b.connectionPaused) {
          toast("Playback is held until the bot reconnects to " + platformName(b) + ".");
          return;
        }
        if (b.autoPaused) {
          toast("Playback will resume when a listener joins the channel.");
          return;
        }
        await action(currentTrack() ? (b.userPaused ? "resume" : "pause") : "start");
        return;
      case "skip":
        await action(state.viewer?.role === "listener" ? "vote-skip" : "skip");
        return;
      case "previous":
        await action("previous");
        return;
      case "stop":
        return confirmAction(
          "Stop playback?",
          "This stops audio and clears user requests. Your saved playlists remain available.",
          () => action("stop"),
          "Stop playback",
        );
      case "shuffle":
        await action("shuffle", { enabled: !b.shuffle });
        return;
      case "repeat":
        await action("loop", { mode: { off: "all", all: "one", one: "off" }[b.loop] });
        return;
      case "normalization":
        await action("normalization", { enabled: !b.normalization });
        return;
      case "welcome":
        await action("welcome", { enabled: !b.welcomes });
        return;
      case "mute": {
        const current = volumeControl.get(b.name) ?? requestedVolumes.get(b.name) ?? b.volume;
        if (current > 0) lastVolumes.set(b.name, current);
        volumeControl.set(b.name, current ? 0 : lastVolumes.get(b.name) || 50, true);
        return;
      }
      case "clear-queue": {
        const expected = tracksFor("queue").map((t) => t.url);
        return confirmAction(
          "Clear the queue?",
          "Remove all upcoming user requests? The current track will keep playing.",
          () => action("clear", { expected }),
          "Clear queue",
        );
      }
      case "queue-next":
      case "queue-top":
        await moveTrack("queue", index + 1, 1);
        return;
      case "reorder":
        return reorderDialog(scope, index);
      case "remove-track": {
        const expected = orderData(scope);
        if (scope === "queue") await action("remove", { position: index + 1, ...expected });
        else await mutate(listPath(scope) + "/tracks/" + (index + 1), expected, "DELETE");
        return;
      }
      case "play-track":
      case "enqueue-track": {
        const track = tracksFor(scope)[index];
        if (!track) throw new Error("This track is no longer available");
        if (kind === "enqueue-track") await enqueueControl.add(b, track);
        else await playControl.play(b, track);
        return;
      }
      case "favorite-current":
        await mutate("/api/favorites", { track: currentTrack() });
        return;
      case "favorite-track":
        await mutate("/api/favorites", { track: tracksFor(scope)[index] });
        return;
      case "save-track":
        return saveTrack(tracksFor(scope)[index]);
      case "save-current":
        return saveTrack(currentTrack());
      case "save-queue":
        return showModal(
          "Save queue to playlist",
          '<label class="field-label" for="queue-playlist-name">Playlist name</label><input class="field" id="queue-playlist-name" name="name" required maxlength="80" placeholder="e.g. Tonight’s session">',
          async (data) => {
            const result = await mutate("/api/playlists", { name: data.get("name") });
            await mutate(listPath(result.playlist.id) + "/save", { bot: b.name });
          },
          "Save queue",
        );
      case "search-source":
        searchSource = id;
        if (id !== "youtube") searchType = "tracks";
        render(true);
        if (query.trim()) void search();
        return;
      case "search-type":
        searchType = id;
        render(true);
        if (query.trim()) void search();
        return;
      case "search-more":
        await loadMoreResults();
        return;
      case "search-playlist-queue": {
        const list = searchResults[index];
        if (!list) throw new Error("This playlist is no longer available");
        await action("play", { input: list.url, all: true });
        return;
      }
      case "search-playlist-import": {
        const list = searchResults[index];
        if (!list) throw new Error("This playlist is no longer available");
        await importPlaylist(list.url);
        return;
      }
      case "new-station":
        return stationEditor();
      case "edit-station":
        return stationEditor(state.radioStations.find((r) => r.id === id));
      case "delete-station":
        return confirmAction(
          "Delete station?",
          "It is removed from your saved stations. A bot playing it keeps playing until you turn the radio off.",
          () => mutate("/api/radio-stations/" + encodeURIComponent(id), {}, "DELETE"),
        );
      case "play-station":
        await action("radio", { stationId: id });
        return;
      case "radio-off":
        await action("radio", { url: "" });
        return;
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#modal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (panelNeedsReload) {
    $("#modal-error").textContent =
      "A new panel version is available. Close this dialog and reload the panel.";
    return;
  }
  const submit = $("#modal-submit"),
    handler = modalSubmit;
  submit.disabled = true;
  $("#modal-error").textContent = "";
  try {
    await handler(new FormData(event.target));
    clearModalSecrets();
    $("#modal").close();
  } catch (error) {
    $("#modal-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "modal-form") return;
  event.preventDefault();
  if (panelNeedsReload) {
    toast("Reload the panel to use the updated controls.", true);
    return;
  }
  const form = event.target,
    data = new FormData(form),
    submit = form.querySelector("[type=submit]");
  if (form.id === "search-form") {
    query = String(data.get("query"));
    void search();
    return;
  }
  if (form.id === "playlist-filter") {
    playlistFilters.set(playlistId, {
      q: String(data.get("q") || ""),
      duplicates: data.get("duplicates") === "on",
    });
    pages.set(playlistId, 0);
    playlistSelections.delete(playlistId);
    render(true);
    return;
  }
  if (!submit) return;
  submit.disabled = true;
  try {
    if (form.id === "transfer-form") {
      const file = form.querySelector("[name=archive]").files[0];
      if (!file || file.size > 16 * 1024 * 1024)
        throw new Error("Choose an export smaller than 16 MB");
      const archive = JSON.parse(await file.text()),
        applySettings = data.get("applySettings") === "on";
      const preview = await request("/api/transfer", { archive, applySettings, preview: true });
      showModal(
        "Import settings & playlists",
        "<p>" +
          preview.playlists +
          " playlists, " +
          preview.collections +
          " collections, " +
          preview.tracks +
          " tracks and " +
          preview.stations +
          " radio stations will be added.</p><p>" +
          (applySettings
            ? "Preferences for matching bot IDs will be applied; imported schedules replace schedules for those bots."
            : "Current bot settings will be kept.") +
          "</p>",
        () => mutate("/api/transfer", { archive, applySettings }),
        "Import",
      );
    } else if (form.id === "nickname-form") {
      await action("nickname", { nickname: data.get("nickname") });
    } else if (form.id === "performance-form") {
      const settings = {
        audioProfile: data.get("audioProfile"),
        queue: {
          maxTracks: Number(data.get("maxTracks")),
          perRequester: Number(data.get("perRequester")),
          cooldownSeconds: Number(data.get("cooldownSeconds")),
        },
        avoidRecent: Number(data.get("avoidRecent")),
        idleReleaseSeconds: Number(data.get("idleReleaseSeconds")),
        failover: data.getAll("failover").filter(Boolean),
        silence: {
          enabled: data.get("silenceEnabled") === "on",
          thresholdDb: Number(data.get("silenceThreshold")),
          seconds: Number(data.get("silenceSeconds")),
          radioFailover: data.get("silenceFailover") === "on",
        },
      };
      await action("settings", { settings });
    } else if (form.id === "schedule-form") {
      await mutate("/api/schedules", scheduleData(data, bot().name));
    } else if (form.id === "account-form") {
      await mutate("/api/accounts", {
        username: data.get("username"),
        password: data.get("password"),
        role: data.get("role"),
      });
      accessData = null;
      render(true);
    } else if (form.id === "chat-access-form") {
      const assignments = (text) =>
        Object.fromEntries(
          String(text)
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const parts = line.split(/\s+/);
              if (parts.length !== 2 || !["listener", "dj", "admin"].includes(parts[1]))
                throw new Error("Use one ID and role per line.");
              return parts;
            }),
        );
      await mutate("/api/access", {
        chatAccess: {
          enabled: data.get("enabled") === "on",
          users: assignments(data.get("users")),
          groups: assignments(data.get("groups")),
        },
      });
      accessData = null;
      render(true);
    } else if (form.id === "playlist-import") {
      await mutate("/api/imports", {
        playlistId,
        input: data.get("input"),
        skipDuplicates: data.get("skipDuplicates") === "on",
      });
      form.reset();
    } else if (form.id === "quick-import") {
      await importPlaylist(String(data.get("url")));
    }
    renderedView = "";
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
document.addEventListener("input", (event) => {
  if (panelNeedsReload) return;
  const el = event.target;
  // Suggest an instance ID from the TeamSpeak name until the ID is edited by hand.
  if (el.id === "instance-nickname" && !$("#instance-id").dataset.edited)
    $("#instance-id").value = el.value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|-+$/g, "")
      .slice(0, 24);
  if (el.id === "instance-id") el.dataset.edited = "1";
  if (el.id === "search-input") {
    query = el.value;
    clearTimeout(searchTimer);
    searchController?.abort();
    searchController = null;
    if (query.trim().length >= 2) searchTimer = setTimeout(search, 650);
    else {
      searchStatus = "idle";
      searchResults = [];
      searchHasMore = false;
      if ($("#search-results")) $("#search-results").innerHTML = searchResultsMarkup();
    }
  }
  if (el.type === "range") {
    el.style.setProperty("--fill", (Number(el.value) / Number(el.max)) * 100 + "%");
    if (el.id === "volume") volumeControl.set(bot().name, Number(el.value));
    if (el.id === "seek") {
      seekGesture ??= { name: bot().name, url: bot().track?.url, changed: false };
      seekGesture.changed = true;
      seekControl.preview(seekGesture.name, seekGesture.url, Number(el.value));
      $("#elapsed").textContent = time(Number(el.value));
    }
  }
});
document.addEventListener("change", async (event) => {
  if (panelNeedsReload) return;
  const el = event.target;
  // Importing into an existing playlist needs no new name.
  if (el.id === "import-target") {
    const name = $("#import-name");
    name.required = !el.value;
    name.closest(".import-new").hidden = !!el.value;
    return;
  }
  try {
    if (el.dataset.control === "select-track") {
      const selected = selectionFor(playlist());
      if (selected.allMatching) {
        selected.excluded = el.checked
          ? selected.excluded.filter((i) => i !== Number(el.dataset.index))
          : [...new Set([...selected.excluded, Number(el.dataset.index)])];
      } else
        selected.indices = el.checked
          ? [...new Set([...selected.indices, Number(el.dataset.index)])]
          : selected.indices.filter((i) => i !== Number(el.dataset.index));
      render(true);
      return;
    }
    if (el.id === "volume") volumeControl.set(bot().name, Number(el.value), true);
    if (el.id === "seek") {
      const target = seekGesture ?? { name: bot().name, url: bot().track?.url };
      const seconds = Number(el.value);
      seekGesture = null;
      seekControl.set(target.name, target.url, seconds);
    }
    if (el.id === "instance-platform") {
      syncPlatformFields();
      return;
    }
    if (el.dataset.control === "channel") await action("channel", { channelId: el.value });
    if (el.dataset.control === "repeat") await action("loop", { mode: el.value });
    if (el.dataset.control === "default") await action("default", { playlistId: el.value || null });
  } catch (error) {
    toast(error.message, true);
  } finally {
    sliderActive = false;
    render();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (event.target.type === "range") sliderActive = event.target.id;
  if (event.target.id === "seek") {
    seekGesture = { name: bot().name, url: bot().track?.url, changed: false };
  }
});
document.addEventListener("pointerup", () => {
  if (seekGesture && !seekGesture.changed) {
    seekControl.cancelPreview(seekGesture.name);
    seekGesture = null;
  }
  sliderActive = false;
  updateProgress();
});
document.addEventListener("pointercancel", () => {
  if (seekGesture) seekControl.cancelPreview(seekGesture.name);
  seekGesture = null;
  sliderActive = false;
  render();
});
document.addEventListener("focusout", () => setTimeout(() => render(), 0));
document.addEventListener(
  "error",
  (event) => {
    if (event.target.tagName === "IMG") event.target.classList.add("failed");
  },
  true,
);
document.addEventListener("dragstart", (event) => {
  const row = event.target.closest("tr[draggable=true]");
  if (!row) return;
  dragging = {
    scope: row.dataset.scope,
    index: Number(row.dataset.index),
    expected: orderData(row.dataset.scope),
  };
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.index);
});
document.addEventListener("dragover", (event) => {
  const row = event.target.closest("tr[draggable=true]");
  if (!row || !dragging || row.dataset.scope !== dragging.scope) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  row.classList.add("drag-over");
});
document.addEventListener("drop", async (event) => {
  const row = event.target.closest("tr[draggable=true]"),
    drag = dragging;
  if (!row || !drag || row.dataset.scope !== drag.scope) return;
  event.preventDefault();
  dragging = null;
  try {
    await moveTrack(drag.scope, drag.index + 1, Number(row.dataset.index) + 1, drag.expected);
  } catch (error) {
    toast(error.message, true);
  }
  render(true);
});
document.addEventListener("dragend", () => {
  dragging = null;
  document
    .querySelectorAll(".dragging,.drag-over")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#sidebar").classList.remove("open");
    $('[data-action="menu"]').setAttribute("aria-expanded", "false");
    if (!$("#switcher-menu").hidden) {
      toggleSwitcher(false);
      $("#switcher-button").focus();
    }
  }
  // Arrow keys move between instances while the switcher is open.
  if (
    ["ArrowDown", "ArrowUp"].includes(event.key) &&
    $("#switcher-menu").contains(document.activeElement)
  ) {
    const items = [...$("#switcher-menu").querySelectorAll(".switcher-item")],
      at = items.indexOf(document.activeElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    event.preventDefault();
  }
});
connection.addEventListener("updateavailable", () => {
  panelNeedsReload = true;
  notifications.add(
    "A new panel version is available. Reload to continue; unsubmitted form edits will be cleared.",
    false,
    undefined,
    undefined,
    "panel-update",
  );
  if ($("#modal").open)
    $("#modal-error").textContent =
      "A new panel version is available. Close this dialog and reload the panel.";
});
connection.addEventListener("state", (event) => {
  for (const b of event.detail.bots)
    if (volumeControl.get(b.name) === undefined && requestedVolumes.get(b.name) === b.volume)
      requestedVolumes.delete(b.name);
  state = {
    ...event.detail,
    playlists: event.detail.playlists.map((p) => ({ ...p, tracks: p.tracks || [] })),
  };
  receivedAt = Date.now();
  for (const [id, detail] of playlistCache)
    if (state.playlists.find((p) => p.id === id)?.version !== detail.version)
      playlistCache.delete(id);
  renderBackground();
  if (lastRenderBot !== bot()?.name) {
    lastRenderBot = bot()?.name;
    renderedView = "";
  }
  render();
});
connection.addEventListener("playback_progress", (event) => {
  for (const b of event.detail.bots)
    if (volumeControl.get(b.name) === undefined && requestedVolumes.get(b.name) === b.volume)
      requestedVolumes.delete(b.name);
  if (!state) return;
  state = { ...state, bots: event.detail.bots, system: event.detail.system };
  receivedAt = Date.now();
  updateProgress();
  renderBackground();
});
connection.addEventListener("online", () => {
  $("#offline-banner").hidden = true;
});
connection.addEventListener("offline", () => {
  notifications.add(
    "Panel connection lost. Reconnecting automatically?",
    true,
    undefined,
    undefined,
    "panel-offline",
  );
  $("#connection").innerHTML = '<span class="status-dot warning"></span>Panel disconnected';
  renderedChrome = "";
});
window.addEventListener("hashchange", navigate);
window.addEventListener("resize", () => {
  renderedDock = "";
  render();
});
document.querySelectorAll("[data-icon]").forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});
navigate();
connection.start();
setInterval(updateProgress, 100);
