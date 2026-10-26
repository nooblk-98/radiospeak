export async function request(path, body, method = body === undefined ? 'GET' : 'POST', signal) {
  const response = await fetch(path, {
    method, signal, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed. Please try again.');
  return result;
}

/** One request at a time; slow responses never overwrite a newer state. */
export class StateConnection extends EventTarget {
  state = null;
  #timer;
  #pending = null;
  #fingerprints = {};
  async refresh(fresh = false) {
    if (fresh && this.#pending) await this.#pending;
    if (this.#pending) return this.#pending;
    this.#pending = this.#load().finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #load() {
    try {
      const state = await request('/api/state', undefined, 'GET', AbortSignal.timeout(10000));
      const fingerprints = {
        track_changed: JSON.stringify(state.bots.map(b => [b.name, b.track, b.radio, b.userPaused, b.autoPaused])),
        queue_updated: JSON.stringify(state.bots.map(b => b.queue)),
      };
      this.state = state;
      for (const [name, value] of Object.entries(fingerprints)) {
        if (value !== this.#fingerprints[name]) this.dispatchEvent(new CustomEvent(name, { detail: state }));
      }
      this.#fingerprints = fingerprints;
      this.dispatchEvent(new CustomEvent('playback_progress', { detail: state }));
      this.dispatchEvent(new CustomEvent('state', { detail: state }));
      this.dispatchEvent(new Event('online'));
      return state;
    } catch (error) {
      this.dispatchEvent(new CustomEvent('offline', { detail: error }));
    }
  }
  start() {
    const poll = async () => {
      await this.refresh();
      this.#timer = setTimeout(poll, document.hidden ? 5000 : 1500);
    };
    void poll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
  }
  stop() { clearTimeout(this.#timer); }
}
