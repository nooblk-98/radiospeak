import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Player } from "../src/player.ts";

function wave() {
  const samples=48000*20, buffer=Buffer.alloc(44+samples*4);
  buffer.write("RIFF");buffer.writeUInt32LE(buffer.length-8,4);buffer.write("WAVEfmt ",8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(2,22);
  buffer.writeUInt32LE(48000,24);buffer.writeUInt32LE(192000,28);buffer.writeUInt16LE(4,32);buffer.writeUInt16LE(16,34);
  buffer.write("data",36);buffer.writeUInt32LE(samples*4,40);
  for(let i=0;i<samples;i++) {const value=Math.round(8000*Math.sin(i*2*Math.PI*440/48000));buffer.writeInt16LE(value,44+i*4);buffer.writeInt16LE(value,46+i*4);}
  return buffer;
}
function page(packet:Buffer,sequence:number,granule:number,flags=0) {
  const segments=Math.floor(packet.length/255)+1, buffer=Buffer.alloc(27+segments+packet.length);
  buffer.write("OggS");buffer[5]=flags;buffer.writeBigUInt64LE(BigInt(granule),6);
  buffer.writeUInt32LE(1,14);buffer.writeUInt32LE(sequence,18);buffer[26]=segments;
  for(let i=0;i<segments;i++) buffer[27+i]=Math.min(255,packet.length-i*255);
  packet.copy(buffer,27+segments);
  let crc=0;
  for(const byte of buffer) {crc=(crc^(byte<<24))>>>0;for(let i=0;i<8;i++) crc=((crc<<1)^((crc&0x80000000)?0x04c11db7:0))>>>0;}
  buffer.writeUInt32LE(crc,22);return buffer;
}
function ogg(packets:Buffer[]) {
  const head=Buffer.alloc(19);head.write("OpusHead");head[8]=1;head[9]=2;head.writeUInt32LE(48000,12);
  const tags=Buffer.alloc(16);tags.write("OpusTags");
  return Buffer.concat([page(head,0,0,2),page(tags,1,0),...packets.map((packet,i)=>page(packet,i+2,(i+1)*960,i===packets.length-1?4:0))]);
}
function rms(pcm:Buffer,startFrame:number,endFrame:number) {
  let sum=0,count=0;
  for(let offset=startFrame*3840;offset<Math.min(pcm.length,endFrame*3840);offset+=2){const n=pcm.readInt16LE(offset);sum+=n*n;count++;}
  return Math.sqrt(sum/count);
}
for(const normalization of [false,true]) test("real Opus output follows live volume changes"+(normalization?" with normalization":""),{skip:!process.env.FFMPEG_PATH,timeout:20000},async t=>{
  const running=new Set<ChildProcess>(),spawn=childProcess.spawn;
  t.mock.method(childProcess,"spawn",(...args:Parameters<typeof spawn>)=>{
    const child=spawn(...args);running.add(child);
    child.once("close",()=>running.delete(child));
    return child;
  });
  syncBuiltinESMExports();
  const binary=process.env.FFMPEG_PATH!, audio=wave();
  const server=createServer((_req,res)=>res.writeHead(200,{"Content-Type":"audio/wav","Content-Length":audio.length}).end(audio));
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const packets:Buffer[]=[],errors:string[]=[];
  let finish:()=>void;
  const done=new Promise<void>(accept=>{finish=accept;});
  const player=new Player({ffmpegPath:binary,ytdlpPath:"unused",bitrateKbps:96,volume:100,log(level,message){if(level==="warn"||level==="error")errors.push(message);},sendFrame(frame){
    if(!frame.length)return;
    packets.push(Buffer.from(frame));
    if(packets.length===40)player.setVolume(25);
    if(packets.length===110)player.setVolume(100);
    if(packets.length===170)finish!();
  }});
  let timer:ReturnType<typeof setTimeout>;
  try {
    player.setNormalization(normalization);
    player.playRadio({name:"Test tone",url:"http://127.0.0.1:"+address.port+"/tone.wav"});
    await Promise.race([done,new Promise((_accept,reject)=>{timer=setTimeout(()=>reject(new Error("Audio timeout: "+JSON.stringify(player.health)+" "+errors.join(";"))),15000);})]);
    player.stop();
    const decoded=execFileSync(binary,["-hide_banner","-loglevel","error","-f","ogg","-i","pipe:0","-f","s16le","-ac","2","-ar","48000","pipe:1"],{input:ogg(packets),maxBuffer:16*1024*1024,windowsHide:true});
    const loud=rms(decoded,10,30),quiet=rms(decoded,85,100),restored=rms(decoded,150,165);
    assert.ok(loud>500);
    assert.ok(quiet/loud>0.18&&quiet/loud<0.33,"25% volume must produce roughly a quarter of the decoded amplitude: "+quiet/loud);
    assert.ok(restored/loud>0.85&&restored/loud<1.15,"unmuted volume must return to its original amplitude");
  } finally {
    clearTimeout(timer!);player.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    try {
      const deadline=Date.now()+2000;
      while(running.size&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
      assert.equal(running.size,0,"stopping playback must close every FFmpeg process, including blocked decoders");
    } finally {
      for(const child of running) child.kill("SIGKILL");
      t.mock.restoreAll();syncBuiltinESMExports();
    }
  }
});
