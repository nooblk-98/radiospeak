import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolve, type ResolveOptions, type Resolved, type MediaEntry } from "./ytdlp.ts";
import type { PlaylistStore } from "./store.ts";
import { AtomicFile } from "./atomic-file.ts";

export interface ImportJob {
  id: string; playlistId: string; playlistName: string; input: string; skipDuplicates: boolean;
  status: "queued" | "resolving" | "completed" | "failed" | "cancelled" | "interrupted";
  processed: number; total: number | null; currentTitle: string;
  added: number; duplicates: number; failed: number; errors: string[];
  createdAt: number; nextIndex: number; hasMore: boolean; failedIndices: number[];
}
type Resolver = (path: string, input: string, options: ResolveOptions) => Promise<Resolved>;
export class ImportManager {
  #store: PlaylistStore; #path: string; #max: number; #resolve: Resolver;
  #jobs = new Map<string, ImportJob>();
  #controllers = new Map<string, AbortController>();
  #running = new Map<string, Promise<void>>();
  #writer: AtomicFile;
  #closing = false;
  revision = 0;
  constructor(store: PlaylistStore, path: string, max: number, resolver: Resolver = resolve) {
    this.#store = store; this.#path = path; this.#max = max; this.#resolve = resolver;
    const file = join(dirname(store.path),"imports.json");
    try {
      if (existsSync(file)) for (const job of JSON.parse(readFileSync(file,"utf8")).jobs ?? []) {
        if (!job.id || !job.playlistId || typeof job.input !== "string") continue;
        if (["queued","resolving"].includes(job.status)) job.status = "interrupted";
        this.#jobs.set(job.id,job);
      }
    } catch { /* An unreadable job file must not prevent the bot from starting. */ }
    this.#writer = new AtomicFile(file,() => JSON.stringify({ version: 1, jobs: this.all }) + "\n");
  }
  #changed() { this.revision++; this.#writer.schedule(); }
  get all() { return [...this.#jobs.values()]; }
  get active() { return this.#controllers.size; }
  get(id: string) { return this.#jobs.get(id); }
  async preview(input: string, signal?: AbortSignal) {
    this.#validate(input);
    const result = await this.#resolve(this.#path,input,{ maxItems: Math.min(10,this.#max), wholePlaylist: true, partial: true, signal });
    if (!result.tracks.length) throw new Error(result.skipped?.[0] ?? "No playable tracks in this playlist");
    return { name: result.playlist ?? "Imported playlist", tracks: result.tracks.slice(0,10), total: result.total ?? null, batchLimit: this.#max };
  }
  #validate(input: string) {
    if (!input.trim() || input.length > 1000) throw new Error("Enter a media link or search (up to 1,000 characters)");
    if (this.#closing) throw new Error("The service is shutting down");
  }
  start(playlistId: string, input: string, skipDuplicates = true): ImportJob {
    const list = this.#store.find(playlistId);
    if (!list) throw new Error("Playlist not found");
    this.#validate(input);
    if (this.#controllers.size >= 10) throw new Error("Too many pending imports");
    for (const [id,job] of this.#jobs) if (!this.#controllers.has(id) && job.status === "completed" && !job.hasMore && this.#jobs.size >= 20) this.#jobs.delete(id);
    if (this.#jobs.size >= 40) throw new Error("Finish or remove older imports first");
    const job: ImportJob = { id: randomUUID(), playlistId: list.id, playlistName: list.name, input, skipDuplicates, status: "queued",
      processed: 0, total: null, currentTitle: "", added: 0, duplicates: 0, failed: 0, errors: [], createdAt: Date.now(), nextIndex: 1, hasMore: false, failedIndices: [] };
    this.#jobs.set(job.id,job); this.#launch(job); return job;
  }
  resume(id: string, retryFailed = false): ImportJob {
    const job = this.#jobs.get(id);
    if (!job || !this.#store.find(job.playlistId)) throw new Error("Import or playlist not found");
    this.#validate(job.input);
    if (this.#controllers.has(id)) throw new Error("Import is already running");
    if (this.#controllers.size >= 10) throw new Error("Too many pending imports");
    if (!retryFailed && job.status === "completed" && !job.hasMore) throw new Error("This import is complete");
    this.#launch(job,retryFailed); return job;
  }
  remove(id: string) { if (this.#controllers.has(id)) throw new Error("Cancel this import first"); this.#jobs.delete(id); this.#changed(); }
  #launch(job: ImportJob, retry = false) {
    const controller = new AbortController();
    this.#controllers.set(job.id,controller); job.status = "queued"; this.#changed();
    const pending = this.#run(job,controller,retry).finally(() => { this.#controllers.delete(job.id); this.#running.delete(job.id); });
    this.#running.set(job.id,pending);
  }
  async #run(job: ImportJob, controller: AbortController, retry: boolean) {
    let pending: MediaEntry[] = [], chain = Promise.resolve(), timer: NodeJS.Timeout | undefined;
    const seen = new Set<number>(), failures = new Map<number,string>(job.failedIndices.map((index,i) => [index,job.errors[i] ?? "Unavailable entry"]));
    let unknownMore = false;
    const commit = (batch: MediaEntry[]) => {
      chain = chain.then(async () => {
        const list = this.#store.find(job.playlistId);
        if (!list) throw new Error("The playlist was deleted during import");
        const own = new Set(list.tracks.map(t => t.importKey).filter(Boolean));
        const tracks = batch.flatMap(entry => {
          if (!entry.track) { failures.set(entry.index,entry.error ?? "Unavailable entry"); return []; }
          failures.delete(entry.index);
          const importKey = job.id + ":" + entry.index;
          return own.has(importKey) ? [] : [{ ...entry.track, importKey }];
        });
        const added = this.#store.addUniqueTracks(list,tracks,job.skipDuplicates);
        await this.#store.flush();
        job.added += added.added; job.duplicates += added.duplicates;
        job.nextIndex = Math.max(job.nextIndex,...batch.map(e => e.index + 1));
        job.failedIndices = [...failures.keys()]; job.errors = [...failures.values()].slice(0,100); job.failed = failures.size;
        this.#changed(); await this.#writer.flush();
      });
      void chain.catch(error => controller.abort(error));
    };
    const drain = () => { clearTimeout(timer); timer = undefined; if (pending.length) commit(pending.splice(0)); };
    const entry = (value: MediaEntry) => {
      if (seen.has(value.index)) return;
      seen.add(value.index); pending.push(value);
      if (pending.length >= 20) drain();
      else timer ??= setTimeout(drain,100).unref();
    };
    try {
      const onlyFailures = retry && job.failedIndices.length > 0;
      const starts = onlyFailures ? job.failedIndices.slice(0,100) : [retry ? 1 : job.nextIndex];
      if (retry) { job.errors = []; job.failed = 0; }
      for (const startIndex of starts) {
        const batchLimit = onlyFailures ? 1 : this.#max;
        const result = await this.#resolve(this.#path,job.input,{
          maxItems: batchLimit, startIndex, fresh: true, wholePlaylist: true, partial: true, signal: controller.signal,
          onEntry: value => { if (!controller.signal.aborted) entry(value); },
          onProgress: ({processed,total,title}) => {
            if (controller.signal.aborted) return;
            job.status = "resolving"; job.processed = Math.max(job.processed,startIndex - 1 + processed); job.total = total ?? job.total; job.currentTitle = title; this.#changed();
          },
        }).catch((error): Resolved => {
          if (!onlyFailures || controller.signal.aborted) throw error;
          return { tracks: [], entries: [{ index: startIndex, error: error instanceof Error ? error.message : String(error) }] } satisfies Resolved;
        });
        controller.signal.throwIfAborted();
        (result.entries ?? result.tracks.map((track,index) => ({ track, index: startIndex + index }))).forEach(entry);
        drain(); await chain;
        job.total = result.total ?? job.total;
        unknownMore = result.total === undefined && (result.entries?.length ?? result.tracks.length) >= batchLimit;
        for (const message of result.skipped ?? []) if (!job.errors.includes(message)) job.errors.push(message);
      }
      job.failed = Math.max(failures.size,job.errors.length); job.processed = Math.max(job.processed,job.nextIndex - 1 + job.errors.filter(e => ![...failures.values()].includes(e)).length);
      job.hasMore = job.total !== null ? job.nextIndex <= job.total : unknownMore;
      job.status = "completed";
    } catch (error) {
      drain(); await chain.catch(() => {});
      job.status = this.#closing ? "interrupted" : controller.signal.aborted ? "cancelled" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      if (!job.errors.includes(message)) job.errors.push(message);
      job.failed = controller.signal.aborted ? failures.size : Math.max(1,failures.size);
      job.hasMore = true;
    } finally {
      clearTimeout(timer); this.#changed(); await this.#writer.flush().catch(() => {});
    }
  }
  cancel(id: string) { this.#controllers.get(id)?.abort(new Error("Import cancelled; already saved tracks are kept")); }
  close() { for (const id of this.#controllers.keys()) this.cancel(id); }
  async shutdown() {
    this.#closing = true;
    for (const controller of this.#controllers.values()) controller.abort(new Error("Import interrupted by shutdown"));
    await Promise.allSettled(this.#running.values()); await this.#writer.flush();
  }
}
