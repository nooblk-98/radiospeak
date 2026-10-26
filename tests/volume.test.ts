import test from "node:test";
import assert from "node:assert/strict";
import { AudioGain } from "../src/audio-gain.ts";
import { VolumeControl } from "../src/web/volume.js";

test("volume slider sends input without waiting for release and serializes rapid changes",async()=>{
  const calls:Array<[string,number]>=[],releases:Array<()=>void>=[];
  const control=new VolumeControl({send:(name:string,value:number)=>{calls.push([name,value]);return new Promise<void>(r=>releases.push(r));}});
  try {
    control.set("one",30);
    await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(calls,[["one",30]]);
    control.set("one",10);control.set("one",80);control.set("one",25,true);
    assert.equal(calls.length,1,"requests must not race");
    releases.shift()!();await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(calls,[["one",30],["one",25]],"only the latest unsent slider value is needed");
    releases.shift()!();await new Promise(r=>setImmediate(r));
    assert.equal(control.get("one"),undefined);
  } finally {control.dispose();}
});

test("gain holds unscaled samples until encoder capacity is available, then applies the latest gain",async()=>{
  let volume=1,submitted=0,played=0;
  const gain=new AudioGain(()=>volume,()=>submitted-played<2,()=>submitted++);
  const frames:Buffer[]=[];gain.on("data",frame=>frames.push(frame));
  const pcm=Buffer.alloc(3840*6);
  for(let offset=0;offset<pcm.length;offset+=2)pcm.writeInt16LE(10000,offset);
  try {
    gain.end(pcm);
    assert.equal(frames.length,2);
    volume=0.25;played=2;
    await new Promise(r=>setTimeout(r,15));
    assert.equal(frames.length,4);
    assert.equal(frames[3]!.readInt16LE(0),2500,"buffered raw PCM must use the new gain, not its decode-time gain");
    volume=0;played=4;
    await new Promise(r=>setTimeout(r,15));
    assert.ok(frames[5]!.every(byte=>byte===0),"mute must produce silence");
  } finally {gain.destroy();}
});
