import { randomUUID } from "node:crypto";
import { resolve, type ResolveOptions, type Resolved } from "./ytdlp.ts";
import type { PlaylistStore } from "./store.ts";

export interface ImportJob {
  id: string; playlistId: string; playlistName: string;
  status: "queued" | "resolving" | "completed" | "failed" | "cancelled";
  processed: number; total: number | null; currentTitle: string;
  added: number; duplicates: number; failed: number; errors: string[];
  createdAt: number;
}
type Resolver = (path: string, input: string, options: ResolveOptions) => Promise<Resolved>;
export class ImportManager {
  #store: PlaylistStore; #path: string; #max: number; #resolve: Resolver;
  #jobs = new Map<string, ImportJob>();
  #controllers = new Map<string, AbortController>();
  constructor(store: PlaylistStore, path: string, max: number, resolver: Resolver = resolve) {
    this.#store = store; this.#path = path; this.#max = max; this.#resolve = resolver;
  }
  get all() { return [...this.#jobs.values()]; }
  get(id: string) { return this.#jobs.get(id); }
  start(playlistId: string, input: string, skipDuplicates = true): ImportJob {
    const list = this.#store.find(playlistId);
    if (!list) throw new Error("Playlist not found");
    if (!input.trim() || input.length > 1000) throw new Error("Enter a media link or search (up to 1,000 characters)");
    if (this.#controllers.size >= 10) throw new Error("Too many pending imports");
    for (const [id, job] of this.#jobs) {
      if (!this.#controllers.has(id) && (this.#jobs.size >= 20 || Date.now() - job.createdAt > 30 * 60_000)) this.#jobs.delete(id);
    }
    const job: ImportJob = { id: randomUUID(), playlistId: list.id, playlistName: list.name, status: "queued",
      processed: 0, total: null, currentTitle: "", added: 0, duplicates: 0, failed: 0, errors: [], createdAt: Date.now() };
    const controller = new AbortController();
    this.#jobs.set(job.id, job); this.#controllers.set(job.id, controller);
    void this.#run(job, input, skipDuplicates, controller);
    return job;
  }
  async #run(job: ImportJob, input: string, skipDuplicates: boolean, controller: AbortController) {
    try {
      const result = await this.#resolve(this.#path, input, {
        maxItems: this.#max, wholePlaylist: true, partial: true, signal: controller.signal,
        onProgress: ({processed,total,title}) => {
          if (controller.signal.aborted) return;
          job.status = "resolving"; job.processed = processed; job.total = total; job.currentTitle = title;
        },
      });
      controller.signal.throwIfAborted();
      const list = this.#store.find(job.playlistId);
      if (!list) throw new Error("The playlist was deleted during import");
      Object.assign(job, this.#store.addUniqueTracks(list, result.tracks, skipDuplicates));
      job.errors = result.skipped ?? []; job.failed = job.errors.length;
      job.processed = result.tracks.length + job.failed;
      job.total ??= job.processed;
      job.status = "completed";
    } catch (err) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.errors = [err instanceof Error ? err.message : String(err)];
      job.failed = controller.signal.aborted ? 0 : 1;
    } finally { this.#controllers.delete(job.id); }
  }
  cancel(id: string) { this.#controllers.get(id)?.abort(new Error("Import cancelled")); }
  close() { for (const id of this.#controllers.keys()) this.cancel(id); }
}
