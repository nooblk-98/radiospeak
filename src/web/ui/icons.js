/** Accessible icon and button primitives. */
import { escape } from "./format.js";
const paths = {
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  alert: '<path d="M12 3 2 20h20L12 3Zm0 6v5m0 3v.5"/>',
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  queue: '<path d="M4 6h16M4 12h12M4 18h8m5-3 4 3-4 3z"/>',
  library:
    '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="11" y="4" width="4" height="16" rx="1"/><path d="m18 4 4 15-3 1-4-15z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  settings:
    '<path d="m10 3-.7 2.4-2 .9-2.2-.6-2 3.4L5 11v2l-1.9 1.9 2 3.4 2.3-.6 2 .9.6 2.4h4l.7-2.4 2-.9 2.2.6 2-3.4L19 13v-2l1.9-1.9-2-3.4-2.3.6-2-.9L14 3z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  heart:
    '<path d="M20.7 4.8a5.3 5.3 0 0 0-7.5 0L12 6l-1.2-1.2a5.3 5.3 0 0 0-7.5 7.5L12 21l8.7-8.7a5.3 5.3 0 0 0 0-7.5Z"/>',
  radio:
    '<rect x="3" y="8" width="18" height="13" rx="3"/><path d="m5 8 13-5M6 12h5"/><circle cx="16" cy="15" r="2.5"/><path d="M6 16h4"/>',
  play: '<path d="m8 4 13 8-13 8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  previous: '<path d="M5 5v14m14-14-11 7 11 7z"/>',
  next: '<path d="M19 5v14M5 5l11 7-11 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  shuffle:
    '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3.5-2 5-5m2-3c1.5-2 3-4 5-4h3m-4-4 4 4-4 4"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-3v4a3 3 0 0 1-3 3H3"/>',
  volume: '<path d="M11 4 5 9H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 4 5 9H2v6h3l6 5zm5 5 6 6m0-6-6 6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  music:
    '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a6 6 0 0 1 3 6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  top: '<path d="M5 4h14M12 21V8m-5 5 5-5 5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  "sign-out": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  headphones:
    '<path d="M3 15v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/>',
  soundcloud: '<path d="M2 13v4m3-7v9m3-11v11m3-11a5 5 0 0 1 9 3 4 4 0 0 1 0 8h-9z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  grip: '<circle cx="8" cy="6" r=".6"/><circle cx="16" cy="6" r=".6"/><circle cx="8" cy="12" r=".6"/><circle cx="16" cy="12" r=".6"/><circle cx="8" cy="18" r=".6"/><circle cx="16" cy="18" r=".6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
};
export const icon = (name) =>
  '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.music) + "</svg>";
export function iconButton(name, label, action, attrs = "", classes = "") {
  return (
    '<button class="icon-button ' +
    classes +
    '" type="button" data-action="' +
    action +
    '" aria-label="' +
    escape(label) +
    '" title="' +
    escape(label) +
    '" ' +
    attrs +
    ">" +
    icon(name) +
    "</button>"
  );
}
export const button = (label, name, action, attrs = "", classes = "primary") =>
  '<button type="button" class="button ' +
  classes +
  '" data-action="' +
  action +
  '" ' +
  attrs +
  ">" +
  (name ? icon(name) : "") +
  escape(label) +
  "</button>";
