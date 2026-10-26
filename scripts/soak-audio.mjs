// Isolated synthetic soak: no TeamSpeak connection and no production data.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Player } from '../src/player.ts';
import { PlaylistStore } from '../src/store.ts';
import { ImportManager } from '../src/imports.ts';
import { PlaybackStore } from '../src/playback-store.ts';

const argument=(name,fallback)=>Number(process.argv[process.argv.indexOf(name)+1])||fallback;
const seconds=argument('--seconds',7200),count=argument('--bots',3);
if(!Number.isInteger(seconds)||seconds<5||seconds>86400||!Number.isInteger(count)||count<1||count>10)throw new Error('Use --seconds 5..86400 and --bots 1..10');
const binary=process.env.FFMPEG_PATH||'ffmpeg',children=new Set(),spawn=childProcess.spawn;
childProcess.spawn=(path,args,options)=>{
  // Serve finite WAV tracks through real FFmpeg instead of contacting a media provider.
  const child=path==='soak-source'?spawn(binary,['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-i',args.at(-1),'-threads','1','-f','wav','pipe:1'],options):spawn(path,args,options);
  children.add(child);child.once('close',()=>children.delete(child));return child;
};syncBuiltinESMExports();
const samples=48000*8,audio=Buffer.alloc(44+samples*4);
audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(2,22);audio.writeUInt32LE(48000,24);audio.writeUInt32LE(192000,28);audio.writeUInt16LE(4,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(samples*4,40);
for(let i=0;i<samples;i++){const value=Math.round(4000*Math.sin(i*2*Math.PI*440/48000));audio.writeInt16LE(value,44+i*4);audio.writeInt16LE(value,46+i*4);}
const server=createServer((_req,res)=>res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length}).end(audio));server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port+'/tone.wav',dir=await mkdtemp(join(tmpdir(),'radiospeak-soak-'));
const store=new PlaylistStore(join(dir,'library.json')),checkpoints=new PlaybackStore(join(dir,'playback.json')),list=store.create('Soak imports');
const media=Array.from({length:20},(_,i)=>({url:url+'?track='+i,title:'Soak track '+i,duration:8}));
const imports=new ImportManager(store,'unused',300,async(_path,_input,options)=>{
  for(let i=0;i<media.length;i++)options.onEntry?.({index:i+1,track:media[i]});return {tracks:media,total:media.length};
});
const frames=Array(count).fill(0),starts=Array(count).fill(0),lastFrames=Array(count).fill(0),lastAdvance=Array(count).fill(Date.now()),errors=[],players=Array.from({length:count},(_,i)=>new Player({ffmpegPath:binary,ytdlpPath:'soak-source',volume:60,bitrateKbps:96,sendFrame:frame=>{if(frame.length)frames[i]++;},log:(level,message)=>{if(level==='error'||message.startsWith('Retrying '))errors.push(message);if(level==='warn'||level==='error')console.log(JSON.stringify({bot:i,level,message}));},onEvent:event=>{if(event.type==='trackStart')starts[i]++;}}));
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let stop=false;process.once('SIGTERM',()=>{stop=true;});process.once('SIGINT',()=>{stop=true;});
let peakRss=0,peakChildren=0,iterations=0;
const started=Date.now();
try {
  players.forEach(player=>{player.configure({audioProfile:'balanced'});player.setPrebuffer(true);player.setDefaultPlaylist(media,'Soak rotation');});
  while(!stop && Date.now()-started<seconds*1000) {
    for(const [i,player] of players.entries()) {
      if(frames[i]!==lastFrames[i]||player.paused){lastAdvance[i]=Date.now();lastFrames[i]=frames[i];}
      if(Date.now()-lastAdvance[i]>20000)throw new Error('Bot '+i+' stopped advancing: '+JSON.stringify(player.health));
      player.setVolume([25,60,100][iterations%3]);
      if(iterations%10===3)player.pause();else if(iterations%10===4)player.resume();
      if(iterations%20===7)player.playRadio({name:'Synthetic radio',url});
      if(iterations%20===9)player.playRadio(undefined);
      if(player.queue.length<2 && iterations%4===0)player.enqueue(media.slice(0,3));
      checkpoints.set('soak-'+i,player.snapshot());
    }
    if(iterations%10===0){imports.start(list.id,'synthetic://batch',true);}
    peakRss=Math.max(peakRss,process.memoryUsage().rss);peakChildren=Math.max(peakChildren,children.size);
    if(iterations%5===0)console.log(JSON.stringify({seconds:Math.round((Date.now()-started)/1000),frames:[...frames],trackStarts:[...starts],memoryMiB:Math.round(process.memoryUsage().rss/1048576),children:children.size,eventLoopP99Ms:Math.round(lag.percentile(99)/1e6),underruns:players.map(p=>p.health.underruns),frameTiming:players.map(p=>p.health.frameTiming),playback:players.map(p=>({elapsed:p.elapsed,paused:p.paused,buffered:p.health.bufferedSeconds,inFlight:p.health.encoderInFlight,buffering:p.health.buffering,retry:p.health.retrying,lastError:p.health.lastError})),importedTracks:list.tracks.length}));
    if(children.size>count*9+6)throw new Error('Audio process count exceeded the bounded preparation and teardown budget');
    if(errors.length)throw new Error('Synthetic playback required unexpected recovery: '+errors.join('; '));
    iterations++;await sleep(Math.min(2000,Math.max(1,seconds*1000-(Date.now()-started))));
  }
  if(frames.some(n=>n<50)||errors.length)throw new Error('Soak playback failed: '+errors.join('; '));
  console.log(JSON.stringify({result:'passed',seconds:Math.round((Date.now()-started)/1000),bots:count,frames,trackStarts:starts,peakNodeRssMiB:Math.round(peakRss/1048576),peakChildren,underruns:players.map(p=>p.health.underruns),importedTracks:list.tracks.length}));
}finally {
  lag.disable();players.forEach(p=>p.stop());await imports.shutdown();await store.flush();await checkpoints.flush();
  const until=Date.now()+3000;while(children.size&&Date.now()<until)await sleep(25);
  server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
  if(children.size){for(const child of children)child.kill('SIGKILL');throw new Error('Soak left audio child processes running');}
}
