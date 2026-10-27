import { escape as e, icon } from "../ui/components.js";

const ACTIVE_IMPORT = ["queued", "resolving"];
/** Icon and label for each kind of notification; the kind also sets its colour. */
const KINDS = {
  success: ["check", "Done"],
  error: ["alert", "Needs attention"],
  warning: ["alert", "Warning"],
  import: ["download", "Import"],
  progress: ["download", "Importing"],
  update: ["repeat", "Update"],
};
function kindOf(item) {
  if (item.job)
    return item.job.status === "failed"
      ? "error"
      : ACTIVE_IMPORT.includes(item.job.status)
        ? "progress"
        : "import";
  const key = item.key || "";
  if (/^(talk|recovery|silence):/.test(key) || key === "panel-offline") return "warning";
  if (key === "panel-update") return "update";
  return item.error ? "error" : "success";
}
function ago(at) {
  const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (seconds < 45) return "Just now";
  if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function dayOf(at) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  return days <= 0 ? "TODAY" : days === 1 ? "YESTERDAY" : "EARLIER";
}
const meta = (kind, at, label = KINDS[kind][1]) =>
  '<div class="nc-meta"><span class="nc-kind">' +
  e(label) +
  '</span><time datetime="' +
  e(at) +
  '" title="' +
  e(new Date(at).toLocaleString()) +
  '">' +
  e(ago(at)) +
  "</time></div>";

