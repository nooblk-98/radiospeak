import test from "node:test";
import assert from "node:assert/strict";
import { fixture, tracks } from "./helpers.ts";
import { PlaylistStore } from "../src/store.ts";
import { join } from "node:path";
import { MusicBot, WelcomeLimiter } from "../src/bot.ts";
import { welcomeText } from "../src/commands.ts";
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

test("login sessions protect the panel; Basic auth only reaches the API; JSON-only writes and malformed requests are rejected",async()=>{
  const f=await fixture("test-password");
  try {
    const login=(password:string,remember=false)=>fetch(f.base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password,remember})});
    const basic={Authorization:"Basic "+Buffer.from("x:test-password").toString("base64")};
    for(const path of ["/","/app.js","/styles.css"]) {
      const page=await fetch(f.base+path,{redirect:"manual",headers:basic});
      assert.equal(page.status,302,"pages need a session, even with cached Basic credentials");
      assert.equal(page.headers.get("location"),"/login");
    }
    const unauth=await fetch(f.base+"/api/state");
    assert.equal(unauth.status,401);
    assert.equal(unauth.headers.get("www-authenticate"),null,"no browser password popup");
    assert.equal((await fetch(f.base+"/api/state",{headers:basic})).status,200,"scripts can still use Basic auth");
    const form=await fetch(f.base+"/login");
    assert.equal(form.status,200);
    assert.match(await form.text(),/current-password/);
    const wrong=await login("nope");
    assert.equal(wrong.status,401);
    assert.equal(wrong.headers.get("set-cookie"),null);
    const ok=await login("test-password",true);
    assert.equal(ok.status,200);
    const setCookie=ok.headers.get("set-cookie")!;
    for(const flag of [/HttpOnly/,/SameSite=Lax/,/Max-Age=2592000/]) assert.match(setCookie,flag);
    const headers={Cookie:setCookie.split(";")[0]!};
    assert.equal((await fetch(f.base+"/login",{headers,redirect:"manual"})).status,302,"signed-in visitors skip the form");
    const forged={Cookie:headers.Cookie.replace(/=(\d)/,(_,d)=>"="+(d==="9"?"8":"9"))};
    assert.equal((await fetch(f.base+"/api/state",{headers:forged})).status,401,"a tampered expiry fails the signature");
    for(const path of ["/","/app.js","/styles.css","/api/state"]) {
      const response=await fetch(f.base+path,{headers});
      assert.equal(response.status,200);
      if(path==="/") assert.match(await response.text(),/player-dock/);
    }
    assert.equal((await f.api("/api/state")).data.authEnabled,true);
    const html=await (await fetch(f.base+"/",{headers})).text();
    const version=(await f.api("/api/state")).data.uiVersion;
    assert.match(version,/^[a-f0-9]{16}$/);
    assert.ok(html.includes('/app.js?v='+version));
    assert.ok(html.includes('/styles.css?v='+version));
    const script=await (await fetch(f.base+"/app.js?v="+version,{headers})).text();
    for(const module of ["api","volume","components"]) assert.ok(script.includes('./'+module+'.js?v='+version));
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers,body:"name=bad"})).status,415);
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:"null"})).status,400);
    assert.equal((await fetch(f.base+"/api/%ZZ",{headers})).status,400);
    assert.equal((await fetch(f.base+"/api/playlists",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({name:"x",padding:"x".repeat(270000)})})).status,413);
    const out=await fetch(f.base+"/api/logout",{method:"POST",headers});
    assert.match(out.headers.get("set-cookie")!,/Max-Age=0/);
    assert.equal((await fetch(f.base+"/api/state",{headers})).status,401,"a signed-out session cannot be reused");
    for(let i=0;i<5;i++) assert.equal((await login("nope")).status,401);
    assert.equal((await login("test-password")).status,429,"repeated failures lock out the address");
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

