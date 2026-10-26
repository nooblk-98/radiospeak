import test from "node:test";
import assert from "node:assert/strict";
import { StateConnection } from "../src/web/api.js";

class Source extends EventTarget {
  static current:Source;
  onerror:Function|undefined;
  closed=false;
  constructor(_url:string){super();Source.current=this;}
  emit(type:string,data:unknown){this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));}
  close(){this.closed=true;}
}
test("SSE progress merges health without replacing library state or redrawing the main view",async()=>{
  const keys=["EventSource","document","fetch"];
  const saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const doc=Object.assign(new EventTarget(),{hidden:false});
  const connection=new StateConnection();
  let renders=0,progress=0;
  try {
    Object.defineProperty(globalThis,"document",{configurable:true,value:doc});
    Object.defineProperty(globalThis,"EventSource",{configurable:true,value:Source});
    let resolveFetch:Function;
    Object.defineProperty(globalThis,"fetch",{configurable:true,value:()=>new Promise(accept=>{resolveFetch=accept;})});
    connection.addEventListener("state",()=>renders++);
    connection.addEventListener("playback_progress",()=>progress++);
    connection.start();
    const base={bots:[{name:"one",track:null,queue:[],elapsed:0}],playlists:[{id:"list",trackCount:500}],favorites:[]};
    Source.current.emit("state",base);
    assert.equal(renders,1);
    const stale=connection.refresh();
    Source.current.emit("playback_progress",{bots:[{name:"one",elapsed:42,health:{underruns:2}}],system:{uptime:80}});
    resolveFetch!(new Response(JSON.stringify(base)));
    await stale;
    assert.equal(connection.state.bots[0].elapsed,42,"a late REST response must not overwrite newer pushed progress");
    assert.equal(connection.state.playlists[0].trackCount,500);
    assert.equal(renders,1);assert.equal(progress,2);
    connection.stop();assert.equal(Source.current.closed,true);
  } finally {
    connection.stop();
    for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}
  }
});
