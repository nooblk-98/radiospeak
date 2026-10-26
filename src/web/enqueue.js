/** Match alternate YouTube URLs while retaining meaningful stream parameters. */
export function queueTrackKey(link) {
  try {
    const url=new URL(link),host=url.hostname.replace(/^www\./,'');
    const id=host==='youtu.be'?url.pathname.split('/')[1]
      :['youtube.com','m.youtube.com','music.youtube.com'].includes(host)
        ?url.searchParams.get('v')??(/^\/(shorts|embed)\//.test(url.pathname)?url.pathname.split('/')[2]:null):null;
    if(id)return 'youtube:'+id;
    url.hash='';return url.href;
  }catch{return link;}
}

/** One in-flight addition per bot/media item, independent of card re-renders. */
export class EnqueueControl {
  #pending=new Set(); #send; #change;
  constructor({send,onChange=()=>{}}) { this.#send=send;this.#change=onChange; }
  #key(bot,track) {return JSON.stringify([bot.name,queueTrackKey(track.url)]);}
  state(bot,track) {
    return this.statesFor(bot)(track);
  }
  statesFor(bot) {
    const playing=bot.track?queueTrackKey(bot.track.url):null,queued=new Set(bot.queue.map(item=>queueTrackKey(item.url)));
    return track=>{
      if(this.#pending.has(this.#key(bot,track)))return 'adding';
      const key=queueTrackKey(track.url);
      return key===playing?'playing':queued.has(key)?'queued':'idle';
    };
  }
  async add(bot,track) {
    if(this.state(bot,track)!=='idle')return false;
    const key=this.#key(bot,track);this.#pending.add(key);this.#change();
    try {await this.#send(bot.name,track);return true;}
    finally {this.#pending.delete(key);this.#change();}
  }
}
