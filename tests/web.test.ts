import test from "node:test";
import assert from "node:assert/strict";
import { fixture, tracks } from "./helpers.ts";
import { PlaylistStore } from "../src/store.ts";
import { join } from "node:path";

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
