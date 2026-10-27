/** Radio view markup. The controller supplies live state on each render. */
import { button, escape as e, empty, heading, iconButton as ib, icon } from "../ui/components.js";

export function createRadioViews(getContext) {
  function radioView(b) {
    const { state, paused } = getContext();
    const onAir = b.radio && !b.track && !paused(b);
    const status = !b.radio
      ? ""
      : '<section class="card card-padding radio-now"><div class="bot-avatar">' +
        icon("radio") +
        '</div><div><div class="eyebrow">' +
        (onAir ? "ON THE AIR" : b.track ? "PLAYS WHEN THE QUEUE IS EMPTY" : "RADIO PAUSED") +
        "</div><h2>" +
        e(b.radio.name) +
        '</h2><p class="small subtle">' +
        e(b.radioTitle ? "♪ " + b.radioTitle : b.radio.url) +
        "</p></div>" +
        button("Turn radio off", "stop", "radio-off", "", "secondary") +
        "</section>";
    const stations = state.radioStations
      .map((r) => {
        const active = b.radio?.url === r.url;
        return (
          '<article class="card station-card ' +
          (active ? "active" : "") +
          '"><div class="station-head"><div class="bot-avatar">' +
          icon("radio") +
          '</div><div class="station-copy"><h3>' +
          e(r.name) +
          '</h3><p title="' +
          e(r.url) +
          '">' +
          e(r.url) +
          "</p></div>" +
          (active ? '<span class="tag green">On air</span>' : "") +
          '</div><div class="result-actions">' +
          (active
            ? button("Turn off", "stop", "radio-off", "", "secondary")
            : button("Tune in", "play", "play-station", 'data-id="' + e(r.id) + '"')) +
          ib("edit", "Edit station", "edit-station", 'data-id="' + e(r.id) + '"') +
          ib("trash", "Delete station", "delete-station", 'data-id="' + e(r.id) + '"', "danger") +
          "</div></article>"
        );
      })
      .join("");
    return (
      heading(
        "Tune into something good.",
        "Save live streams for this server. A station plays whenever the queue is empty.",
        button("Add station", "plus", "new-station"),
      ) +
      status +
      '<div class="section-heading"><h2>Your stations <span class="count-badge">' +
      state.radioStations.length +
      "</span></h2></div>" +
      (state.radioStations.length
        ? '<div class="station-grid">' + stations + "</div>"
        : empty(
            "No stations yet",
            "Add an HTTP, Icecast or SHOUTcast stream to get started.",
            button("Add station", "plus", "new-station", "", "secondary"),
          )) +
      '<p class="small subtle">Tuning in replaces the idle playlist right away. Songs people request still play first. In chat: <code>' +
      e(state.commandPrefix) +
      "radio &lt;station&gt;</code></p>"
    );
  }

  return { radioView };
}
