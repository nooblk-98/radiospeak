import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { NotificationCenter } from "../src/web/notifications.js";

test("bell icon and badge clicks toggle reliably while live notifications update",()=>{
  const dom=new JSDOM('<div id="notification-center"><button id="notification-button"></button><section id="notification-panel" hidden></section></div><div id="toast"></div><button id="outside">Outside</button>',{url:'https://radiospeak.test'});
  const keys=['document','localStorage'],descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,value:(dom.window as any)[key]});
    const center=new NotificationCenter();center.account();center.add('Import completed');
    const doc=dom.window.document,button=doc.querySelector('#notification-button')!,panel=doc.querySelector('#notification-panel') as HTMLElement;
    const click=(target:Element)=>target.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,composed:true}));
    for(const selector of ['svg','path','.notification-badge']) {
      click(button.querySelector(selector)!);assert.equal(panel.hidden,false,'clicking '+selector+' opens the panel');
      click(button.querySelector(selector)!);assert.equal(panel.hidden,true,'clicking '+selector+' closes the panel');
    }
    const icon=button.querySelector('svg')!,badge=button.querySelector('.notification-badge')!;
    for(let n=0;n<5;n++)center.update({viewer:{username:'owner'},bots:[],imports:[]});
    assert.equal(button.querySelector('svg'),icon,'progress updates retain the icon under the pointer');
    assert.equal(button.querySelector('.notification-badge'),badge,'updates retain the badge under the pointer');
    click(icon);center.add('Another update');assert.equal(panel.hidden,false,'new notifications never close an open panel');
    const mark=doc.querySelector('[data-action="notifications-read"]') as HTMLElement;mark.focus();click(mark);
    assert.equal(panel.hidden,false,'mark-read keeps the panel open even when its contents update');
    assert.equal(doc.activeElement?.getAttribute('data-action'),'notifications-read','updates preserve keyboard focus');
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(panel.hidden,true);assert.equal(doc.activeElement,button);
    click(icon);click(doc.querySelector('#outside')!);assert.equal(panel.hidden,true,'outside click closes the panel');
  }finally{
    dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}
  }
});

test("new notifications pop up under the bell until opened, dismissed or timed out",()=>{
  const dom=new JSDOM('<div id="notification-center"><button id="notification-button"></button><section id="notification-panel" hidden></section></div><div id="toast"></div>',{url:'https://radiospeak.test'});
  const keys=['document','localStorage'],descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,value:(dom.window as any)[key]});
    const center=new NotificationCenter();center.account();
    const doc=dom.window.document,panel=doc.querySelector('#notification-panel') as HTMLElement;
    const toasts=()=>[...doc.querySelectorAll('.notification-toast:not(.leaving)')].map(t=>t.querySelector('p')!.textContent);
    const click=(target:Element)=>target.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,composed:true}));
    center.add('Bot name saved.');
    assert.deepEqual(toasts(),['Bot name saved.'],'a new notification pops up without opening the panel');
    assert.equal(panel.hidden,true);
    assert.ok(doc.querySelector('#notification-button')!.classList.contains('ringing'));
    center.add('Removed Blue hour',false,'token-1','Test bot');
    assert.ok(doc.querySelector('.notification-toast [data-action="undo"][data-token="token-1"]'),'undo is offered on the popup');
    center.add('Talk power blocked',true);center.add('Queue cleared.');
    assert.deepEqual(toasts(),['Queue cleared.','Talk power blocked','Removed Blue hour'],'newest first, at most three');
    assert.ok(doc.querySelector('.notification-toast.error'));
    click(doc.querySelector('.notification-toast [data-toast-close]')!);
    assert.deepEqual(toasts(),['Talk power blocked','Removed Blue hour'],'the close button dismisses one popup');
    click(doc.querySelector('.notification-toast p')!);
    assert.equal(panel.hidden,false,'clicking a popup opens the notification list');
    assert.equal(doc.querySelectorAll('.notification-toast').length,0,'opening the list clears popups');
    center.add('While open');
    assert.equal(doc.querySelectorAll('.notification-toast').length,0,'no popups while the list is open');
    center.close();
    const job={id:'j1',playlistName:'Weekend',status:'resolving',processed:1,total:2,added:0,duplicates:0,failed:0,errors:[],createdAt:new Date().toISOString()};
    center.update({viewer:{username:'owner'},bots:[],imports:[{...job,id:'old',status:'completed'},job]});
    assert.equal(doc.querySelectorAll('.notification-toast').length,0,'imports finished before the page loaded stay quiet');
    center.update({viewer:{username:'owner'},bots:[],imports:[{...job,id:'old',status:'completed'},{...job,status:'completed',added:2}]});
    assert.deepEqual(toasts(),['Import finished: Weekend · 2 added']);
  }finally{
    dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}
  }
});
