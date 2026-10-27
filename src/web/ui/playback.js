/** Human-readable playback stages shared by the dashboard, dock and search cards. */
export function playbackStatus(bot) {
  if (!bot.track && !bot.radio)
    return { phase: "idle", label: "Ready when you are", loading: false };
  if (bot.connectionPaused)
    return { phase: "connecting", label: "Waiting for voice connection", loading: true };
  if (bot.autoPaused) return { phase: "paused", label: "Paused · no listeners", loading: false };
  if (bot.userPaused) return { phase: "paused", label: "Playback paused", loading: false };
  const phase = bot.health?.phase;
  if (phase === "retrying" || bot.health?.retrying)
    return { phase: "retrying", label: "Reconnecting audio…", loading: true };
  if (phase === "resolving") return { phase, label: "Resolving audio stream…", loading: true };
  if (phase === "buffering" || bot.health?.buffering)
    return { phase: "buffering", label: "Preparing audio…", loading: true };
  return { phase: "playing", label: "On the air", loading: false };
}
