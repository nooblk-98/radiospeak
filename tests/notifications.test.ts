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
