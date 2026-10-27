import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AtomicFile } from "./atomic-file.ts";
import { validateBotName, validateDiscordConfig, type DiscordConfig } from "./config.ts";

/** Credentials are separate from the portable library and encrypted at rest. */
export class DiscordInstances {
  #path: string; #keyPath: string; #key?: Buffer; #data: Record<string,DiscordConfig>={}; #writer: AtomicFile;
  constructor(libraryPath: string) {
    this.#path=join(dirname(libraryPath),"discord-instances.json");this.#keyPath=join(dirname(libraryPath),"discord-secrets.key");
    if(existsSync(this.#path)) {
      if(!existsSync(this.#keyPath))throw new Error("The Discord credentials encryption key is missing; restore discord-secrets.key with discord-instances.json");
      const saved=JSON.parse(readFileSync(this.#path,"utf8"));
      if(saved.version!==1 || typeof saved.sealed!=="string")throw new Error("Invalid Discord credentials file");
      const bytes=Buffer.from(saved.sealed,"base64"),decipher=createDecipheriv("aes-256-gcm",this.#loadKey(),bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));this.#data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8"));
      for(const [name,cfg] of Object.entries(this.#data)){validateBotName(name);validateDiscordConfig(cfg);}
    }
    this.#writer=new AtomicFile(this.#path,()=>{
      const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.#loadKey(),iv);
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(this.#data),"utf8"),cipher.final()]);
      return JSON.stringify({version:1,sealed:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64")})+"\n";
    });
  }
  #loadKey() {
    if(!this.#key){
      if(!existsSync(this.#keyPath))writeFileSync(this.#keyPath,randomBytes(32),{mode:0o600,flag:"wx"});
      this.#key=readFileSync(this.#keyPath);if(this.#key.length!==32)throw new Error("Invalid Discord credentials encryption key");
    }
    return this.#key;
  }
  get(name: string) { const cfg=Object.hasOwn(this.#data,name)?this.#data[name]:undefined;return cfg?{...cfg}:undefined; }
  set(name: string,config: DiscordConfig) { validateBotName(name);this.#data[name]=validateDiscordConfig(config);this.#writer.schedule(); }
  remove(name: string) { delete this.#data[name];this.#writer.schedule(); }
  flush() { return this.#writer.flush(); }
  static fingerprint(token: string) { return createHash("sha256").update(token).digest("hex"); }
}
