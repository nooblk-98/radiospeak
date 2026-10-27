import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Deterministic across Git's Windows/Linux newline conversion; no runtime state. */
function sourceFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix + entry.name;
      return entry.isDirectory()
        ? sourceFiles(join(directory, entry.name), path + "/")
        : /\.(ts|js|mjs|sh|html|css|svg)$/.test(entry.name)
          ? [path]
          : [];
    })
    .sort();
}
const digest = createHash("sha256");
const root = join(import.meta.dirname, "../..");
for (const directory of ["src", "scripts"]) {
  if (!existsSync(join(root, directory))) continue;
  for (const path of sourceFiles(join(root, directory)))
    digest.update(
      directory +
        "/" +
        path +
        "\n" +
        readFileSync(join(root, directory, path), "utf8")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n") +
        "\n",
    );
}
for (const path of [
  "package.json",
  "package-lock.json",
  "config.example.json",
  "Dockerfile",
  "docker-compose.yml",
])
  if (existsSync(join(root, path)))
    digest.update(
      path +
        "\n" +
        readFileSync(join(root, path), "utf8")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n") +
        "\n",
    );
export const sourceRevision = digest.digest("hex");
