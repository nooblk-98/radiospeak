/** Static asset allowlist and revision stamping for the entire browser module graph. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sourceRevision } from "../shared/build-info.ts";

export const uiVersion = sourceRevision.slice(0, 16);
const webRoot = join(import.meta.dirname, "..", "web");
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
export const assets = new Map<string, { body: Buffer; type: string }>();

// Only browser files with a known extension are published; never expose backend source.
function load(directory: string, prefix = ""): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      load(join(directory, entry.name), path + "/");
      continue;
    }
    const type = types[entry.name.slice(entry.name.lastIndexOf("."))];
    if (!type || path === "login.html") continue;
    let body = readFileSync(join(directory, entry.name), "utf8");
    if (type === "text/html") {
      body = body.replace(/(href|src)="\/(styles\.css|app\.js)"/g, `$1="/$2?v=${uiVersion}"`);
    } else if (type === "text/javascript") {
      // Absolute, versioned imports also work through the legacy root-level aliases.
      body = body.replace(
        /(\b(?:from|import)\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g,
        (_, before: string, specifier: string, after: string) =>
          before + new URL(specifier, "http://assets/" + path).pathname + "?v=" + uiVersion + after,
      );
    } else if (type === "text/css") {
      body = body.replace(
        /(@import\s+['"])([^'"]+\.css)(['"])/g,
        (_, before: string, specifier: string, after: string) =>
          before + new URL(specifier, "http://assets/" + path).pathname + "?v=" + uiVersion + after,
      );
    }
    assets.set("/" + path, { body: Buffer.from(body), type });
  }
}
load(webRoot);
// Source CSS stays modular; serve one cached stylesheet to avoid an import waterfall.
const stylesheet = assets.get("/styles.css")!;
stylesheet.body = Buffer.from(
  stylesheet.body.toString("utf8").replace(/@import\s+["']([^"']+)["'];/g, (_, path: string) => {
    const asset = assets.get(new URL(path, "http://assets/styles.css").pathname);
    if (!asset || asset.type !== "text/css") throw new Error("Missing stylesheet: " + path);
    return asset.body.toString("utf8");
  }),
);
assets.set("/", assets.get("/index.html")!);
const aliases: Record<string, string> = {
  "api.js": "state/connection.js",
  "volume.js": "features/volume.js",
  "enqueue.js": "features/enqueue.js",
  "notifications.js": "features/notifications.js",
  "components.js": "ui/components.js",
  "platforms.js": "ui/platforms.js",
  "management.js": "views/management.js",
  "operations.js": "views/operations.js",
  "discord.svg": "assets/discord.svg",
  "teamspeak.svg": "assets/teamspeak.svg",
};
for (const [alias, path] of Object.entries(aliases))
  assets.set("/" + alias, assets.get("/" + path)!);
export const loginPage = readFileSync(join(webRoot, "login.html"));
