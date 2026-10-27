/** Text escaping and time formatting shared by browser views. */
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export const duration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "LIVE";
  const n = Math.floor(seconds),
    h = Math.floor(n / 3600),
    m = Math.floor((n % 3600) / 60),
    s = String(n % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + s : m + ":" + s;
};
export const time = (n) => (n ? duration(n) : "0:00");
