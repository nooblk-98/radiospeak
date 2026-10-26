import test from "node:test";
import assert from "node:assert/strict";
import { fixture, tracks } from "./helpers.ts";
import { PlaylistStore } from "../src/store.ts";
import { join } from "node:path";
import { MusicBot } from "../src/bot.ts";
import { Client } from "@honeybbq/teamspeak/client";

test("HTTP queue edits reject stale snapshots; playlist/default/favorite lifecycle persists", async () => {
  const f = await fixture();
  const botPath="/api/bots/Test%20bot/";
  try {
    let result=await f.api("/api/state");
    assert.equal(result.data.bots[0].queue.length,3);
    const expected=result.data.bots[0].queue.map((t:{url:string})=>t.url);
    assert.equal((await f.api(botPath+"move",{from:3,to:1,expected})).status,200);
    assert.equal((await f.api(botPath+"remove",{position:1,expected})).status,409);
    assert.equal(f.app.bots[0]!.player.queue.length,3);
    assert.equal(f.app.bots[0]!.player.queue[0]?.url,tracks[3]!.url);
    assert.equal((await f.api(botPath+"remove",{position:0})).status,404);
    assert.equal((await f.api(botPath+"volume",{volume:"bad"})).status,400);
    assert.equal((await f.api(botPath+"radio",{url:"file:///private"})).status,400);
    assert.equal((await f.api(botPath+"enqueue",{tracks:[null,{}]})).status,400);
    assert.equal((await f.api(botPath+"channel",{channelId:"1"})).status,400);
    const collection=(await f.api("/api/collections",{name:"Chill"})).data.collection;
    const list=(await f.api("/api/playlists",{name:"Night sessions",collectionId:collection.id})).data.playlist;
    assert.equal((await f.api(botPath+"default",{playlistId:list.id})).status,400);
    assert.equal((await f.api("/api/playlists/"+list.id+"/add",{tracks})).status,200);
    assert.equal((await f.api(botPath+"default",{playlistId:list.id})).status,200);
    assert.equal((await f.api("/api/playlists/"+list.id,{name:"Evening sessions"},"PATCH")).status,200);
    assert.equal(f.app.bots[0]!.player.defaultPlaylist.name,"Evening sessions");
    assert.equal((await f.api("/api/favorites",{track:tracks[0]})).status,200);
    const restarted=new PlaylistStore(join(f.dir,"library.json"));
    assert.equal(restarted.defaultFor("Test bot")?.name,"Evening sessions");
    assert.equal(restarted.favorites.length,1);
    assert.equal((await f.api("/api/playlists/"+list.id+"/move",{from:1,to:3,expected:tracks.map(t=>t.url)})).status,200);
    assert.equal((await f.api("/api/playlists/"+list.id+"/tracks/1",{expected:tracks.map(t=>t.url)},"DELETE")).status,409);
    await f.api("/api/collections/"+collection.id,{},"DELETE");
    assert.equal(f.app.playlists.find(list.id)?.collectionId,null);
    await f.api("/api/playlists/"+list.id,{},"DELETE");
    assert.equal(f.app.bots[0]!.player.defaultPlaylist.size,0);
    assert.equal(f.app.playlists.defaults["Test bot"],null);
  } finally {await f.close();}
});

test("player controls seek, previous, shuffle, stop, and play-now preserve queue semantics",async()=>{
  const f=await fixture(), p=f.app.bots[0]!.player;
  try {
    assert.ok(p.seek(50));assert.equal(p.elapsed,50);
    assert.ok(p.previous());assert.equal(p.elapsed,0);
    assert.ok(p.moveAt(3,1));assert.equal(p.queue[0]?.url,tracks[3]!.url);
    p.setShuffle(true);assert.equal(p.shuffleEnabled,true);assert.equal(p.queue.length,3);
    p.setShuffle(false);p.setLoop("one");assert.equal(p.loop,"one");
    p.setNormalization(true);assert.equal(p.normalization,true);
    p.stop();
    p.setDefaultPlaylist([tracks[1]!],"Fallback");
    assert.equal(p.track,undefined,"library refresh must not undo Stop");
    p.pause();p.enqueue([tracks[0]!,tracks[2]!]);
    assert.equal(p.track?.url,tracks[0]!.url);
    p.playNow([tracks[3]!]);
    assert.equal(p.track?.url,tracks[3]!.url);
    assert.equal(p.queue[0]?.url,tracks[2]!.url);
    p.pause();p.previous();
    assert.equal(p.track?.url,tracks[0]!.url);
    assert.equal(p.queue[0]?.url,tracks[3]!.url);
    p.stop();assert.equal(p.elapsed,0);
  } finally {await f.close();}
});