test("radio stations persist and tune in; playlist Play now replaces the queue; panel channel is remembered",async()=>{
  const f=await fixture(), p=f.app.bots[0]!.player, botPath="/api/bots/Test%20bot/";
  try {
    const names=()=>f.app.playlists.radioStations.map(r=>r.name);
    assert.deepEqual((await f.api("/api/state")).data.radioStations.map((r:{name:string})=>r.name),["Groove Salad","Drone Zone"]);
    assert.equal((await f.api("/api/radio-stations",{name:"Bad",url:"file:///etc/passwd"})).status,400);
    assert.equal((await f.api("/api/radio-stations",{name:"groove salad",url:"https://example.com/a"})).status,400);
    const station=(await f.api("/api/radio-stations",{name:"Jazz",url:"https://radio.example.com/jazz"})).data.station;
    assert.equal((await f.api("/api/radio-stations/"+station.id,{name:"Late jazz",url:"https://radio.example.com/late"},"PATCH")).status,200);
    assert.equal((await f.api(botPath+"radio",{stationId:"missing"})).status,404);

    p.stop();p.setDefaultPlaylist([tracks[0]!],"Idle");p.playIfIdle();
    assert.equal(p.track?.auto,true);
    assert.equal((await f.api(botPath+"radio",{stationId:station.id})).status,200);
    assert.equal(p.track,undefined,"a station replaces the idle playlist at once");
    assert.deepEqual(p.radio,{name:"Late jazz",url:"https://radio.example.com/late"});
    p.enqueue([tracks[1]!]);
    assert.equal((await f.api(botPath+"radio",{stationId:f.app.playlists.radioStations[0]!.id})).status,200);
    assert.equal(p.track?.url,tracks[1]!.url,"a user request keeps playing");
    assert.equal(p.radio?.name,"Groove Salad");

    const list=(await f.api("/api/playlists",{name:"Party"})).data.playlist;
    assert.equal((await f.api("/api/playlists/"+list.id+"/play-now",{bot:"Test bot"})).status,400);
    await f.api("/api/playlists/"+list.id+"/add",{tracks:tracks.slice(2)});
    p.enqueue([tracks[0]!,tracks[1]!]);
    assert.equal((await f.api("/api/playlists/"+list.id+"/play-now",{bot:"Test bot"})).status,200);
    assert.equal(p.track?.url,tracks[2]!.url);
    assert.equal(p.track?.requestedBy,"web");
    assert.deepEqual(p.queue.map(t=>t.url),[tracks[3]!.url],"the old queue is replaced");

    assert.equal((await f.api("/api/radio-stations/"+station.id,{},"DELETE")).status,200);
    assert.equal((await f.api("/api/radio-stations/"+f.app.playlists.radioStations[1]!.id,{},"DELETE")).status,200);
    assert.deepEqual(new PlaylistStore(join(f.dir,"library.json")).radioStations.map(r=>r.name),["Groove Salad"]);
    assert.deepEqual(names(),["Groove Salad"]);
    await f.api("/api/radio-stations/"+f.app.playlists.radioStations[0]!.id,{},"DELETE");
    assert.equal(new PlaylistStore(join(f.dir,"library.json")).radioStations.length,0,"starter stations are not re-added");

    assert.equal((await f.api("/api/state")).data.bots[0].homeChannel,null);
    f.app.playlists.setChannel("Test bot","Lounge/Music");
    await f.app.playlists.flush();
    assert.equal((await f.api("/api/state")).data.bots[0].homeChannel,"Lounge/Music");
    assert.equal(new PlaylistStore(join(f.dir,"library.json")).channelFor("Test bot"),"Lounge/Music");
  } finally {await f.close();}
});

test("bot instances can be added, switched independently, persisted and removed from the panel",async t=>{
  t.mock.method(MusicBot.prototype,"start",async()=>{});
  const f=await fixture();
  try {
    assert.equal((await f.api("/api/bots",{name:"bad name"})).status,400);
    assert.equal((await f.api("/api/bots",{name:"lobby",channelId:"999"})).status,404,"channels resolve through a connected bot");
    const created=await f.api("/api/bots",{name:"lobby",nickname:"Lobby Radio"});
    assert.equal(created.status,200);
    assert.equal(created.data.bot,"lobby");
    assert.equal((await f.api("/api/bots",{name:"LOBBY"})).status,409);
    const state=(await f.api("/api/state")).data;
    assert.deepEqual(state.bots.map((b:{name:string;removable:boolean})=>[b.name,b.removable]),[["Test bot",false],["lobby",true]]);
    assert.equal(state.bots[1].nickname,"Lobby Radio");
    assert.equal((await f.api("/api/bots/lobby/volume",{volume:30})).status,200);
    assert.equal(f.app.bots[1]!.player.volume,30);
    assert.equal(f.app.bots[0]!.player.volume,50,"instances keep separate players");
    const restarted=new PlaylistStore(join(f.dir,"library.json"));
    assert.deepEqual(restarted.panelBots,["lobby"]);
    assert.equal(restarted.nicknameFor("lobby"),"Lobby Radio");
    assert.equal((await f.api("/api/bots/Test%20bot",{},"DELETE")).status,400,"configured bots are not removable");
    const removed=await f.api("/api/bots/lobby",{},"DELETE");
    assert.equal(removed.status,200);
    assert.equal(removed.data.message,"Lobby Radio was removed.");
    assert.deepEqual(f.app.bots.map(b=>b.name),["Test bot"]);
    assert.deepEqual(new PlaylistStore(join(f.dir,"library.json")).panelBots,[]);
    assert.equal(f.app.playlists.nicknameFor("lobby"),undefined);
  } finally {await f.close();}
});

