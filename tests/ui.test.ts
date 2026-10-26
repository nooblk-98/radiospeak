import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fixture, tracks } from "./helpers.ts";
import { ImportManager } from "../src/imports.ts";

test("UI navigation, creation, import, idle selection, search, save, queue edits and favorites use the API", async () => {
  const f=await fixture();
  f.app.imports=new ImportManager(f.app.playlists,"test",300,async(_path,_input,options)=>{
    options.onProgress?.({processed:2,total:2,title:"Night drive"});
    return {tracks:tracks.slice(0,2)};
  });
  const dom=new JSDOM(readFileSync(new URL("../src/web/index.html",import.meta.url),"utf8"),{url:f.base,pretendToBeVisual:true});
  const nativeFetch=globalThis.fetch, nativeTimeout=globalThis.setTimeout, nativeInterval=globalThis.setInterval;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const keys=["window","document","localStorage","location","requestAnimationFrame","Event","CustomEvent","EventTarget","FormData"];
  const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const searchRequests:string[]=[];
  const errors:string[]=[];
  dom.window.addEventListener("error",event=>errors.push(event.message));
  try {
    for(const key of keys) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:(dom.window as any)[key].bind && key==="requestAnimationFrame" ? dom.window.requestAnimationFrame.bind(dom.window) : (dom.window as any)[key]});
    Object.defineProperty(dom.window.HTMLDialogElement.prototype,"showModal",{value:function(this:HTMLDialogElement){this.setAttribute("open","");}});
    Object.defineProperty(dom.window.HTMLDialogElement.prototype,"close",{value:function(this:HTMLDialogElement){this.removeAttribute("open");}});
    globalThis.setTimeout=((callback:any,ms:any,...args:any[])=>{
      const timer=nativeTimeout(callback,ms,...args);timer.unref();timers.add(timer);return timer;
    }) as typeof setTimeout;
    globalThis.setInterval=((callback:any,ms:any,...args:any[])=>{
      const timer=nativeInterval(callback,ms,...args);timer.unref();timers.add(timer);return timer;
    }) as typeof setInterval;
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input),f.base);
      if(url.pathname==="/api/search") {
        searchRequests.push(url.search);
        return new Response(JSON.stringify([tracks[1],tracks[3]]),{headers:{"Content-Type":"application/json"}});
      }
      // Deterministic media provider: the HTTP API still handles all library mutations.
      if(url.pathname.endsWith("/add") && init?.body) {
        const body=JSON.parse(String(init.body));
        if(body.input) {delete body.input;body.tracks=tracks.slice(0,2);init={...init,body:JSON.stringify(body)};}
      }
      return nativeFetch(url,init);
    };
    const document=dom.window.document;
    const get=(selector:string)=>{const el=document.querySelector(selector);assert.ok(el,selector+" exists");return el as HTMLElement;};
    const click=(selector:string)=>{const el=get(selector);el.focus();el.click();};
    const submit=(selector:string)=>get(selector).dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
    const fill=(selector:string,value:string)=>{const el=get(selector) as HTMLInputElement;el.value=value;el.dispatchEvent(new dom.window.Event("input",{bubbles:true}));};
    const until=async(predicate:()=>boolean,label:string)=>{
      const end=Date.now()+15000;
      while(!predicate()) {
        if(Date.now()>end) throw new Error("Timed out: "+label+"\n"+document.body.textContent?.slice(-2500));
        await new Promise(resolve=>nativeTimeout(resolve,20));
      }
    };
    await import("../src/web/app.js");
    await until(()=>document.querySelector("h1")?.textContent==="Let the good tracks roll.","initial dashboard");
    assert.equal(get("#queue-badge").textContent,"3");
    fill("#volume","25");
    await until(()=>f.app.bots[0]!.player.volume===25&&get("#volume-number").textContent==="25","volume applies during drag without change/release");
    click('#player-dock [data-action="mute"]');
    await until(()=>f.app.bots[0]!.player.volume===0&&get("#player-dock [data-action='mute']").getAttribute("aria-pressed")==="true","mute bot volume");
    click('#player-dock [data-action="mute"]');
    await until(()=>f.app.bots[0]!.player.volume===25,"unmute restores the latest slider volume");
    fill("#volume","80");fill("#volume","10");fill("#volume","40");
    get("#volume").dispatchEvent(new dom.window.Event("change",{bubbles:true}));
    await until(()=>f.app.bots[0]!.player.volume===40&&get("#volume").getAttribute("aria-valuetext")==="40%","latest rapid slider value wins");
    assert.equal(document.querySelectorAll(".player-dock").length,1);
    assert.equal(document.querySelectorAll("script:not([src])").length,0,"track title remains escaped text");
    click('[data-action="new-collection"]');
    fill("#collection-name","Gaming BGM");submit("#modal-form");
    await until(()=>f.app.playlists.collections.length===1&&!get("#modal").hasAttribute("open"),"collection creation");
    click('[data-action="collection"]');
    await until(()=>document.querySelector("h1")?.textContent==="A home for every mood.","library navigation");
    click('#view [data-action="new-playlist"]');
    fill("#list-name","Night sessions");submit("#modal-form");
    await until(()=>!!document.querySelector("#playlist-import")&&!get("#modal").hasAttribute("open"),"playlist creation");
    const list=f.app.playlists.all[0]!;
    assert.equal(list.collectionId,f.app.playlists.collections[0]!.id);
    fill('#playlist-import input',"https://www.youtube.com/playlist?list=public");
    submit("#playlist-import");
    await until(()=>f.app.playlists.all[0]!.tracks.length===2 && !!document.querySelector('[data-action="default-playlist"]') && !(document.querySelector('[data-action="default-playlist"]') as HTMLButtonElement)?.disabled,"playlist import");
    click('[data-action="default-playlist"]');
    await until(()=>f.app.playlists.defaults["Test bot"]===list.id,"default selection");
    click('[data-action="reorder"][data-index="1"]');
    fill("#track-position","1");submit("#modal-form");
    await until(()=>list.tracks[0]?.url===tracks[1]!.url&&!get("#modal").hasAttribute("open")&&!!document.querySelector("#playlist-import"),"accessible reorder");
    click('[data-action="library-back"]');
    await until(()=>!!document.querySelector("#quick-import"),"public playlist import form");
    fill('#quick-import input',"https://www.youtube.com/playlist?list=public-new");
    submit("#quick-import");
    await until(()=>get("#modal-title").textContent==="Import a public playlist","public playlist name dialog");
    fill("#import-name","Public playlist import");submit("#modal-form");
    await until(()=>f.app.playlists.all.some(p=>p.name==="Public playlist import"&&p.tracks.length===2)&&!get("#modal").hasAttribute("open"),"public playlist imported into a new playlist");
    const imported=f.app.playlists.all.find(p=>p.name==="Public playlist import")!;
    assert.equal(imported.collectionId,list.collectionId);
    assert.deepEqual(imported.tracks.map(t=>t.url),tracks.slice(0,2).map(t=>t.url));
    assert.equal(get("#modal-error").textContent,"");
    await until(()=>!!document.querySelector("#playlist-import"),"imported playlist detail loaded");
    click('[data-action="library-back"]');
    click('[data-action="open-playlist"][data-id="'+list.id+'"]');
    await until(()=>!!document.querySelector("#playlist-import"),"return to original playlist");
    dom.window.location.hash="search";
    await until(()=>!!document.querySelector("#search-input"),"search navigation");
    click('[data-action="search-source"][data-id="soundcloud"]');
    fill("#search-input","night drive");submit("#search-form");
    await until(()=>document.querySelectorAll(".result-card").length===2,"search results");
    assert.match(searchRequests[0]!,/source=soundcloud/);
    assert.match(get(".result-card").textContent!,/Test channel/);
    const before=f.app.bots[0]!.player.queue.length;
    click('.result-card [data-action="enqueue-track"]');
    await until(()=>f.app.bots[0]!.player.queue.length===before+1,"enqueue search result");
    click('.result-card [data-action="save-track"]');
    (get("#save-playlist") as HTMLSelectElement).value=list.id;
    submit("#modal-form");
    await until(()=>list.tracks.length===3&&!get("#modal").hasAttribute("open"),"save search result");
    click('[data-action="favorite-current"]');
    await until(()=>f.app.playlists.favorites.length===1 && document.querySelector('[data-action="favorite-current"]')?.getAttribute("aria-pressed")==="true","favorite toggle");
    click('[data-action="favorite-current"]');
    await until(()=>f.app.playlists.favorites.length===0,"favorite untoggle");
    dom.window.location.hash="queue";
    await until(()=>get("#breadcrumb").textContent==="Up next","queue navigation");
    const queueBefore=f.app.bots[0]!.player.queue.length;
    click('#view [data-action="remove-track"][data-index="0"]');
    await until(()=>f.app.bots[0]!.player.queue.length===queueBefore-1 && get("#queue-badge").textContent===String(queueBefore-1) && !!document.querySelector('#notification-panel [data-action="undo"]'),"queue removal with undo ready");
    assert.equal(get('#notification-panel').hidden,true,"notifications never open automatically");
    click('#notification-button');
    assert.equal(get('#notification-button').getAttribute('aria-expanded'),'true');
    assert.equal(get('#import-progress').textContent,'',"import cards stay out of the workspace");
    click('#notification-panel [data-action="undo"]');
    await until(()=>f.app.bots[0]!.player.queue.length===queueBefore && get("#toast").textContent==="Track restored to the queue.","undo queue removal");
    click('[data-action="notifications-read"]');assert.equal((get('.notification-badge') as HTMLElement).hidden,true);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(get('#notification-panel').hidden,true);
    dom.window.location.hash="settings";
    await until(()=>!!document.querySelector("#bot-nickname"),"bot settings navigation");
    fill("#bot-nickname","Community Radio");submit("#nickname-form");
    await until(()=>f.app.bots[0]!.nickname==="Community Radio" && get("#sidebar-bot").textContent==="Community Radio" && get("#toast").textContent==="Bot name saved.","save fixed bot name");
    assert.match(get(".bot-info").textContent!,/Community Radio/);
    assert.match(get("#health-values").textContent!,/Server uptime/);
    click('[data-action="prebuffer"]');
    await until(()=>f.app.bots[0]!.health.prebufferEnabled && document.querySelector('[data-action="prebuffer"]')?.getAttribute("aria-checked")==="true","enable optional prebuffer");
    await f.api("/api/playlists/"+list.id+"/add",{tracks:Array.from({length:120},(_,i)=>({url:"https://example.com/page/"+i,title:"Page track "+i,duration:60}))});
    dom.window.location.hash="library";
    await until(()=>document.querySelectorAll("#view tbody tr").length===50,"large playlist first page");
    click('[data-action="page"][data-page="1"]');
    await until(()=>!!document.querySelector('#view tr[data-index="50"]') && document.querySelectorAll("#view tbody tr").length===50,"large playlist second page");
    const totalBefore=list.tracks.length,removedTitle=list.tracks[50]!.title;
    click('#view [data-action="remove-track"][data-index="50"]');
    await until(()=>list.tracks.length===totalBefore-1 && !!document.querySelector('#view tr[data-index="50"]') && !document.querySelector('#view tr[data-index="50"]')?.textContent?.includes(removedTitle),"global deletion from page two");
    const moved=list.tracks[50]!.url;
    click('#view [data-action="reorder"][data-index="50"]');
    fill("#track-position","1");submit("#modal-form");
    await until(()=>list.tracks[0]?.url===moved&&!get("#modal").hasAttribute("open") && document.querySelector('#view tr[data-index="50"] .track-title')?.textContent===list.tracks[50]?.title,"reorder a paged track to the first position");
    fill('#playlist-filter [name="q"]','Page track 11');submit('#playlist-filter');
    await until(()=>document.querySelectorAll('#view tbody tr').length===11,"playlist search covers all pages");
    click('[data-action="select-matches"]');assert.match(get('.bulk-count').textContent!,/11 selected/);
    const importedBeforeBulk=imported.tracks.length;click('[data-action="bulk-tracks"]');fill('#modal-body [name="destination"]',imported.id);submit('#modal-form');
    await until(()=>imported.tracks.length===importedBeforeBulk+11&&!get('#modal').hasAttribute('open'),"bulk copy filtered tracks through the API");
    fill('#playlist-filter [name="q"]','');submit('#playlist-filter');await until(()=>document.querySelectorAll('#view tbody tr').length===50,"clear playlist filter");
    click('[data-action="play-playlist-now"]');
    await until(()=>f.app.bots[0]!.player.track?.url===list.tracks[0]!.url&&f.app.bots[0]!.player.queue.length===list.tracks.length-1,"playlist Play now replaces the queue");
    dom.window.location.hash="radio";
    await until(()=>get("#breadcrumb").textContent==="Radio stations"&&document.querySelectorAll(".station-card").length===2,"radio stations view");
    click('#view .page-heading [data-action="new-station"]');
    fill("#station-name","Late jazz");fill("#station-url","https://radio.example.com/jazz");submit("#modal-form");
    await until(()=>document.querySelectorAll(".station-card").length===3&&!get("#modal").hasAttribute("open"),"add a radio station");
    const jazz=f.app.playlists.radioStations.find(r=>r.name==="Late jazz")!;
    click('[data-action="play-station"][data-id="'+jazz.id+'"]');
    await until(()=>f.app.bots[0]!.player.radio?.name==="Late jazz"&&!!document.querySelector(".radio-now"),"tune in to a saved station");
    dom.window.location.hash="settings";
    await until(()=>!!document.querySelector("#performance-form"),"performance settings form");
    fill('#performance-form [name="audioProfile"]','balanced');fill('#performance-form [name="maxTracks"]','200');
    fill('#performance-form [name="failover"]',jazz.id);submit('#performance-form');
    await until(()=>f.app.bots[0]!.settings.audioProfile==='balanced'&&f.app.bots[0]!.settings.queue.maxTracks===200&&get('#toast').textContent==='Bot performance and request settings saved.',"save audio profile and queue policy");
    assert.deepEqual(f.app.bots[0]!.settings.failover,[jazz.id]);
    fill('#schedule-form [name="playlistId"]',list.id);submit('#schedule-form');
    await until(()=>f.app.playlists.schedules.length===1&&!!document.querySelector('[data-action="edit-schedule"]'),"create a playlist schedule");
    assert.equal(f.app.playlists.schedules[0]!.timezone,'Asia/Colombo');
    click('[data-action="delete-schedule"]');submit('#modal-form');
    await until(()=>f.app.playlists.schedules.length===0&&!get('#modal').hasAttribute('open'),"delete schedule while keeping playlist");
    assert.ok(f.app.playlists.find(list.id));
    dom.window.location.hash='history';
    await until(()=>!!document.querySelector('[data-action="history-enqueue"]'),"persistent playback history view");
    const historyQueue=f.app.bots[0]!.player.queue.length;click('[data-action="history-enqueue"]');
    await until(()=>f.app.bots[0]!.player.queue.length===historyQueue+1&&get('#toast').textContent?.startsWith('Queued')===true,"request a track from playback history");
    dom.window.location.hash='settings';await until(()=>!!document.querySelector('#transfer-form'),"manual export/import controls");
    await until(()=>!!document.querySelector('#deployment-policy-form'),"deployment policy loaded");
    fill('#deployment-policy-form [name="mode"]','window');submit('#deployment-policy-form');await until(()=>f.app.operations?.status.policy.mode==='window',"save deployment policy");
    const archive=(await f.api('/api/transfer')).data,beforeImport=f.app.playlists.all.length;
    Object.defineProperty(get('#transfer-form [name="archive"]'),'files',{configurable:true,value:[{size:JSON.stringify(archive).length,text:async()=>JSON.stringify(archive)}]});submit('#transfer-form');
    await until(()=>get('#modal-title').textContent==='Import settings & playlists'&&get('#modal').hasAttribute('open'),"portable import preview");assert.equal(f.app.playlists.all.length,beforeImport);
    submit('#modal-form');await until(()=>f.app.playlists.all.length===beforeImport*2&&!get('#modal').hasAttribute('open')&&get('#toast').textContent==='Settings and playlists imported.',"portable import confirms before adding playlists");
    assert.deepEqual(errors,[]);
  } finally {
    for(const timer of timers) {clearTimeout(timer);clearInterval(timer);}
    globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;globalThis.setInterval=nativeInterval;
    dom.window.close();
    for(const [key,descriptor] of descriptors) {
      if(descriptor) Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];
    }
    await f.close();
  }
});
