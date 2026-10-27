import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../app/context.ts";
import { AtomicFile } from "../persistence/atomic-file.ts";

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  method: string;
  resource: string;
}
interface Data {
  audit: AuditEntry[];
}

/** Bounded administrative journal of panel changes and state-changing chat commands. */
export class Operations {
  #data: Data;
  #writer: AtomicFile;
  revision = 0;
  constructor(app: App) {
    const path = join(dirname(app.playlists.path), "operations.json");
    // Older files also held a deployment policy and request; only the journal is kept.
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    this.#data = { audit: (Array.isArray(saved.audit) ? saved.audit : []).slice(-2000) };
    this.#writer = new AtomicFile(path, () => JSON.stringify(this.#data) + "\n");
  }
  audit(actor: string, method: string, pathname: string) {
    // Record route identifiers, never request bodies, query strings, URLs, headers or credentials.
    const parts = pathname.split("/").filter(Boolean);
    const resource = parts
      .map((part, index) => (index === 2 && parts[1] === "accounts" ? "[account]" : part))
      .join("/")
      .slice(0, 300);
    this.#data.audit.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: actor.slice(0, 80),
      method,
      resource,
    });
    if (this.#data.audit.length > 2000) this.#data.audit.splice(0, this.#data.audit.length - 2000);
    this.#save();
  }
  entries(offset = 0, limit = 50) {
    return {
      total: this.#data.audit.length,
      entries: this.#data.audit
        .slice()
        .reverse()
        .slice(offset, offset + limit),
    };
  }
  #save() {
    this.revision++;
    this.#writer.schedule();
  }
  flush() {
    return this.#writer.flush();
  }
  close() {}
}
