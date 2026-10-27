/** Settings view markup. The controller supplies live state on each render. */
import { botCard, button, commands, escape as e, heading, icon } from "../ui/components.js";
import { discordConnectionCard, platformName } from "../ui/platforms.js";

export function createSettingsViews(getContext) {
  function healthCard(b) {
    return (
      '<section class="card card-padding health-card"><div class="card-title"><h2>Bot health</h2><span class="tag green">Live</span></div><label for="audio-level" class="field-label">Output level (dBFS)</label><meter id="audio-level" class="audio-meter" min="-60" max="0" low="-48" high="-6" optimum="-18" value="-60">-60 dB</meter><div id="health-values"></div><div class="setting-line"><div>Prepare the next track<p>Prebuffer one upcoming song during the last 15 seconds. Uses extra CPU and memory.</p></div><button class="switch" data-action="prebuffer" role="switch" aria-label="Prepare next track" aria-checked="' +
      !!b.health?.prebufferEnabled +
      '"></button></div><div id="prebuffer-status" class="small subtle"></div></section>'
    );
  }

  function settings(b) {
    const { ensureAccess, auditData, loadManagement, instancesCard, state, trackCount } =
      getContext();
    ensureAccess();
    if (!auditData) void loadManagement();
    return (
      heading(
        "Keep your channel in tune.",
        "Manage your bots, choose their channels, and dial in the sound.",
      ) +
      instancesCard(b) +
      discordConnectionCard(b) +
      '<section class="card import-card"><h3>Bot name</h3><p>This fixed name is shown in ' +
      platformName(b) +
      '. It stays the same when songs change.</p><form id="nickname-form" class="inline-form"><label class="field-label" for="bot-nickname" style="align-self:center;margin:0">' +
      platformName(b) +
      ' name</label><input class="field" id="bot-nickname" name="nickname" required maxlength="30" value="' +
      e(b.nickname || "radiospeak") +
      '" placeholder="radiospeak"><button class="button primary" type="submit">' +
      icon("check") +
      "Save name</button></form></section>" +
      healthCard(b) +
      '<div class="settings-grid">' +
      botCard(b) +
      '<section class="card card-padding"><div class="card-title"><h2>Playback & output</h2>' +
      icon("headphones") +
      '</div><div class="setting-line"><div>Shuffle queue<p>Randomize queued and newly added tracks</p></div><button class="switch" role="switch" aria-label="Shuffle queue" aria-checked="' +
      b.shuffle +
      '" data-action="shuffle"></button></div><div class="setting-line"><div>Repeat mode<p>Applies to tracks requested by users</p></div><select data-control="repeat" aria-label="Repeat mode">' +
      ["off", "all", "one"]
        .map(
          (m) =>
            '<option value="' +
            m +
            '" ' +
            (b.loop === m ? "selected" : "") +
            ">" +
            { off: "Off", all: "Repeat all", one: "Repeat one" }[m] +
            "</option>",
        )
        .join("") +
      '</select></div><div class="setting-line"><div>Default idle playlist<p>Used when the queue is empty and radio is off</p></div><select data-control="default" aria-label="Default idle playlist"><option value="">None</option>' +
      state.playlists
        .map(
          (p) =>
            '<option value="' +
            e(p.id) +
            '" ' +
            (state.defaults[b.name] === p.id ? "selected" : "") +
            (!trackCount(p) ? " disabled" : "") +
            ">" +
            e(p.name) +
            "</option>",
        )
        .join("") +
      '</select></div><dl class="detail-list"><dt>Output</dt><dd>' +
      platformName(b) +
      " / Opus</dd><dt>Bot gain</dt><dd>" +
      b.volume +
      "%</dd><dt>Listener auto-pause</dt><dd>" +
      (b.autoPaused ? "Paused · empty channel" : "Ready") +
      "</dd><dt>Radio fallback</dt><dd>" +
      e(b.radio?.name || "Off") +
      "</dd></dl>" +
      (b.radio ? button("Turn radio off", "stop", "radio-off", "", "secondary") : "") +
      "</section>" +
      commands(state.commandPrefix, b.platform) +
      '<section class="card card-padding"><h3>Your listeners</h3><p class="small subtle">People in the current channel who can hear the bot.</p>' +
      (b.listeners.length
        ? b.listeners
            .map(
              (n) =>
                '<div class="listeners-row"><span>' +
                e(n) +
                '</span><span class="tag green">Listening</span></div>',
            )
            .join("")
        : '<p class="small subtle">No listeners in this channel yet.</p>') +
      "</section></div>"
    );
  }

  return { healthCard, settings };
}
