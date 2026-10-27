import { art, escape as e, empty, heading } from "../ui/components.js";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const options = (items, value, placeholder = "None") =>
  '<option value="">' +
  placeholder +
  "</option>" +
  items
    .map(
      ([id, name]) =>
        '<option value="' +
        e(id) +
        '" ' +
        (id === value ? "selected" : "") +
        ">" +
        e(name) +
        "</option>",
    )
    .join("");
export function scheduleFields(
  state,
  b,
  schedule = {
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "08:00",
    end: "18:00",
    timezone: "Asia/Colombo",
    enabled: true,
  },
) {
  return (
    '<div class="operations-fields"><label>Playlist<select class="field" name="playlistId" required>' +
    options(
      state.playlists.filter((p) => p.trackCount > 0).map((p) => [p.id, p.name]),
      schedule.playlistId,
      "Choose a playlist",
    ) +
    '</select></label><label>Time zone<input class="field" name="timezone" value="' +
    e(schedule.timezone) +
    '" required placeholder="Asia/Colombo"></label><label>Start<input class="field" type="time" name="start" value="' +
    e(schedule.start) +
    '" required></label><label>End<input class="field" type="time" name="end" value="' +
    e(schedule.end) +
    '" required></label></div><fieldset class="day-picker"><legend>Days the schedule starts</legend>' +
    days
      .map(
        (day, i) =>
          '<label class="check-label"><input type="checkbox" name="days" value="' +
          i +
          '" ' +
          (schedule.days.includes(i) ? "checked" : "") +
          ">" +
          day.slice(0, 3) +
          "</label>",
      )
      .join("") +
    '</fieldset><label class="check-label"><input type="checkbox" name="enabled" ' +
    (schedule.enabled ? "checked" : "") +
    "> Enabled</label>"
  );
}
export function scheduleData(data, bot) {
  return {
    bot,
    playlistId: data.get("playlistId"),
    timezone: data.get("timezone"),
    start: data.get("start"),
    end: data.get("end"),
    days: data.getAll("days").map(Number),
    enabled: data.get("enabled") === "on",
  };
}
export function operationsMarkup(state, b) {
  const s = b.settings,
    schedules = state.schedules.filter((item) => item.bot === b.name);
  const radios = state.radioStations.map((r) => [r.id, r.name]);
  return (
    '<section class="card card-padding operations-card" data-min-role="dj"><h2>Performance & requests</h2><p class="small subtle">High quality keeps the existing encoder settings. Balanced uses less encoding work. Normalization remains a separate control.</p><form id="performance-form"><div class="operations-fields"><label>Audio profile<select class="field" name="audioProfile"><option value="high" ' +
    (s.audioProfile === "high" ? "selected" : "") +
    '>High quality</option><option value="balanced" ' +
    (s.audioProfile === "balanced" ? "selected" : "") +
    '>Balanced</option></select></label><label>Total queue limit<input class="field" name="maxTracks" type="number" min="1" max="5000" value="' +
    s.queue.maxTracks +
    '" required></label><label>Tracks per listener<input class="field" name="perRequester" type="number" min="1" max="5000" value="' +
    s.queue.perRequester +
    '" required></label><label>Request cooldown (seconds)<input class="field" name="cooldownSeconds" type="number" min="0" max="300" value="' +
    s.queue.cooldownSeconds +
    '" required></label><label>Avoid recent idle tracks<input class="field" name="avoidRecent" type="number" min="0" max="100" value="' +
    s.avoidRecent +
    '" required></label><label>Release paused audio after (seconds)<input class="field" name="idleReleaseSeconds" type="number" min="15" max="3600" value="' +
    s.idleReleaseSeconds +
    '" required></label></div><h3>Silence monitoring</h3><label class="check-label"><input type="checkbox" name="silenceEnabled" ' +
    (s.silence?.enabled ? "checked" : "") +
    '> Alert on sustained source silence</label><div class="operations-fields"><label>Threshold (dB)<input class="field" type="number" name="silenceThreshold" min="-90" max="-20" value="' +
    (s.silence?.thresholdDb ?? -55) +
    '" required></label><label>Duration (seconds)<input class="field" type="number" name="silenceSeconds" min="5" max="600" value="' +
    (s.silence?.seconds ?? 30) +
    '" required></label></div><label class="check-label"><input type="checkbox" name="silenceFailover" ' +
    (s.silence?.radioFailover ? "checked" : "") +
    '> Switch silent radio to the next fallback station</label><p class="small subtle">Muted and paused playback does not trigger silence alerts. Alerts appear in Notifications.</p><h3>Radio fallback order</h3><p class="small subtle">After repeated stream failures, try these stations in order. User requests still play first.</p><div class="operations-fields">' +
    Array.from(
      { length: Math.min(20, Math.max(3, s.failover.length + 1)) },
      (_, i) =>
        "<label>Fallback " +
        (i + 1) +
        '<select class="field" name="failover">' +
        options(radios, s.failover[i]) +
        "</select></label>",
    ).join("") +
    '</div><button class="button primary" type="submit">Save settings</button></form></section>' +
    '<section class="card card-padding operations-card" data-min-role="dj"><h2>Playlist schedules</h2><p class="small subtle">Schedules choose the idle playlist without interrupting user requests. Radio takes priority while enabled. Overnight schedules belong to the day they start.</p>' +
    (b.activeSchedule
      ? '<p class="tag green">Active: ' +
        e(state.playlists.find((p) => p.id === b.activeSchedule.playlistId)?.name || "Playlist") +
        "</p>"
      : "") +
    '<div class="schedule-list">' +
    schedules
      .map(
        (s) =>
          '<div class="schedule-row"><div><strong>' +
          e(state.playlists.find((p) => p.id === s.playlistId)?.name || "Removed playlist") +
          '</strong><p class="small subtle">' +
          s.days.map((d) => days[d].slice(0, 3)).join(", ") +
          " · " +
          e(s.start) +
          "–" +
          e(s.end) +
          " · " +
          e(s.timezone) +
          " · " +
          (s.enabled ? "Enabled" : "Disabled") +
          '</p></div><div class="row-actions"><button class="button secondary" data-action="edit-schedule" data-id="' +
          e(s.id) +
          '">Edit</button><button class="icon-button danger" aria-label="Delete schedule" data-action="delete-schedule" data-id="' +
          e(s.id) +
          '">×</button></div></div>',
      )
      .join("") +
    '</div><h3>Add schedule</h3><form id="schedule-form">' +
    scheduleFields(state, b) +
    '<button class="button primary" type="submit">Add schedule</button></form></section>'
  );
}
export function accessMarkup(access) {
  if (!access)
    return '<section class="card card-padding operations-card" data-min-role="admin"><h2>Access & roles</h2><p class="small subtle">Loading accounts…</p></section>';
  const lines = (values) =>
    Object.entries(values)
      .map(([id, role]) => id + " " + role)
      .join("\n");
  return (
    '<section class="card card-padding operations-card" data-min-role="admin"><h2>Access & roles</h2><p class="small subtle">Listeners request tracks and vote to skip. DJs manage music and schedules. Administrators manage accounts and bot instances.</p><div class="account-list"><p>owner <span class="tag green">Administrator · panel password</span></p>' +
    access.accounts
      .map(
        (a) =>
          '<div class="schedule-row"><span>' +
          e(a.username) +
          ' <span class="tag">' +
          e(a.role) +
          '</span></span><button class="button secondary" data-action="delete-account" data-id="' +
          e(a.username) +
          '">Remove account</button></div>',
      )
      .join("") +
    '</div><form id="account-form"><h3>Add or update an account</h3><div class="operations-fields"><label>Username<input class="field" name="username" required pattern="[a-z][a-z0-9_-]{1,31}" maxlength="32" autocomplete="off"></label><label>Role<select class="field" name="role"><option value="listener">Listener</option><option value="dj">DJ</option><option value="admin">Administrator</option></select></label><label>Password<input class="field" name="password" type="password" minlength="10" maxlength="200" autocomplete="new-password" placeholder="Required for new accounts"></label></div><p class="small subtle">For an existing account, leave the password blank to change its role. Saving signs that account out.</p><button class="button primary" type="submit">Save account</button></form><form id="chat-access-form"><h3>Chat roles</h3><label class="check-label"><input type="checkbox" name="enabled" ' +
    (access.chatAccess.enabled ? "checked" : "") +
    '> Enforce listener / DJ / administrator roles in chat</label><p class="small subtle">For TeamSpeak, enabling this makes unlisted clients listeners. Discord always checks server permissions and these role assignments. Existing configured bot admins stay administrators. For Discord client and role IDs, prefix the ID with discord: (for example discord:123456789012345678 dj). Discord server managers remain administrators. Enter one unique ID or server group ID and role per line, such as “123 dj”.</p><div class="operations-fields"><label>Client unique IDs<textarea class="field" name="users" rows="4">' +
    e(lines(access.chatAccess.users)) +
    '</textarea></label><label>Server group / Discord role IDs<textarea class="field" name="groups" rows="4">' +
    e(lines(access.chatAccess.groups)) +
    '</textarea></label></div><button class="button primary" type="submit">Save chat roles</button></form></section>'
  );
}
export function historyMarkup(b, entries) {
  if (!entries) return heading("Playback history", "Loading recent plays…");
  const requesters = new Map();
  for (const h of entries) {
    const name = h.track.auto ? "Idle playlist" : h.track.requestedBy || "Web / bot";
    requesters.set(name, (requesters.get(name) || 0) + 1);
  }
  return (
    heading(
      "Playback history",
      "Recent plays for " + b.nickname + ". Up to 200 entries are retained across restarts.",
    ) +
    '<div class="history-stats">' +
    [...requesters]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => '<span class="tag">' + e(name) + " · " + count + " plays</span>")
      .join("") +
    "</div>" +
    (!entries.length
      ? empty("A fresh start", "Played tracks will appear here.")
      : '<div class="table-wrap"><table class="track-table history-table"><thead><tr><th>Track</th><th>Played</th><th>Status</th><th>Request</th></tr></thead><tbody>' +
        entries
          .map(
            (h) =>
              '<tr><td><div class="track-cell">' +
              art(h.track, "track-art") +
              '<div><span class="track-title">' +
              e(h.track.title) +
              '</span><span class="track-artist">' +
              e(h.track.requestedBy || "Idle playlist") +
              "</span></div></div></td><td>" +
              e(new Date(h.startedAt).toLocaleString()) +
              "</td><td>" +
              e(h.error ? "Failed" : h.endedAt ? "Finished / skipped" : "Started") +
              '</td><td><button class="button secondary" data-action="history-enqueue" data-id="' +
              e(h.id) +
              '">Enqueue</button></td></tr>',
          )
          .join("") +
        "</tbody></table></div>")
  );
}
