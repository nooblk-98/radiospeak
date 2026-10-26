import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Player } from "../src/player.ts";
import { tracks } from "./helpers.ts";

class Process extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();killed=false;
  args:string[];
  constructor(args:string[]) {super();this.args=args;}
  kill() {this.killed=true;this.stdout.destroy();this.stdin.destroy();this.stderr.destroy();return true;}
}
const wait=async(test:()=>boolean,ms=5000)=>{
  const deadline=Date.now()+ms;
  while(!test()) {if(Date.now()>deadline) throw new Error("Audio state timeout");await new Promise(r=>setTimeout(r,10));}
};
function page(value:number) {
  const count=20, data=Buffer.alloc(27+count+count*2);
  data.write("OggS");data[26]=count;
  for(let i=0;i<count;i++){data[27+i]=2;data[27+count+i*2]=value;data[28+count+i*2]=value;}
  return data;
}
function setup(t:any) {
  const procs:Process[]=[],frames:number[]=[];
  t.mock.method(childProcess,"spawn",(_path:string,args:string[])=>{const p=new Process(args);procs.push(p);return p;});
  syncBuiltinESMExports();
  const player=new Player({ffmpegPath:"ffmpeg",ytdlpPath:"yt-dlp",bitrateKbps:96,volume:50,log(){},sendFrame(frame){if(frame.length)frames.push(frame[0]!);}});
  return {player,procs,frames,encoder:()=>procs.filter(p=>p.args.includes("libopus")&&!p.killed).at(-1)!};
}
test("optional prebuffer promotes the next song's existing decoder and never sends its audio early",async t=>{
  const f=setup(t);
  try {
    f.player.enqueue([tracks[0]!,tracks[1]!]);
    f.player.seek(200);
    f.player.setPrebuffer(true);
    await wait(()=>f.player.health.activeProcesses===6);
    const next=f.encoder();
    next.stdout.write(page(0x22));
    await wait(()=>f.player.health.prebufferStatus==="ready");
    assert.equal(f.frames.length,0,"prebuffered audio must not reach TeamSpeak before promotion");
    const processes=f.procs.length;
    f.player.skip();
    assert.equal(f.player.track?.url,tracks[1]!.url);
    assert.equal(f.procs.length,processes,"next track must reuse its prepared pipeline");
    assert.equal(f.player.health.activeProcesses,3);
    await wait(()=>f.frames.length>0);
    assert.equal(f.frames[0],0x22,"promotion must retain the first buffered packet");
  } finally {f.player.stop();assert.ok(f.procs.every(p=>p.killed));t.mock.restoreAll();syncBuiltinESMExports();}
});
test("prebuffering is off by default and discards stale work when the queue changes",async t=>{
  const f=setup(t);
  try {
    f.player.enqueue([tracks[0]!,tracks[1]!]);f.player.seek(200);
    await new Promise(r=>setTimeout(r,30));
    assert.equal(f.player.health.activeProcesses,3);
    f.player.setPrebuffer(true);
    await wait(()=>f.player.health.activeProcesses===6);
    const pending=f.procs.filter(p=>!p.killed).slice(-3);
    f.player.removeAt(1);
    assert.ok(pending.every(p=>p.killed));
    assert.equal(f.player.health.activeProcesses,3);
    f.player.setPrebuffer(false);
    assert.equal(f.player.health.prebufferStatus,"off");
  } finally {f.player.stop();t.mock.restoreAll();syncBuiltinESMExports();}
});
test("temporary decoder failures retry at the current offset twice before advancing the queue",async t=>{
  const f=setup(t);
  try {
    f.player.enqueue([tracks[0]!,tracks[1]!]);f.player.seek(70);
    for(let attempt=1;attempt<=2;attempt++){
      const encoder=f.encoder();
      encoder.stderr.write("Connection reset by peer");
      encoder.emit("close",1);
      await wait(()=>f.player.health.retrying);
      assert.equal(f.player.health.retryAttempt,attempt);
      assert.equal(f.player.elapsed,70);assert.equal(f.player.queue.length,1);
      await wait(()=>!f.player.health.retrying);
      const decoder=f.procs.filter(p=>p.args.includes("-ss")&&!p.killed).at(-1)!;
      assert.equal(decoder.args[decoder.args.indexOf("-ss")+1],"70");
    }
    f.encoder().stderr.write("Connection reset by peer");f.encoder().emit("close",1);
    await wait(()=>f.player.track?.url===tracks[1]!.url);
    assert.equal(f.player.queue.length,0);
  } finally {f.player.stop();t.mock.restoreAll();syncBuiltinESMExports();}
});
test("a stalled audio stream triggers bounded recovery instead of buffering forever",async t=>{
  const f=setup(t);
  let clock=Date.now();
  t.mock.method(Date,"now",()=>clock);
  try {
    f.player.enqueue([tracks[0]!,tracks[1]!]);
    clock+=31_000;
    await wait(()=>f.player.health.retrying);
    assert.match(f.player.health.lastError!,/stalled/);
    assert.equal(f.player.track?.url,tracks[0]!.url);
    assert.equal(f.player.queue.length,1);
  } finally {f.player.stop();t.mock.restoreAll();syncBuiltinESMExports();}
});
