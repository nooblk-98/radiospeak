import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AtomicFile } from "./atomic-file.ts";
import type { App } from "./bot.ts";
import { sourceRevision } from "./build-info.ts";

export interface DeploymentPolicy { mode: "immediate" | "track-end" | "window"; start: string; end: string; timezone: string; maxWaitMinutes: number }
export interface AuditEntry { id: string; at: string; actor: string; method: string; resource: string }
interface Deployment { id: string; revision: string; status: "waiting" | "draining" | "deploying" | "completed" | "failed" | "cancelled"; createdAt: string; updatedAt: string; message: string; sealed?: string; force: boolean; originInstance: string }
interface Data { audit: AuditEntry[]; policy: DeploymentPolicy; deployment: Deployment | null }
const initial = (): Data => ({audit:[],policy:{mode:"track-end",start:"02:00",end:"04:00",timezone:"Asia/Colombo",maxWaitMinutes:30},deployment:null});
export function validateDeploymentPolicy(value: DeploymentPolicy): DeploymentPolicy {
  if(!value || !["immediate","track-end","window"].includes(value.mode) || ![value.start,value.end].every(t=>typeof t==="string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || value.start===value.end || !Number.isInteger(value.maxWaitMinutes) || value.maxWaitMinutes<1 || value.maxWaitMinutes>240 || typeof value.timezone!=="string")throw new Error("Choose a valid deployment policy, time window and maximum wait (1–240 minutes)");
  new Intl.DateTimeFormat("en",{timeZone:value.timezone}).format();
  return {mode:value.mode,start:value.start,end:value.end,timezone:value.timezone,maxWaitMinutes:value.maxWaitMinutes};
}

/** Bounded administrative journal and one durable, encrypted deployment request. */
export class Operations {
  #app: App; #data: Data; #writer: AtomicFile; #token: string; #timer: NodeJS.Timeout; #busy=false; #closed=false;
  revision=0;
  #instance=randomUUID();
  constructor(app: App) {
    this.#app=app;
    const path=join(dirname(app.playlists.path),"operations.json"), keyPath=join(dirname(path),"deployment-token.txt");
    this.#token=existsSync(keyPath)?readFileSync(keyPath,"utf8").trim():randomBytes(32).toString("hex");
    if(!existsSync(keyPath))writeFileSync(keyPath,this.#token+"\n",{mode:0o600,flag:"wx"});
    this.#data=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):initial();
    this.#data={...initial(),...this.#data,audit:(this.#data.audit ?? []).slice(-2000)};
    this.#writer=new AtomicFile(path,()=>JSON.stringify(this.#data)+"\n");
    this.#timer=setInterval(()=>{void this.tick().catch(()=>{});},1000).unref();
  }
  authorized(header: string | undefined) {
    const supplied=Buffer.from(header?.startsWith("Bearer ")?header.slice(7):""), expected=Buffer.from(this.#token);
    return supplied.length===expected.length && timingSafeEqual(supplied,expected);
  }
  get status() { const job=this.#data.deployment; return {policy:{...this.#data.policy},deployment:job?{...job,sealed:undefined}:null}; }
  audit(actor: string, method: string, pathname: string) {
    // Record route identifiers, never request bodies, query strings, URLs, headers or credentials.
    const parts=pathname.split("/").filter(Boolean);
    const resource=parts.map((part,index)=> index===2 && parts[1]==="accounts" ? "[account]" : part).join("/").slice(0,300);
    this.#data.audit.push({id:randomUUID(),at:new Date().toISOString(),actor:actor.slice(0,80),method,resource});
    if(this.#data.audit.length>2000)this.#data.audit.splice(0,this.#data.audit.length-2000);
    this.#save();
  }
  entries(offset=0,limit=50) { return {total:this.#data.audit.length,entries:this.#data.audit.slice().reverse().slice(offset,offset+limit)}; }
  setPolicy(value: DeploymentPolicy) {
    this.#data.policy=validateDeploymentPolicy(value);this.#save();
  }
  #seal(value: string) {
    const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",createHash("sha256").update(this.#token).digest(),iv);
    const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64");
  }
  #unseal(value: string) { const bytes=Buffer.from(value,"base64"),decipher=createDecipheriv("aes-256-gcm",createHash("sha256").update(this.#token).digest(),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8"); }
  queue(revision: string, webhook: string, force=false) {
    if(!/^[a-f0-9]{64}$/.test(revision))throw new Error("Expected a source SHA-256 revision");
    const url=new URL(webhook);
    if(!["https:","http:"].includes(url.protocol) || url.username || url.password || webhook.length>8000)throw new Error("Invalid deployment webhook");
    const current=this.#data.deployment;
    if(current && ["waiting","draining","deploying"].includes(current.status)) {
      if(current.revision===revision)return this.status;
      if(current.status==="deploying")throw new Error("A deployment is in progress; wait for it to finish");
      this.#release();
    }
    const now=new Date().toISOString();
    this.#data.deployment={id:randomUUID(),revision,status:"waiting",createdAt:now,updatedAt:now,message:"Waiting for the deployment policy",sealed:this.#seal(webhook),force,originInstance:this.#instance}; this.#save();return this.status;
  }
  cancel() { const job=this.#data.deployment;if(job && ["waiting","draining"].includes(job.status)){this.#update("cancelled","Deployment cancelled");this.#release();}else throw new Error("No cancellable deployment"); }
  #release() { for(const b of this.#app.bots)b.player.releaseDeployment(); }
  #update(status: Deployment["status"],message: string) { const job=this.#data.deployment!;job.status=status;job.message=message;job.updatedAt=new Date().toISOString();if(["completed","failed","cancelled"].includes(status))delete job.sealed;this.#save(); }
  async tick(now=new Date()) {
    if(this.#busy || this.#closed)return;
    const job=this.#data.deployment;if(!job || !["waiting","draining","deploying"].includes(job.status))return;
    if(job.revision===sourceRevision && (!job.force || job.originInstance!==this.#instance) && this.#app.bots.every(b=>b.connected) && !this.#app.playlists.persistenceError && !this.#app.playback?.status.error) { this.#update("completed","Expected source is deployed and all bots are connected");this.#release();return; }
    if(job.status==="deploying") { if(now.getTime()-Date.parse(job.updatedAt)>180000){this.#update("failed","Deployment did not become healthy within three minutes; check GitHub Actions and Portainer");this.#release();}return; }
    const policy=this.#data.policy;
    let inWindow=true;
    if(!job.force && policy.mode==="window") {
      const time=new Intl.DateTimeFormat("en-GB",{timeZone:policy.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
      inWindow=policy.start<policy.end?time>=policy.start && time<policy.end:time>=policy.start || time<policy.end;
    }
    // A window may be a day away; only the drain itself has a bounded wait.
    if(!inWindow) { if(job.status==="draining"){this.#update("waiting","Waiting for the next maintenance window");this.#release();}return; }
    if(job.force || policy.mode==="immediate") { /* An explicit immediate deployment needs no drain. */ }
    else {
      if(job.status==="waiting"){this.#update("draining","Waiting for each bot to finish its current song");}
      for(const b of this.#app.bots)if(!b.player.deploymentReady)b.player.holdForDeployment();
      if(!this.#app.bots.every(b=>b.player.deploymentReady)) {
        if(now.getTime()-Date.parse(job.updatedAt)>policy.maxWaitMinutes*60000){this.#update("failed","Current songs exceeded the maximum deployment wait; playback continues");this.#release();}
        return;
      }
    }
    this.#busy=true;
    try {
      const webhook=this.#unseal(job.sealed!);
      this.#update("deploying","Portainer deployment requested; waiting for the new source");
      await this.#app.playlists.flush();await this.#app.playback?.flush();await this.flush();
      // Exactly one attempt: a lost response must never trigger a second recreation.
      const response=await fetch(webhook,{method:"POST",signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error("Deployment webhook returned HTTP "+response.status);
    } catch {
      // Keep the three-minute health window: the webhook may have succeeded before the response was lost.
    } finally {this.#busy=false;}
  }
  #save(){this.revision++;this.#writer.schedule();}
  flush(){return this.#writer.flush();}
  close(){this.#closed=true;clearInterval(this.#timer);}
}