/** Keeps notifications out of the workspace without opening or moving focus. */
export class NotificationCenter {
  constructor() {
    this.items = [];
    this.read = {};
    this.jobs = [];
    this.key = "";
    this.signature = "";
    this.seen = new Map();
    this.filter = "all";
    this.button = document.querySelector("#notification-button");
    this.panel = document.querySelector("#notification-panel");
    this.container = document.querySelector("#notification-center");
    this.button.innerHTML = icon("bell") + '<span class="notification-badge" hidden></span>';
    this.badge = this.button.querySelector(".notification-badge");
    // New notifications also pop up under the bell for a few seconds. #toast stays the screen-reader announcement.
    this.toasts = document.createElement("div");
    this.toasts.className = "notification-toasts";
    this.toasts.setAttribute("aria-label", "New notifications");
    document.body.append(this.toasts);
    this.jobStatus = null;
    this.toasts.addEventListener("click", (event) => {
      const toast = event.target.closest(".notification-toast");
      if (!toast) return;
      if (event.target.closest("[data-toast-close]")) {
        this.dismiss(toast);
        return;
      }
      if (event.target.closest("[data-action]")) {
        this.dismiss(toast);
        return;
      }
      // Anywhere else on the card opens the full list.
      this.toasts.replaceChildren();
      if (this.panel.hidden) this.toggle();
    });
    this.button.addEventListener("click", () => this.toggle());
    document.addEventListener("click", (event) => {
      // Keep the original event path: a mark-read action can replace its own DOM.
      const path = event.composedPath();
      if (!path.includes(this.container) && !path.includes(this.toasts)) this.close();
      if (event.target.closest('[data-action="notifications-read"]')) {
        for (const item of this.entries()) this.read[item.id] = item.signature;
        this.save();
        this.render();
        return;
      }
      const tab = event.target.closest("[data-nc-filter]");
      if (tab && this.panel.contains(tab)) {
        this.filter = tab.dataset.ncFilter;
        this.render();
        this.panel.querySelector('[data-nc-filter="' + this.filter + '"]')?.focus();
        return;
      }
      // Clicking an unread notification (not one of its buttons) marks it read.
      const row = event.target.closest(".nc-item[data-id]");
      if (row && this.panel.contains(row) && !event.target.closest("button,a,summary")) {
        const item = this.entries().find((i) => i.id === row.dataset.id);
        if (item && this.read[item.id] !== item.signature) {
          this.read[item.id] = item.signature;
          this.save();
          this.render();
        }
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.hidden) {
        this.close();
        this.button.focus();
      }
    });
  }
  account(username = "owner") {
    const key = "radiospeak.notifications." + username;
    if (this.key === key) return;
    this.key = key;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      this.items = Array.isArray(saved.items) ? saved.items.slice(0, 80) : [];
      this.read = saved.read || {};
    } catch {
      this.items = [];
      this.read = {};
    }
    this.render();
  }
  save() {
    try {
      const ids = new Set(this.entries().map((i) => i.id));
      this.read = Object.fromEntries(Object.entries(this.read).filter(([id]) => ids.has(id)));
      localStorage.setItem(
        this.key,
        JSON.stringify({ items: this.items.slice(0, 80), read: this.read }),
      );
    } catch {}
  }
  add(message, error = false, undoToken, undoBot, key) {
    if (
      key &&
      (this.seen.get(key) === message ||
        this.items.some((item) => item.key === key && item.message === message))
    )
      return;
    if (key) this.seen.set(key, message);
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
    const id =
      globalThis.crypto?.randomUUID?.() ??
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    this.items.unshift({
      id,
      signature: id,
      message,
      error,
      key,
      at: new Date().toISOString(),
      undoToken,
      undoBot,
      expires: Date.now() + 10000,
    });
    this.items.length = Math.min(80, this.items.length);
    document.querySelector("#toast").textContent = message;
    this.save();
    this.render();
    this.popup({ message, error, undoToken, undoBot, key });
  }
  /** Shows a notification card under the bell; hovering or focusing it holds it open. */
  popup({ message, error = false, undoToken, undoBot, key }) {
    if (!this.panel.hidden) return; // already visible in the open list
    const kind = kindOf({ error, key }),
      life = undoToken ? 10000 : error ? 8000 : 5000;
    const toast = document.createElement("article");
    toast.className = "notification-toast kind-" + kind + (error ? " error" : "");
    toast.innerHTML =
      '<span class="nc-icon">' +
      icon(KINDS[kind][0]) +
      '</span><div class="nc-body"><p>' +
      e(message) +
      "</p>" +
      meta(kind, new Date().toISOString()) +
      "</div>" +
      (undoToken
        ? '<button type="button" class="button secondary" data-action="undo" data-token="' +
          e(undoToken) +
          '" data-bot="' +
          e(undoBot) +
          '">Undo</button>'
        : "") +
      '<button type="button" class="icon-button" data-toast-close aria-label="Dismiss notification" title="Dismiss">' +
      icon("close") +
      "</button>" +
      '<span class="toast-timer" aria-hidden="true" style="animation-duration:' +
      life +
      'ms"></span>';
    this.toasts.prepend(toast);
    while (this.toasts.children.length > 3) this.toasts.lastElementChild.remove();
    let remaining = life,
      timer = null,
      started = 0;
    const run = () => {
      if (timer || !toast.isConnected) return;
      toast.classList.remove("held");
      started = Date.now();
      timer = setTimeout(() => this.dismiss(toast), remaining);
      timer.unref?.();
    };
    const hold = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      toast.classList.add("held");
      remaining = Math.max(1500, remaining - (Date.now() - started));
    };
    toast.addEventListener("mouseenter", hold);
    toast.addEventListener("focusin", hold);
    toast.addEventListener("mouseleave", run);
    toast.addEventListener("focusout", run);
    run();
    this.button.classList.remove("ringing");
    void this.button.offsetWidth;
    this.button.classList.add("ringing");
  }
  dismiss(toast) {
    if (toast.classList.contains("leaving")) return;
    toast.classList.add("leaving");
    const timer = setTimeout(() => toast.remove(), 200);
    timer.unref?.();
  }
  update(state) {
    this.account(state.viewer?.username);
    this.jobs = state.imports || [];
    // Pop up imports that finish while the panel is open (not ones already finished at load).
    const statuses = new Map(this.jobs.map((job) => [job.id, job.status]));
    if (this.jobStatus)
      for (const job of this.jobs) {
        const before = this.jobStatus.get(job.id);
        if (ACTIVE_IMPORT.includes(before) && !ACTIVE_IMPORT.includes(job.status))
          this.popup({
            message:
              job.status === "completed"
                ? "Import finished: " + job.playlistName + " · " + job.added + " added"
                : "Import " + job.status + ": " + job.playlistName,
            error: job.status === "failed",
          });
      }
    this.jobStatus = statuses;
    for (const bot of state.bots || []) {
      const h = bot.health || {};
      if (h.silenceAlert)
        this.add(
          bot.nickname + ": " + h.silenceAlert.message,
          true,
          undefined,
          undefined,
          "silence:" + bot.name + ":" + h.silenceAlert.id,
        );
      const recovery = h.retrying
        ? "Retrying " + (bot.track?.title || "audio") + " from " + bot.elapsed + " seconds"
        : bot.connectionPaused && bot.track
          ? (bot.platform === "discord" ? "Discord" : "TeamSpeak") +
            " is unavailable. Your track and queue are held."
          : "";
      if (recovery)
        this.add(
          bot.nickname + ": " + recovery,
          true,
          undefined,
          undefined,
          "recovery:" + bot.name,
        );
      else this.seen.delete("recovery:" + bot.name);
      if (bot.connectionError)
        this.add(
          bot.nickname + ": " + bot.connectionError,
          true,
          undefined,
          undefined,
          "connection:" + bot.name + ":" + bot.connectionError,
        );
      if (bot.talkBlocked)
        this.add(
          bot.nickname +
            ": TeamSpeak talk permission is blocked. Required talk power: " +
            bot.talkBlocked.needed +
            "; bot talk power: " +
            bot.talkBlocked.have +
            ". Assign a permanent server or channel group with enough talk power.",
          true,
          undefined,
          undefined,
          "talk:" + bot.name + ":" + bot.talkBlocked.needed + ":" + bot.talkBlocked.have,
        );
    }
    this.render();
  }
  entries() {
    return [
      ...this.jobs.map((job) => ({
        id: "import:" + job.id,
        signature: job.status + ":" + (job.hasMore ? "more" : "") + ":" + job.added,
        job,
        at: job.createdAt,
      })),
      ...this.items,
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }
  toggle() {
    this.panel.hidden = !this.panel.hidden;
    this.button.setAttribute("aria-expanded", String(!this.panel.hidden));
    if (!this.panel.hidden) {
      this.toasts.replaceChildren();
      this.render();
    }
  }
  close() {
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }
  #job(item, unread) {
    const job = item.job,
      active = ACTIVE_IMPORT.includes(job.status),
      kind = kindOf(item);
    const action = (name, label, ic) =>
      '<button class="button secondary" data-action="' +
      name +
      '" data-id="' +
      e(job.id) +
      '">' +
      icon(ic) +
      label +
      "</button>";
    const percent = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
    const label = active
      ? job.status === "queued"
        ? "Waiting to start"
        : "Importing " + job.processed + (job.total ? " of " + job.total : "")
      : {
          completed: "Import complete",
          failed: "Import failed",
          cancelled: "Import cancelled",
          interrupted: "Import interrupted",
        }[job.status] || "Import " + job.status;
    return (
      '<article class="nc-item kind-' +
      kind +
      (unread ? " unread" : "") +
      '" data-id="' +
      e(item.id) +
      '"><span class="nc-icon">' +
      icon(KINDS[kind][0]) +
      '</span><div class="nc-body">' +
      (unread ? '<span class="sr-only">Unread. </span>' : "") +
      "<p><strong>" +
      e(job.playlistName) +
      "</strong></p>" +
      (active
        ? '<div class="nc-progress' +
          (job.total ? "" : " indeterminate") +
          '" role="progressbar" aria-label="Playlist import progress"' +
          (job.total
            ? ' aria-valuemin="0" aria-valuemax="' +
              job.total +
              '" aria-valuenow="' +
              job.processed +
              '"'
            : "") +
          '><span style="width:' +
          (job.total ? percent : 35) +
          '%"></span></div>'
        : "") +
      '<div class="nc-chips"><span class="good">' +
      job.added +
      " added</span>" +
      (job.duplicates ? "<span>" + job.duplicates + " duplicates</span>" : "") +
      (job.failed ? '<span class="bad">' + job.failed + " unavailable</span>" : "") +
      "</div>" +
      (job.errors?.length
        ? '<details class="nc-issues"><summary>' +
          job.errors.length +
          " import issue" +
          (job.errors.length === 1 ? "" : "s") +
          "</summary><ul>" +
          job.errors.map((error) => "<li>" + e(error) + "</li>").join("") +
          "</ul></details>"
        : "") +
      meta(kind, item.at, label) +
      '<div class="nc-actions">' +
      (active
        ? action("cancel-import", "Cancel", "close")
        : ["interrupted", "cancelled", "failed"].includes(job.status) || job.hasMore
          ? action("resume-import", job.hasMore ? "Continue next batch" : "Resume", "repeat")
          : "") +
      (!active && job.failed ? action("retry-import", "Retry unavailable", "repeat") : "") +
      "</div>" +
      "</div>" +
      (unread ? '<span class="nc-dot" aria-hidden="true"></span>' : "") +
      "</article>"
    );
  }
  #message(item, unread) {
    const kind = kindOf(item),
      undo = item.undoToken && item.expires > Date.now();
    const actions =
      (item.key === "panel-update"
        ? '<button class="button secondary" data-action="reload-panel">' +
          icon("repeat") +
          "Reload panel</button>"
        : "") +
      (undo
        ? '<button class="button secondary" data-action="undo" data-token="' +
          e(item.undoToken) +
          '" data-bot="' +
          e(item.undoBot) +
          '">Undo</button>'
        : "");
    return (
      '<article class="nc-item kind-' +
      kind +
      (unread ? " unread" : "") +
      '" data-id="' +
      e(item.id) +
      '"><span class="nc-icon">' +
      icon(KINDS[kind][0]) +
      '</span><div class="nc-body">' +
      (unread ? '<span class="sr-only">Unread. </span>' : "") +
      "<p>" +
      e(item.message) +
      "</p>" +
      meta(kind, item.at) +
      (actions ? '<div class="nc-actions">' + actions + "</div>" : "") +
      "</div>" +
      (unread ? '<span class="nc-dot" aria-hidden="true"></span>' : "") +
      "</article>"
    );
  }
  render() {
    const entries = this.entries(),
      isUnread = (i) => this.read[i.id] !== i.signature,
      unread = entries.filter(isUnread).length;
    // Never detach an icon/badge between pointerdown and click during SSE updates.
    const count = String(Math.min(99, unread));
    if (this.badge.textContent !== count) this.badge.textContent = count;
    this.badge.hidden = !unread;
    this.button.setAttribute(
      "aria-label",
      "Notifications" + (unread ? ", " + unread + " unread" : ""),
    );
    const alerts = entries.filter((i) => ["error", "warning"].includes(kindOf(i)));
    const shown =
      this.filter === "unread"
        ? entries.filter(isUnread)
        : this.filter === "alerts"
          ? alerts
          : entries;
    // Relative times ("2 min ago") refresh at most twice a minute.
    const signature = JSON.stringify([
      entries,
      this.read,
      this.filter,
      Math.floor(Date.now() / 30000),
      this.items
        .filter((item) => item.undoToken && item.expires > Date.now())
        .map((item) => item.id),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const focused = this.panel.contains(document.activeElement)
      ? { ...document.activeElement.dataset }
      : null;
    const scrollTop = this.panel.querySelector(".notification-list")?.scrollTop || 0;
    const tab = (id, label, n) =>
      '<button type="button" data-nc-filter="' +
      id +
      '" aria-pressed="' +
      (this.filter === id) +
      '">' +
      label +
      (n ? "<b>" + Math.min(99, n) + "</b>" : "") +
      "</button>";
    let group = "";
    const list = shown
      .map((item) => {
        const day = dayOf(item.at),
          heading = day !== group ? '<div class="nc-group">' + day + "</div>" : "";
        group = day;
        return (
          heading +
          (item.job ? this.#job(item, isUnread(item)) : this.#message(item, isUnread(item)))
        );
      })
      .join("");
    const emptyText =
      this.filter === "unread"
        ? ["No unread notifications", "You’ve seen everything new."]
        : this.filter === "alerts"
          ? ["No alerts", "Playback, connection and import problems show up here."]
          : ["You’re all caught up", "Playback alerts, imports and your actions show up here."];
    this.panel.innerHTML =
      '<header class="nc-head"><div><h2>Notifications</h2><span class="nc-sub">' +
      (unread ? unread + " unread" : "All caught up") +
      '</span></div><button type="button" class="text-button' +
      (unread ? "" : " is-done") +
      '" data-action="notifications-read">' +
      icon("check") +
      "Mark all read</button></header>" +
      '<div class="nc-tabs" aria-label="Filter notifications">' +
      tab("all", "All", entries.length) +
      tab("unread", "Unread", unread) +
      tab("alerts", "Alerts", alerts.length) +
      "</div>" +
      '<div class="notification-list">' +
      (list ||
        '<div class="nc-empty"><span class="nc-empty-icon">' +
          icon("bell") +
          "</span><h3>" +
          emptyText[0] +
          "</h3><p>" +
          emptyText[1] +
          "</p></div>") +
      "</div>";
    if (focused?.action)
      [...this.panel.querySelectorAll("[data-action]")]
        .find((el) => ["action", "id", "token"].every((key) => el.dataset[key] === focused[key]))
        ?.focus({ preventScroll: true });
    else if (focused?.ncFilter)
      this.panel
        .querySelector('[data-nc-filter="' + focused.ncFilter + '"]')
        ?.focus({ preventScroll: true });
    this.panel.querySelector(".notification-list").scrollTop = scrollTop;
  }
}
