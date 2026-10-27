import { queueTrackKey } from "./enqueue.js";
import { playbackStatus } from "../ui/playback.js";

/** A repeated click on a preparing song must not restart its provider lookup. */
export class PlayControl {
  #pending = new Map();
  #send;
  #change;
  constructor({ send, onChange = () => {} }) {
    this.#send = send;
    this.#change = onChange;
  }
  state(bot, track) {
    const key = queueTrackKey(track.url),
      pending = this.#pending.get(bot.name);
    if (pending) return pending === key ? "requesting" : "busy";
    if (bot.track && queueTrackKey(bot.track.url) === key && playbackStatus(bot).loading)
      return "preparing";
    return "idle";
  }
  async play(bot, track) {
    if (this.state(bot, track) !== "idle") return false;
    this.#pending.set(bot.name, queueTrackKey(track.url));
    this.#change();
    try {
      await this.#send(bot.name, track);
      return true;
    } finally {
      this.#pending.delete(bot.name);
      this.#change();
    }
  }
}
