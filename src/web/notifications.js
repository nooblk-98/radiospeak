import { escape as e, icon } from './components.js';

/** Keeps notifications out of the workspace without opening or moving focus. */
export class NotificationCenter {
  constructor() {
    this.items=[];this.read={};this.jobs=[];this.key='';this.signature='';this.seen=new Map();
    this.button=document.querySelector('#notification-button');this.panel=document.querySelector('#notification-panel');
    this.container=document.querySelector('#notification-center');
    this.button.innerHTML=icon('bell')+'<span class="notification-badge" hidden></span>';
    this.badge=this.button.querySelector('.notification-badge');
    // New notifications also pop up under the bell for a few seconds. #toast stays the screen-reader announcement.
    this.toasts=document.createElement('div');this.toasts.className='notification-toasts';this.toasts.setAttribute('aria-label','New notifications');
    document.body.append(this.toasts);this.jobStatus=null;
    this.toasts.addEventListener('click',event=>{
      const toast=event.target.closest('.notification-toast');if(!toast)return;
      if(event.target.closest('[data-toast-close]')){this.dismiss(toast);return;}
      if(event.target.closest('[data-action]')){this.dismiss(toast);return;}
      // Anywhere else on the card opens the full list.
      this.toasts.replaceChildren();if(this.panel.hidden)this.toggle();
    });
    this.button.addEventListener('click',()=>this.toggle());
    document.addEventListener('click',event=>{
      // Keep the original event path: a mark-read action can replace its own DOM.
      const path=event.composedPath();
      if(!path.includes(this.container)&&!path.includes(this.toasts))this.close();
      if(event.target.closest('[data-action="notifications-read"]')){for(const item of this.entries())this.read[item.id]=item.signature;this.save();this.render();}
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!this.panel.hidden){this.close();this.button.focus();}});
  }
  account(username='owner') {
    const key='radiospeak.notifications.'+username;if(this.key===key)return;
    this.key=key;
    try{const saved=JSON.parse(localStorage.getItem(key)||'{}');this.items=Array.isArray(saved.items)?saved.items.slice(0,80):[];this.read=saved.read||{};}catch{this.items=[];this.read={};}
    this.render();
  }
  save(){try{const ids=new Set(this.entries().map(i=>i.id));this.read=Object.fromEntries(Object.entries(this.read).filter(([id])=>ids.has(id)));localStorage.setItem(this.key,JSON.stringify({items:this.items.slice(0,80),read:this.read}));}catch{}}
  add(message,error=false,undoToken,undoBot,key) {
    if(key&&(this.seen.get(key)===message || this.items.some(item=>item.key===key&&item.message===message)))return;
    if(key)this.seen.set(key,message);
    if(this.seen.size>500)this.seen.delete(this.seen.keys().next().value);
    const id=globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    this.items.unshift({id,signature:id,message,error,key,at:new Date().toISOString(),undoToken,undoBot,expires:Date.now()+10000});this.items.length=Math.min(80,this.items.length);
    document.querySelector('#toast').textContent=message;
    this.save();this.render();
    this.popup({message,error,undoToken,undoBot});
  }
  /** Shows a notification card under the bell; hovering or focusing it holds it open. */
  popup({message,error=false,undoToken,undoBot}) {
    if(!this.panel.hidden)return; // already visible in the open list
    const toast=document.createElement('article');
    toast.className='notification-toast'+(error?' error':'');
    toast.innerHTML='<span class="notification-toast-icon">'+icon(error?'alert':'bell')+'</span><p>'+e(message)+'</p>'+
      (undoToken?'<button type="button" class="button secondary" data-action="undo" data-token="'+e(undoToken)+'" data-bot="'+e(undoBot)+'">Undo</button>':'')+
      '<button type="button" class="icon-button" data-toast-close aria-label="Dismiss notification" title="Dismiss">'+icon('close')+'</button>';
    this.toasts.prepend(toast);
    while(this.toasts.children.length>3)this.toasts.lastElementChild.remove();
    let remaining=undoToken?10000:error?8000:5000,timer=null,started=0;
    const run=()=>{if(timer||!toast.isConnected)return;started=Date.now();timer=setTimeout(()=>this.dismiss(toast),remaining);timer.unref?.();};
    const hold=()=>{if(!timer)return;clearTimeout(timer);timer=null;remaining=Math.max(1500,remaining-(Date.now()-started));};
    toast.addEventListener('mouseenter',hold);toast.addEventListener('focusin',hold);
    toast.addEventListener('mouseleave',run);toast.addEventListener('focusout',run);
    run();
    this.button.classList.remove('ringing');void this.button.offsetWidth;this.button.classList.add('ringing');
  }
  dismiss(toast) {
    if(toast.classList.contains('leaving'))return;
    toast.classList.add('leaving');
    const timer=setTimeout(()=>toast.remove(),200);timer.unref?.();
  }
  update(state) {
    this.account(state.viewer?.username);
    this.jobs=state.imports||[];
    // Pop up imports that finish while the panel is open (not ones already finished at load).
    const statuses=new Map(this.jobs.map(job=>[job.id,job.status]));
    if(this.jobStatus)for(const job of this.jobs) {
      const before=this.jobStatus.get(job.id);
      if(['queued','resolving'].includes(before)&&!['queued','resolving'].includes(job.status))
        this.popup({message:job.status==='completed'?'Import finished: '+job.playlistName+' · '+job.added+' added':'Import '+job.status+': '+job.playlistName,error:job.status==='failed'});
    }
    this.jobStatus=statuses;
    for(const bot of state.bots||[]) {
      const h=bot.health||{};
      if(h.silenceAlert)this.add(bot.nickname+': '+h.silenceAlert.message,true,undefined,undefined,'silence:'+bot.name+':'+h.silenceAlert.id);
      const recovery=h.retrying?'Retrying '+(bot.track?.title||'audio')+' from '+bot.elapsed+' seconds':bot.connectionPaused&&bot.track?'TeamSpeak is unavailable. Your track and queue are held.':'';
      if(recovery)this.add(bot.nickname+': '+recovery,true,undefined,undefined,'recovery:'+bot.name);
      else this.seen.delete('recovery:'+bot.name);
      if(bot.talkBlocked)this.add(bot.nickname+': TeamSpeak talk permission is blocked. Required talk power: '+bot.talkBlocked.needed+'; bot talk power: '+bot.talkBlocked.have+'. Assign a permanent server or channel group with enough talk power.',true,undefined,undefined,'talk:'+bot.name+':'+bot.talkBlocked.needed+':'+bot.talkBlocked.have);
    }
    if(state.deployment)this.add('Deployment: '+state.deployment.message,state.deployment.status==='failed',undefined,undefined,'deployment:'+state.deployment.id+':'+state.deployment.status);
    this.render();
  }
  entries(){return [...this.jobs.map(job=>({id:'import:'+job.id,signature:job.status+':'+(job.hasMore?'more':'')+':'+job.added,job,at:job.createdAt})),...this.items].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime());}
  toggle(){this.panel.hidden=!this.panel.hidden;this.button.setAttribute('aria-expanded',String(!this.panel.hidden));if(!this.panel.hidden){this.toasts.replaceChildren();this.render();}}
  close(){this.panel.hidden=true;this.button.setAttribute('aria-expanded','false');}
  render() {
    const entries=this.entries(),unread=entries.filter(i=>this.read[i.id]!==i.signature).length;
    // Never detach an icon/badge between pointerdown and click during SSE updates.
    const count=String(Math.min(99,unread));
    if(this.badge.textContent!==count)this.badge.textContent=count;
    this.badge.hidden=!unread;
    this.button.setAttribute('aria-label','Notifications'+(unread?', '+unread+' unread':''));
    const signature=JSON.stringify([entries,this.read,this.items.filter(item=>item.undoToken&&item.expires>Date.now()).map(item=>item.id)]);if(signature===this.signature)return;this.signature=signature;
    const focused=this.panel.contains(document.activeElement)?{...document.activeElement.dataset}:null;
    const scrollTop=this.panel.querySelector('.notification-list')?.scrollTop||0;
    this.panel.innerHTML='<div class="notification-heading"><h2>Notifications</h2><button class="text-button" data-action="notifications-read">Mark all read</button></div><div class="notification-list">'+(entries.length?entries.map(item=>{
      const unread=this.read[item.id]!==item.signature;
      if(item.job) {
        const job=item.job,active=['queued','resolving'].includes(job.status);
        const action=(name,label)=>'<button class="button secondary" data-action="'+name+'" data-id="'+e(job.id)+'">'+label+'</button>';
        return '<article class="notification-item '+(unread?'unread':'')+'"><strong>'+e(job.playlistName)+'</strong><p>'+e(active?'Importing '+job.processed+(job.total?' / '+job.total:'')+' tracks':job.status+' · '+job.added+' added · '+job.duplicates+' duplicates · '+job.failed+' unavailable')+'</p>'+(active?'<progress aria-label="Playlist import progress" '+(job.total?'max="'+job.total+'" value="'+job.processed+'"':'')+'></progress>':'')+(job.errors?.length?'<details><summary>Import issues</summary><ul>'+job.errors.map(error=>'<li>'+e(error)+'</li>').join('')+'</ul></details>':'')+'<div class="notification-actions">'+(active?action('cancel-import','Cancel import'):['interrupted','cancelled','failed'].includes(job.status)||job.hasMore?action('resume-import',job.hasMore?'Continue next batch':'Resume import'):'')+(!active&&job.failed?action('retry-import','Retry unavailable'):'')+'</div></article>';
      }
      return '<article class="notification-item '+(unread?'unread ':'')+(item.error?'notification-error':'')+'"><p>'+e(item.message)+'</p><time>'+e(new Date(item.at).toLocaleString())+'</time>'+(item.key==='panel-update'?'<button class="button secondary" data-action="reload-panel">Reload panel</button>':'')+(item.undoToken&&item.expires>Date.now()?'<button class="button secondary" data-action="undo" data-token="'+e(item.undoToken)+'" data-bot="'+e(item.undoBot)+'">Undo</button>':'')+'</article>';
    }).join(''):'<p class="subtle">You’re all caught up.</p>')+'</div>';
    if(focused?.action)[...this.panel.querySelectorAll('[data-action]')].find(el=>['action','id','token'].every(key=>el.dataset[key]===focused[key]))?.focus({preventScroll:true});
    this.panel.querySelector('.notification-list').scrollTop=scrollTop;
  }
}
