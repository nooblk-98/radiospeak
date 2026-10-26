import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaylistStore } from "../src/store.ts";
import { tracks } from "./helpers.ts";

test("legacy playlists migrate without losing metadata; hierarchy, defaults, favorites survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(),"radiospeak-library-")), path = join(dir,"playlists.json");
  try {
    writeFileSync(path,JSON.stringify([{name:"Legacy",tracks:[tracks[0]]}]));
    let store = new PlaylistStore(path);
    const legacy = store.find("Legacy")!;
    assert.ok(legacy.id);
    const collection = store.createCollection("Chill sessions");
    store.update(legacy,"Old favorites",collection.id);
    store.addTracks(legacy,[{...tracks[1]!,requestedBy:"someone",auto:true},tracks[2]!]);
    store.setDefault("bot1",legacy);
    store.moveTrack(legacy,3,1);
    store.toggleFavorite(tracks[1]!);
    await store.flush();
    store = new PlaylistStore(path);
    assert.equal(store.all[0]!.collectionId,collection.id);
    assert.equal(store.defaultFor("bot1")?.name,"Old favorites");
    assert.equal(store.defaultFor("bot1")?.tracks[0]?.url,tracks[2]!.url);
    assert.equal(store.favorites[0]?.artist,"Test channel");
    assert.equal(store.all[0]!.tracks[2]?.auto,undefined);
    assert.equal(store.all[0]!.tracks[2]?.requestedBy,undefined);
    store.renameCollection(collection.id,"Quiet hours");
    store.deleteCollection(collection.id);
    assert.equal(store.all[0]!.collectionId,null);
    assert.equal(store.collections.length,0);
    store.delete(store.all[0]!);
    await store.flush();
    store = new PlaylistStore(path);
    assert.equal(store.defaults.bot1,null);
    assert.equal(store.defaultFor("bot1"),undefined);
    assert.equal(JSON.parse(readFileSync(path,"utf8")).version,2);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("invalid positions never remove the last track; names and empty defaults are validated", async () => {
  const dir=mkdtempSync(join(tmpdir(),"radiospeak-validation-"));
  try {
    const store=new PlaylistStore(join(dir,"library.json")), list=store.create("Late night");
    assert.throws(()=>store.setDefault("bot",list),/Add tracks/);
    store.addTracks(list,[tracks[0]!,tracks[1]!]);
    for(const n of [0,-1,NaN,1.5,10]) assert.equal(store.removeTrack(list,n),undefined);
    assert.equal(list.tracks.length,2);
    assert.throws(()=>store.moveTrack(list,0,1),/Invalid/);
    assert.throws(()=>store.create("late NIGHT"),/already/);
    assert.throws(()=>store.create("123"),/name/);
    assert.throws(()=>store.update(list,"Renamed","missing"),/Collection/);
    assert.equal(list.name,"Late night");
    store.toggleFavorite(tracks[0]!);assert.equal(store.favorites.length,1);
    store.toggleFavorite(tracks[0]!);assert.equal(store.favorites.length,0);
    await store.flush();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
