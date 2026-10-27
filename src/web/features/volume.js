/** Send live slider values in order, retaining only the newest unsent value. */
export class VolumeControl {
  #states = new Map();
  #send;
  #value;
  #settled;
  #error;
  constructor({ send, onValue = () => {}, onSettled = () => {}, onError = () => {} }) {
    this.#send = send;
    this.#value = onValue;
    this.#settled = onSettled;
    this.#error = onError;
  }
  get(bot) {
    return this.#states.get(bot)?.value;
  }
  set(bot, value, immediate = false) {
    value = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(value)) return;
    let state = this.#states.get(bot);
    if (!state) {
      state = { value, pending: null, running: false, timer: null, lastSent: 0 };
      this.#states.set(bot, state);
    }
    state.value = value;
    state.pending = value;
    this.#value(bot, value);
    if (immediate) {
      clearTimeout(state.timer);
      state.timer = null;
      void this.#drain(bot, state);
    } else if (!state.running && !state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.#drain(bot, state);
      }, 75);
    }
  }
  async #drain(bot, state) {
    if (state.running) return;
    state.running = true;
    try {
      while (state.pending !== null) {
        const wait = 75 - (Date.now() - state.lastSent);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const value = state.pending;
        state.pending = null;
        state.lastSent = Date.now();
        await this.#send(bot, value);
      }
      this.#states.delete(bot);
      this.#settled(bot, state.value);
    } catch (error) {
      this.#states.delete(bot);
      this.#error(bot, error);
    } finally {
      state.running = false;
    }
  }
  dispose() {
    for (const state of this.#states.values()) clearTimeout(state.timer);
  }
}
