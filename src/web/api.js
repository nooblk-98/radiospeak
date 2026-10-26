export async function request(path, body, method = body === undefined ? 'GET' : 'POST', signal) {
  const response = await fetch(path, {
    method, signal, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    // The session expired or was signed out elsewhere: return here after signing in.
    location.replace('/login' + (location.hash.length > 1 ? '?next=' + encodeURIComponent(location.hash) : ''));
    throw new Error('Sign in to continue.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed. Please try again.');
  return result;
}

/** SSE with polling fallback. Library summaries are separate from paged track details. */
export class StateConnection extends EventTarget {
  state = null;
  #timer;
  #pending = null;
  #fingerprints = {};
  #stream;
  #streamVersion = 0;
  #stopped = false;
  #streamHealthy = false;
  #uiVersion;
  #updateRequired = false;
  constructor({ uiVersion = new URL(import.meta.url).searchParams.get('v') } = {}) {
    super();
    this.#uiVersion = uiVersion;
  }
  #compatible(state) {
    if (this.#updateRequired) return false;
    if (this.#uiVersion && state.uiVersion && this.#uiVersion !== state.uiVersion) {
      this.#updateRequired = true;
      this.dispatchEvent(new Event('updateavailable'));
      return false;
    }
    return true;
  }
  async refresh(fresh = false) {
    if (fresh && this.#pending) await this.#pending;
    if (this.#pending) return this.#pending;
    this.#pending = this.#load().finally(() => { this.#pending = null; });
    return this.#pending;
  }
  #accept(state) {
    if (!this.#compatible(state)) return;
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
  }
  async #load() {
    const version = this.#streamVersion;
    try {
      const state = await request('/api/state', undefined, 'GET', AbortSignal.timeout(10000));
      if (version === this.#streamVersion && !this.#stopped) this.#accept(state);
      return this.state;
    } catch (error) {
      this.dispatchEvent(new CustomEvent('offline', { detail: error }));
    }
  }
  #poll = async () => {
    if (this.#stopped) return;
    await this.refresh();
    if (!this.#stopped && !this.#streamHealthy && !this.#timer) this.#timer = setTimeout(() => { this.#timer = null; void this.#poll(); }, document.hidden ? 5000 : 1500);
  };
  #openStream() {
    if (typeof EventSource === 'undefined') { void this.#poll(); return; }
    this.#stream = new EventSource('/api/events');
    this.#stream.addEventListener('state', event => {
      try {
        this.#streamVersion++;
        this.#streamHealthy = true;
        clearTimeout(this.#timer); this.#timer = null;
        this.#accept(JSON.parse(event.data));
      } catch { this.dispatchEvent(new Event('offline')); }
    });
    this.#stream.addEventListener('playback_progress', event => {
      if (!this.state) return;
      try {
        const progress = JSON.parse(event.data);
        if (!this.#compatible(progress)) return;
        this.#streamHealthy = true;
        clearTimeout(this.#timer); this.#timer = null;
        this.#streamVersion++;
        this.state = { ...this.state, system: progress.system, bots: this.state.bots.map(b => ({
          ...b, ...progress.bots.find(update => update.name === b.name),
        })) };
        this.dispatchEvent(new CustomEvent('playback_progress', { detail: this.state }));
        this.dispatchEvent(new Event('online'));
      } catch { /* next complete state repairs a malformed progress event */ }
    });
    this.#stream.onerror = () => {
      if (this.#stopped) return;
      this.#streamHealthy = false;
      this.dispatchEvent(new Event('offline'));
      if (!this.#timer) this.#timer = setTimeout(() => { this.#timer = null; void this.#poll(); },1500);
    };
  }
  start() {
    this.#stopped = false;
    this.#openStream();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.#stopped) void this.refresh(); });
  }
  stop() { this.#stopped = true; clearTimeout(this.#timer); this.#stream?.close(); }
}
