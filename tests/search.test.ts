import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolve, mediaStats } from "../src/ytdlp.ts";
import { tracks } from "./helpers.ts";

test("search cache reuses metadata, clones cached results, and separates source/query keys",async t=>{
  let calls=0;
  t.mock.method(childProcess,"execFile",(_path:string,_args:string[],_options:any,callback:Function)=>{
    calls++;
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough()});
    setImmediate(()=>{
      const output="T\t"+JSON.stringify({...tracks[0],webpage_url:tracks[0]!.url})+"\n";
      child.stdout.write(output);callback(null,output,"");
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const one=await resolve("fake","cache this query",{maxItems:10,results:10,source:"youtube"});
    one.tracks[0]!.title="mutated";
    const two=await resolve("fake","cache this query",{maxItems:10,results:10,source:"youtube"});
    assert.equal(calls,1);assert.equal(two.tracks[0]!.title,tracks[0]!.title);
    await resolve("fake","cache this query",{maxItems:10,results:10,source:"soundcloud"});
    assert.equal(calls,2);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
});
test("abandoned searches abort active children and queued lookups never launch",async t=>{
  let calls=0,aborts=0;
  t.mock.method(childProcess,"execFile",(_path:string,_args:string[],options:any,callback:Function)=>{
    calls++;
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough()});
    options.signal.addEventListener("abort",()=>{aborts++;callback(new Error("aborted"),"","");},{once:true});
    return child;
  });
  syncBuiltinESMExports();
  try {
    const controllers=[new AbortController(),new AbortController(),new AbortController()];
    const pending=controllers.map((controller,index)=>resolve("fake","cancel "+index,{maxItems:10,results:10,signal:controller.signal}));
    const settled=Promise.allSettled(pending);
    await new Promise(r=>setImmediate(r));
    assert.equal(calls,2);assert.equal(mediaStats().queued,1);
    controllers[2]!.abort(new Error("queued cancelled"));
    controllers[0]!.abort(new Error("active cancelled"));controllers[1]!.abort(new Error("active cancelled"));
    assert.ok((await settled).every(result=>result.status==="rejected"));
    assert.equal(calls,2);assert.equal(aborts,2);assert.equal(mediaStats().active,0);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
});
test("partial imports stream actual progress and retain readable errors for unavailable entries",async t=>{
  t.mock.method(childProcess,"execFile",(_path:string,args:string[],_options:any,callback:Function)=>{
    assert.ok(args.includes("--ignore-errors"));
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough()});
    setImmediate(()=>{
      const line="T\t"+JSON.stringify({...tracks[0],webpage_url:tracks[0]!.url,playlist_count:3})+"\n";
      child.stdout.write(line.slice(0,15));child.stdout.write(line.slice(15));
      callback(new Error("partial"),line,"ERROR: Private video\n");
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const progress:any[]=[];
    const result=await resolve("fake","https://example.com/list",{maxItems:100,partial:true,onProgress:update=>progress.push(update)});
    assert.equal(result.tracks.length,1);
    assert.equal(progress[0].processed,1);assert.equal(progress[0].total,3);
    assert.match(result.skipped![0]!,/Private video/);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
});
