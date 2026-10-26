import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@honeybbq/teamspeak/client";
import { Player } from "../src/player.ts";
import { MusicBot } from "../src/bot.ts";
import { PlaybackStore } from "../src/playback-store.ts";
import { fixture, tracks } from "./helpers.ts";

const makePlayer = () => new Player({
  ffmpegPath: process.execPath, ytdlpPath: process.execPath, bitrateKbps: 96,
  volume: 50, connectionPaused: true, log() {}, sendFrame() {},
});

test("process recovery restores track position, user queue, idle cursor and explicit Stop", async () => {
  const f = await fixture(), player = makePlayer(), restored = makePlayer();
  try {
    const path = join(f.dir,"playback.json"), idle = tracks.slice(0,3);
    player.setDefaultPlaylist(idle,"Chill");
    player.skip();
    player.enqueue([tracks[3]!, tracks[0]!]);
    player.seek(74);
    player.setVolume(33);
    player.setLoop("one");
    const store = new PlaybackStore(path);
    store.set("music",player.snapshot());
    restored.restore(new PlaybackStore(path).get("music")!);
    restored.setDefaultPlaylist(idle,"Chill");
    assert.equal(restored.track?.url,tracks[3]!.url);
    assert.equal(restored.elapsed,74);
    assert.equal(restored.queue[0]?.url,tracks[0]!.url);
    assert.equal(restored.volume,33);
    assert.equal(restored.loop,"one");
    assert.equal(restored.connectionPaused,true,"restoring must not consume audio before connecting");
    restored.skip();
    restored.skip();
    assert.equal(restored.track?.url,tracks[2]!.url,"idle playback resumes at the saved cursor");
    player.stop();
    store.set("music",player.snapshot());
    restored.restore(new PlaybackStore(path).get("music")!);
    restored.setDefaultPlaylist(idle,"Chill");
    assert.equal(restored.track,undefined,"a saved Stop must survive a process restart");
    assert.equal(restored.queue.length,0);
    const warnings:string[]=[];
    writeFileSync(path,"{invalid json");
    assert.equal(new PlaybackStore(path,message=>warnings.push(message)).get("music"),undefined);
    assert.equal(warnings.length,1,"a corrupt checkpoint warns without crashing startup");
    assert.throws(()=>restored.restore({...player.snapshot(),elapsed:NaN}),/Invalid playback/);
    const failure = new PlaybackStore(join(f.dir,"missing","playback.json"),message=>warnings.push(message));
    failure.set("music",player.snapshot());
    assert.equal(warnings.length,2,"checkpoint write errors must not crash playback");
  } finally {player.stop();restored.stop();await f.close();}
});

test("welcome interruption and reconnect preserve one session's track, queue, and saved progress", async t => {
  const f = await fixture();
  const listeners = new Map<string,Function>();
  const ready = t.mock.fn(()=>Promise.reject(new Error("roster interrupted")));
  t.mock.method(Client.prototype,"on",function(event:string,handler:Function) {
    listeners.set(event,handler);return ()=>{};
  });
  let connects = 0;
  t.mock.method(Client.prototype,"connect",async function() {
    connects++;
    listeners.get("connected")?.({reconnected:false});
  });
  t.mock.method(Client.prototype,"send",async()=>[]);
  t.mock.method(Client.prototype,"disconnect",async()=>{});
  t.mock.getter(Client.prototype,"view",()=>({
    whenReady:ready, status:"loading", self:undefined, channel:()=>undefined,
    clientsIn:()=>[], channels:new Map(),
  }));
  const original = f.app.bots[0]!;
  const store = new PlaybackStore(join(f.dir,"playback.json"));
  const saved = {...original.player.snapshot(),elapsed:63};
  original.player.stop();
  store.set(original.name,saved);
  f.app.playback = store;
  const bot = new MusicBot(f.app,original.cfg,0);
  bot.log=()=>{};
  f.app.bots=[bot];
  f.app.config.identityLevel=0;
  f.app.config.songInDescription=false;
  const loadDefault = t.mock.method(bot,"loadDefaultPlaylist",async()=>{});
  try {
    await bot.start();
    assert.equal(ready.mock.callCount(),0,"welcome handling must not create a rejecting readiness promise");
    assert.equal(bot.player.connectionPaused,true);
    const client=bot.client;
    listeners.get("disconnected")?.({error:new Error("temporary transport loss"),willReconnect:true});
    assert.equal(bot.player.elapsed,63);
    assert.equal(bot.player.track?.url,saved.track?.url);
    assert.deepEqual(bot.player.queue,saved.queue);
    assert.equal(bot.lastDisconnect?.reason,"temporary transport loss");
    listeners.get("connected")?.({reconnected:true});
    listeners.get("viewReady")?.({});
    assert.equal(bot.client,client);
    assert.equal(connects,1,"SDK reconnect must not create a competing client");
    assert.equal(loadDefault.mock.callCount(),1,"reconnection must not reload the idle playlist");
    assert.equal(bot.player.connectionPaused,false);
    assert.equal(bot.player.userPaused,true,"a user pause must survive reconnection");
    assert.equal(bot.player.elapsed,63);
    await bot.shutdown();
    const restart = new MusicBot({...f.app,playback:new PlaybackStore(join(f.dir,"playback.json"))},bot.cfg,0);
    assert.equal(restart.player.track?.url,saved.track?.url,"graceful shutdown must not overwrite playback with Stop");
    assert.equal(restart.player.elapsed,63);
    restart.player.stop();
  } finally {await bot.shutdown();await f.close();}
});