test("join greetings list the commands, respect per-person and channel limits, and can be turned off per bot",async()=>{
  const text=welcomeText("!","Nimal","Blue hour");
  assert.match(text,/Welcome, \[b\]Nimal\[\/b\]/);
  assert.match(text,/Now playing: \[b\]Blue hour\[\/b\]/);
  for(const command of ["!play","!skip","!radio","!help"]) assert.ok(text.includes(command));
  assert.doesNotMatch(welcomeText("!","Nimal",undefined),/Now playing/);
  const limiter=new WelcomeLimiter(), minute=60_000;
  assert.equal(limiter.allow("alice",0),true);
  assert.equal(limiter.allow("bob",5_000),false,"greetings are spaced to avoid flood limits");
  assert.equal(limiter.allow("bob",10_000),true);
  assert.equal(limiter.allow("alice",20*minute),false,"the same person is not greeted again within half an hour");
  assert.equal(limiter.allow("alice",31*minute),true);
  const f=await fixture();
  try {
    assert.equal((await f.api("/api/state")).data.bots[0].welcomes,true,"greetings are on by default");
    assert.equal((await f.api("/api/bots/Test%20bot/welcome",{enabled:false})).status,200);
    assert.equal((await f.api("/api/state")).data.bots[0].welcomes,false);
    assert.equal(new PlaylistStore(join(f.dir,"library.json")).welcomes("Test bot"),false);
    await f.api("/api/bots/Test%20bot/welcome",{enabled:true});
    assert.equal(f.app.playlists.welcomes("Test bot"),true);
  } finally {await f.close();}
});

test("songs added to a playing saved playlist join the queue after its other songs",async()=>{
  const f=await fixture(), p=f.app.bots[0]!.player;
  try {
    const party=(await f.api("/api/playlists",{name:"Party"})).data.playlist;
    const other=(await f.api("/api/playlists",{name:"Other"})).data.playlist;
    await f.api("/api/playlists/"+party.id+"/add",{tracks:tracks.slice(0,2)});
    assert.equal((await f.api("/api/playlists/"+party.id+"/play-now",{bot:"Test bot"})).status,200);
    p.enqueue([{...tracks[2]!,requestedBy:"someone"}]);
    const fresh={url:"https://www.youtube.com/watch?v=freshsong01",title:"Fresh song",duration:120};
    assert.equal((await f.api("/api/playlists/"+party.id+"/add",{tracks:[fresh]})).status,200);
    assert.deepEqual(p.queue.map(t=>t.url),[tracks[1]!.url,fresh.url,tracks[2]!.url],"new playlist songs come before later requests");
    assert.equal(p.queue[1]!.playlistId,party.id);
    assert.equal(p.queue[1]!.requestedBy,"web");
    await f.api("/api/playlists/"+party.id+"/add",{tracks:[tracks[1]]});
    assert.equal(p.queue.length,3,"songs already queued are not added twice");
    await f.api("/api/playlists/"+other.id+"/add",{tracks:[tracks[3]]});
    assert.equal(p.queue.length,3,"playlists that are not playing do not touch the queue");
    assert.equal(f.app.playlists.find(party.id)!.tracks.some(t=>"playlistId" in t),false,"saved playlists never store the queue tag");
    p.clearQueue();p.skip();
    await f.api("/api/playlists/"+party.id+"/add",{tracks:[{...fresh,url:"https://www.youtube.com/watch?v=latersong01"}]});
    assert.equal(p.queue.length,0,"a finished playlist no longer pulls new songs in");
  } finally {await f.close();}
});
