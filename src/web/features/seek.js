/** Keep the chosen position visible and serialize successive seeks to the same bot. */
export class SeekControl {
  #states = new Map();
  #previews = new Map();
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
  get(name, url) {
    const preview = this.#previews.get(name);
    if (preview && preview.url === url) return preview.seconds;
    const state = this.#states.get(name);
    return state && state.url === url ? state.seconds : undefined;
  }
  /** Native range input may emit change after pointerup; retain its uncommitted value. */
  preview(name, url, seconds) {
    if (!url || !Number.isFinite(seconds)) return;
    this.#previews.set(name, { url, seconds: Math.max(0, seconds) });
    this.#value(name, url, Math.max(0, seconds));
  }
  cancelPreview(name) {
    this.#previews.delete(name);
  }
  set(name, url, seconds) {
    if (!url || !Number.isFinite(seconds)) return;
    this.#previews.delete(name);
    let state = this.#states.get(name);
    if (!state) {
      state = { running: false };
      this.#states.set(name, state);
    }
    Object.assign(state, { url, seconds: Math.max(0, seconds), pending: true });
    this.#value(name, url, state.seconds);
    if (!state.running) void this.#drain(name, state);
  }
  async #drain(name, state) {
    state.running = true;
    try {
      while (state.pending) {
        state.pending = false;
        const { url, seconds } = state;
        try {
          await this.#send(name, url, seconds);
        } catch (error) {
          if (!state.pending) throw error;
        }
      }
      this.#states.delete(name);
      this.#settled(name);
    } catch (error) {
      this.#states.delete(name);
      this.#error(name, error);
    }
  }
}