test("static assets keep authentication; JSON-only writes and malformed requests are rejected",async()=>{
  const f=await fixture("test-password");
  try {
    for(const path of ["/","/app.js","/styles.css","/api/state"]) {
      const unauth=await fetch(f.base+path);assert.equal(unauth.status,401);
      const auth=await fetch(f.base+path,{headers:{Authorization:"Basic "+Buffer.from("x:test-password").toString("base64")}});
      assert.equal(auth.status,200);
      if(path==="/") assert.match(await auth.text(),/player-dock/);
    }
    const headers={Authorization:"Basic "+Buffer.from("x:test-password").toString("base64")};
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers,body:"name=bad"})).status,415);
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:"null"})).status,400);
    assert.equal((await fetch(f.base+"/api/%ZZ",{headers})).status,400);
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({name:"x",padding:"x".repeat(270000)})})).status,413);
  } finally {await f.close();}
});

test("custom bot names validate, persist per bot, and stay fixed through track changes",async t=>{
  const f=await fixture(), bot=f.app.bots[0]!, path="/api/bots/Test%20bot/nickname";
  try {
    for(const nickname of ["", " ".repeat(4), "x".repeat(31), "Bad\u0000Name"]) {
      assert.equal((await f.api(path,{nickname})).status,400);
    }
    assert.equal((await f.api(path,{nickname:"  radiospeak  "})).status,200);
    assert.equal(bot.nickname,"radiospeak");
    assert.equal(bot.name,"Test bot","the stable bot identifier must not change");
    assert.equal((await f.api("/api/state")).data.bots[0].nickname,"radiospeak");
    const restored=new PlaylistStore(join(f.dir,"library.json"));
    assert.equal(restored.nicknameFor("Test bot"),"radiospeak");
    assert.equal(restored.nicknameFor("other bot"),undefined);
    const restarted=new MusicBot({...f.app,playlists:restored},bot.cfg,0);
    assert.equal(restarted.nickname,"radiospeak");
    const listeners=new Map<string,Function>(), commands:any[]=[];
    t.mock.method(Client.prototype,"on",function(event:string,handler:Function) {
      listeners.set(event,handler);return ()=>{};
    });
    t.mock.method(Client.prototype,"connect",async function() {
      listeners.get("connected")?.({reconnected:false});
    });
    t.mock.method(Client.prototype,"send",async function(command:any) {
      commands.push(command);return [];
    });
    t.mock.method(Client.prototype,"disconnect",async()=>{});
    f.app.config.identityLevel=0;
    f.app.config.songInDescription=false;
    await bot.start();
    assert.equal(bot.connected,true);
    assert.equal((await f.api(path,{nickname:"Community Radio"})).status,200);
    const renameCommands=()=>commands.filter(c=>JSON.stringify(c).includes("client_nickname"));
    assert.equal(renameCommands().length,1,"explicit settings change sends one rename");
    bot.player.skip();
    bot.player.skip();
    await new Promise(resolve=>setTimeout(resolve,1700));
    assert.equal(renameCommands().length,1,"song changes must never send nickname updates");
    assert.equal(bot.nickname,"Community Radio");
    t.mock.method(Client.prototype,"send",async()=>{throw new Error("Nickname is already in use");});
    assert.equal((await f.api(path,{nickname:"Rejected name"})).status,400);
    assert.equal(bot.nickname,"Community Radio","a refused live rename must not overwrite the saved name");
    await bot.shutdown();
  } finally {await f.close();}
});
