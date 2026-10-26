import test from "node:test";
import assert from "node:assert/strict";
import { EnqueueControl, queueTrackKey } from "../src/web/enqueue.js";
import { trackKey } from "../src/track-key.ts";
import { fixture, tracks } from "./helpers.ts";

test("enqueue guards survive re-renders, normalize URLs, follow queue removal and unlock after failure",async()=>{
  const track=tracks[0]!,alternate={...track,url:'https://youtu.be/abcdefghijk?t=10'};
  let release!:()=>void,calls=0,fail=false;
  const one={name:'one',track:null,queue:[] as typeof tracks},two={...one,name:'two',queue:[] as typeof tracks};
  const control=new EnqueueControl({send:async(name:string)=>{calls++;if(fail)throw new Error('Network failure');await new Promise<void>(r=>{release=r;});(name==='one'?one:two).queue.push(track);}});
  const first=control.add(one,track);assert.equal(control.state(one,alternate),'adding');
  assert.equal(await control.add(one,alternate),false);assert.equal(calls,1);assert.equal(control.state(two,track),'idle');
  release();await first;assert.equal(control.state(one,alternate),'queued');assert.equal(await control.add(one,track),false);
  one.queue=[];assert.equal(control.state(one,track),'idle');fail=true;await assert.rejects(control.add(one,track),/Network failure/);assert.equal(control.state(one,track),'idle');
  for(const url of [track.url,alternate.url,'https://music.youtube.com/watch?v=abcdefghijk&list=123','https://www.youtube.com/shorts/abcdefghijk','https://soundcloud.com/example/night#comment','https://radio.example.com/live?station=1'])assert.equal(queueTrackKey(url),trackKey(url));
});

test("unique enqueue rejects overlapping duplicates and alternate links without blocking later re-addition",async()=>{
  const f=await fixture(),path='/api/bots/Test%20bot/enqueue';
  try {
    const track={url:'https://www.youtube.com/watch?v=newtrack123',title:'New request',duration:180};
    const responses=await Promise.all(Array.from({length:5},(_,i)=>f.api(path,{tracks:[{...track,url:i%2?'https://youtu.be/newtrack123':track.url}],unique:true})));
    assert.ok(responses.every(r=>r.status===200));assert.equal(responses.reduce((n,r)=>n+r.data.added,0),1);
    assert.ok(responses.every(r=>!r.data.message.includes('[b]')),'API confirmation uses plain text');
    const player=f.app.bots[0]!.player;assert.equal(player.queue.filter(t=>trackKey(t.url)===trackKey(track.url)).length,1);
    assert.equal((await f.api(path,{tracks:[tracks[0]],unique:true})).data.added,0,'currently playing tracks cannot be accidentally duplicated');
    player.removeAt(player.queue.findIndex(t=>trackKey(t.url)===trackKey(track.url))+1);
    assert.equal((await f.api(path,{tracks:[track],unique:true})).data.added,1,'removed tracks can be added again');
    const before=player.queue.length;assert.equal((await f.api(path,{tracks:[track]})).status,200);assert.equal(player.queue.length,before+1,'explicit repeat requests keep the existing API behavior');
  }finally{await f.close();}
});
