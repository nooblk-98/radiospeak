import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client, Collection, Events, ChannelType, PermissionFlagsBits } from "discord.js";
import { VoiceConnectionStatus, VoiceConnectionDisconnectReason } from "@discordjs/voice";
import { DiscordMusicBot } from "../src/discord-bot.ts";
import { DiscordInstances } from "../src/discord-instances.ts";
import { acquireDiscordClient } from "../src/discord-client.ts";
import { panelBotConfig } from "../src/bot-factory.ts";
import { validateDiscordConfig, instanceConfig } from "../src/config.ts";
import { PlaybackStore } from "../src/playback-store.ts";
import { PlaylistStore } from "../src/store.ts";
import { fixture, tracks } from "./helpers.ts";

const token="test_discord_token_never_export_123456789",guildId="123456789012345678",channelId="223456789012345678",secondChannel="323456789012345678";

test("Discord credentials stay encrypted and platform metadata survives restart without entering exports",async t=>{
  const f=await fixture("private-owner-password");t.mock.method(DiscordMusicBot.prototype,"start",async()=>{});
  try {
    const response=await f.api('/api/bots',{platform:'discord',name:'discord-music',nickname:'Discord Music',token,guildId,channelId});assert.equal(response.status,200);
    const bot=f.app.bots[1]!;assert.equal(bot.platform,'discord');assert.equal(bot.player.queue.length,0);
    const state=(await f.api('/api/state')).data;assert.equal(state.bots[1].discord.guildId,guildId);assert.ok(!JSON.stringify(state).includes(token));
    const exported=(await f.api('/api/transfer')).data;assert.ok(!JSON.stringify(exported).includes(token));assert.equal(exported.data.botPlatforms['discord-music'],'discord');
    const ciphertext=readFileSync(join(f.dir,'discord-instances.json'),'utf8');assert.ok(!ciphertext.includes(token));assert.ok(!ciphertext.includes(guildId));
    assert.equal(new DiscordInstances(f.app.playlists.path).get('discord-music')!.token,token);
    const store=new PlaylistStore(f.app.playlists.path);assert.equal(store.platformFor('discord-music'),'discord');
    assert.equal(panelBotConfig({...f.app,playlists:store},'discord-music').discord!.token,token);
    assert.equal((await f.api('/api/bots',{platform:'discord',name:'duplicate',nickname:'Another',token,guildId,channelId:secondChannel})).status,400);
    const another=await f.api('/api/bots',{platform:'discord',name:'other-server',nickname:'Other server',token,guildId:'423456789012345678',channelId});assert.equal(another.status,200,'same bot can have an instance in another server');
    bot.player.pause();bot.player.enqueue(tracks);bot.player.seek(42);
    const snapshot=bot.player.snapshot();const changed=await f.api('/api/bots/discord-music/connection',{token:'',guildId,channelId:secondChannel});assert.equal(changed.status,200);
    assert.equal(f.app.bots[1]!.cfg.discord!.token,token,'blank edit token keeps existing credentials');assert.deepEqual(f.app.bots[1]!.player.snapshot(),snapshot);
    assert.equal(f.app.playlists.channelFor('discord-music'),secondChannel);assert.ok(!JSON.stringify((await f.api('/api/audit')).data).includes(token));
    assert.equal((await f.api('/api/bots/discord-music',{},'DELETE')).status,200);assert.equal(new DiscordInstances(f.app.playlists.path).get('discord-music'),undefined);
    assert.equal(f.app.bots[0]!.platform,'teamspeak');assert.equal(f.app.bots[0]!.player.queue.length,3,'TeamSpeak playback is independent');
  }finally{await f.close();}
});

test("only administrators can add or edit Discord credentials; invalid IDs and platforms are rejected",async t=>{
  const f=await fixture('private-owner-password');t.mock.method(DiscordMusicBot.prototype,'start',async()=>{});
  try {
    for(const role of ['listener','dj']) {
      await f.api('/api/accounts',{username:role,role,password:'named-account-password'});
      const login=await fetch(f.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:role,password:'named-account-password'})});const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
      for(const path of ['/api/bots','/api/bots/discord-music/connection']) {
        const res=await fetch(f.base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({platform:'discord',name:'discord-music',nickname:'Discord',token,guildId,channelId})});assert.equal(res.status,403);
      }
    }
    assert.equal((await f.api('/api/bots',{platform:'unknown',name:'unknown',nickname:'Unknown'})).status,400);
    assert.throws(()=>validateDiscordConfig({token,guildId:'https://discord.com/server',channelId}),/server ID/);
    assert.throws(()=>validateDiscordConfig({token,guildId,channelId:'18446744073709551616'}),/channel ID/);
    assert.equal(instanceConfig({...f.app.config.bots[0]!,platform:'discord',discord:{token,guildId,channelId}},'new-ts').discord,undefined);
  }finally{await f.close();}
});

class FakeVoice extends EventEmitter {
  state:any={status:VoiceConnectionStatus.Ready};joinConfig:any;packets:Buffer[]=[];speaking:boolean[]=[];destroyed=false;
  constructor(config:any){super();this.joinConfig=config;}
  playOpusPacket(packet:Buffer){this.packets.push(packet);return true;}
  setSpeaking(value:boolean){this.speaking.push(value);}
  destroy(){this.destroyed=true;const before=this.state;this.state={status:VoiceConnectionStatus.Destroyed};this.emit('stateChange',before,this.state);}
  change(state:any){const before=this.state;this.state=state;this.emit('stateChange',before,state);}
}
class TestDiscordBot extends DiscordMusicBot {packet(frame:Uint8Array){this.sendAudioFrame(frame);}}
function fakeTransport() {
  let permitted=true,released=0;const voices:FakeVoice[]=[],registered:any[]=[];
  const gateway:any=new EventEmitter();gateway.user={id:'523456789012345678'};gateway.isReady=()=>true;
  const me:any={id:gateway.user.id,nickname:'Discord Music',voice:{serverMute:false},setNickname:async(name:string)=>{me.nickname=name;}};
  const listener:any={id:'623456789012345678',displayName:'Listener',user:{bot:false},voice:{deaf:false,channelId},permissions:{has:()=>false},roles:{cache:new Collection()}};
  const channel:any={id:channelId,name:'Discord lounge',type:ChannelType.GuildVoice,viewable:true,rawPosition:0,permissionsFor:()=>({has:()=>permitted}),members:new Collection([[me.id,{...me,user:{bot:true}}],[listener.id,listener]])};
  const other:any={...channel,id:secondChannel,name:'Gaming',rawPosition:1,members:new Collection()};
  const guild:any={id:guildId,name:'Test Discord Server',voiceAdapterCreator:()=>{},channels:{cache:new Collection([[channelId,channel],[secondChannel,other]])},members:{me,fetchMe:async()=>me,fetch:async(id:string)=>id===me.id?me:listener},commands:{create:async(command:any)=>{registered.push(command);}}};
  guild.channels.fetch=async(id?:string)=>id?guild.channels.cache.get(id):guild.channels.cache;gateway.guilds={fetch:async()=>guild};
  const deps:any={acquire:()=>({client:gateway,ready:Promise.resolve(),release:async()=>{released++;}}),join:(config:any)=>{const voice=new FakeVoice(config);voices.push(voice);return voice;},ready:async(voice:any)=>voice};
  return {gateway,guild,channel,other,me,listener,voices,registered,deps,deny(){permitted=false;},allow(){permitted=true;},get released(){return released;}};
}

test("Discord sends the existing Opus packets, preserves playback on voice loss and switches channels without restarting the player",async()=>{
  const f=await fixture(),transport=fakeTransport();f.app.playback=new PlaybackStore(join(f.dir,'playback.json'));
  const cfg={...instanceConfig(f.app.config.bots[0]!,'discord-test'),platform:'discord' as const,nickname:'Discord Music',discord:{token,guildId,channelId}};
  const bot=new TestDiscordBot(f.app,cfg,1,transport.deps);f.app.bots.push(bot);bot.player.pause();bot.player.enqueue(tracks);bot.player.seek(42);
  try {
    await bot.start();assert.equal(bot.connected,true);assert.equal(bot.serverName,'Test Discord Server');assert.equal(bot.channelName,'Discord lounge');assert.equal(bot.listeners().length,1);assert.equal(transport.registered[0].name,'radiospeak');
    const snapshot=bot.player.snapshot();bot.packet(Buffer.from([1,2,3]));assert.deepEqual(transport.voices[0]!.packets,[Buffer.from([1,2,3])]);bot.packet(Buffer.alloc(0));assert.equal(transport.voices[0]!.speaking.at(-1),false);
    transport.voices[0]!.change({status:VoiceConnectionStatus.Disconnected,reason:VoiceConnectionDisconnectReason.WebSocketClose,closeCode:4006});assert.equal(bot.player.connectionPaused,true);assert.equal(bot.connected,false);assert.deepEqual(bot.player.snapshot(),snapshot);
    transport.voices[0]!.change({status:VoiceConnectionStatus.Ready});assert.equal(bot.player.connectionPaused,false);assert.equal(bot.reconnectCount,1);
    transport.me.voice.serverMute=true;transport.gateway.emit(Events.VoiceStateUpdate,{channelId},{guild:transport.guild,id:transport.me.id,channelId});assert.equal(bot.player.connectionPaused,true);assert.match(bot.connectionError!,/server-muted/);
    transport.me.voice.serverMute=false;transport.gateway.emit(Events.VoiceStateUpdate,{channelId},{guild:transport.guild,id:transport.me.id,channelId});assert.equal(bot.player.connectionPaused,false);
    transport.deny();await assert.rejects(bot.moveToChannel(secondChannel,true),/permissions/);assert.equal(transport.voices.length,1,'permission rejection retains the existing voice connection');transport.allow();
    await bot.moveToChannel(secondChannel,true);assert.equal(transport.voices[0]!.destroyed,true);assert.equal(bot.channelName,'Gaming');assert.equal(f.app.playlists.channelFor(bot.name),secondChannel);assert.deepEqual(bot.player.snapshot(),snapshot);
    transport.gateway.emit(Events.Error,new Error('Failed request with '+token));assert.ok(!bot.connectionError!.includes(token));
    await bot.shutdown();assert.equal(transport.released,1);assert.equal(transport.gateway.listenerCount(Events.VoiceStateUpdate),0);assert.ok(transport.voices.every(voice=>voice.destroyed));
    const restored=new TestDiscordBot(f.app,cfg,1,transport.deps);assert.deepEqual(restored.player.snapshot(),snapshot);await restored.shutdown();
    assert.equal(existsSync(join(f.dir,'identity-discord-test.txt')),false);
  }finally{await bot.shutdown();await f.close();}
});

test("Discord gateway sessions are shared by token and released only after the last instance",async t=>{
  const f=await fixture();let logins=0,destroyed=0;
  t.mock.method(Client.prototype,'login',async()=>{logins++;return token;});t.mock.method(Client.prototype,'destroy',async()=>{destroyed++;});
  try {
    const one=acquireDiscordClient(f.app,token),two=acquireDiscordClient(f.app,token);await one.ready;assert.equal(one.client,two.client);assert.equal(logins,1);
    await one.release();assert.equal(destroyed,0);await two.release();assert.equal(destroyed,1);await two.release();assert.equal(destroyed,1);
  }finally{await f.close();}
});

test("Discord slash commands enforce voice membership and roles while preserving stable requester identities",async t=>{
  const f=await fixture(),transport=fakeTransport(),cfg={...instanceConfig(f.app.config.bots[0]!,'commands'),platform:'discord' as const,discord:{token,guildId,channelId}};
  const bot=new TestDiscordBot(f.app,cfg,1,transport.deps);f.app.bots.push(bot);bot.player.pause();
  t.mock.method(bot,'play',async(_query:string,options:any)=>bot.enqueue([tracks[1]!],options));
  try {
    await bot.start();
    const command=async(name:string)=>{
      let resolve!:(value:any)=>void;const reply=new Promise<any>(r=>{resolve=r;});
      transport.gateway.emit(Events.InteractionCreate,{guildId,commandName:'radiospeak',user:{id:transport.listener.id},isChatInputCommand:()=>true,options:{getSubcommand:()=>name,getString:()=>tracks[1]!.url,getInteger:()=>25},deferReply:async()=>{},editReply:async(value:any)=>{resolve(value);}});
      const response=await reply;assert.deepEqual(response.allowedMentions,{parse:[]});return response.content as string;
    };
    assert.match(await command('volume'),/DJ/);assert.equal(bot.player.volume,50);
    transport.listener.voice.channelId=null;assert.match(await command('play'),/Join/);assert.equal(bot.player.queue.length,0);
    transport.listener.voice.channelId=channelId;assert.match(await command('play'),/Playing/);assert.equal(bot.player.track!.requesterId,'discord:'+transport.listener.id);
    assert.match(await command('queue'),/Night drive/);assert.match(await command('skip'),/Vote passed/);
    transport.listener.permissions.has=(permission:bigint)=>permission===PermissionFlagsBits.ManageGuild;
    assert.match(await command('volume'),/25/);assert.equal(bot.player.volume,25);
    transport.listener.voice.channelId=secondChannel;assert.match(await command('join'),/Joined/);assert.equal(bot.channelId,secondChannel);
    transport.listener.permissions.has=()=>false;transport.listener.roles.cache.set('dj-role',{id:'dj-role'});
    f.app.playlists.setChatAccess({enabled:false,users:{},groups:{'discord:dj-role':'dj'}});assert.equal(bot.roleFor(transport.listener),'dj');
    transport.listener.permissions.has=(permission:bigint)=>permission===PermissionFlagsBits.ManageGuild;assert.equal(bot.roleFor(transport.listener),'admin');
  }finally{await bot.shutdown();await f.close();}
});

test("Discord listener auto-pause ignores bots and deafened members and resumes without losing the track",async t=>{
  const f=await fixture(),transport=fakeTransport(),cfg={...instanceConfig(f.app.config.bots[0]!,'listeners'),platform:'discord' as const,discord:{token,guildId,channelId}};
  const bot=new TestDiscordBot(f.app,cfg,1,transport.deps);f.app.bots.push(bot);bot.player.pause();bot.player.enqueue(tracks);bot.player.seek(21);
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
  try {
    await bot.start();assert.equal(bot.listeners().length,1);transport.listener.voice.deaf=true;
    transport.gateway.emit(Events.VoiceStateUpdate,{channelId},{guild:transport.guild,id:transport.listener.id,channelId});
    now+=16000;t.mock.timers.tick(16000);assert.equal(bot.player.autoPaused,true);assert.equal(bot.player.elapsed,21);assert.equal(bot.player.queue.length,3);
    transport.listener.voice.deaf=false;transport.gateway.emit(Events.VoiceStateUpdate,{channelId},{guild:transport.guild,id:transport.listener.id,channelId});
    assert.equal(bot.player.autoPaused,false);assert.equal(bot.player.userPaused,true,'manual pause is independent');
    transport.voices[0]!.change({status:VoiceConnectionStatus.Destroyed});assert.equal(bot.connected,false);assert.equal(bot.player.connectionPaused,true);
  }finally{await bot.shutdown();t.mock.timers.reset();t.mock.restoreAll();await f.close();}
});

test("concurrent Discord creation cannot claim the same bot/server twice and Discord-only configuration needs no TeamSpeak server",async t=>{
  const f=await fixture('owner-password');t.mock.method(DiscordMusicBot.prototype,'start',async()=>{});
  try {
    const responses=await Promise.all(['first','second'].map(name=>f.api('/api/bots',{name,nickname:name,platform:'discord',token,guildId,channelId})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);assert.equal(f.app.bots.length,2);
    const config=JSON.stringify([{name:'discord-only',platform:'discord',discord:{token,guildId,channelId}}]);
    const result=execFileSync(process.execPath,['--input-type=module','-e',"import {loadConfig} from './src/config.ts';const c=loadConfig();console.log(c.bots.map(b=>b.platform).join(','));"],{env:{...process.env,FMBOT_CONFIG:join(f.dir,'nonexistent-config.json'),FMBOT_SERVER:'',FMBOT_BOTS:config},encoding:'utf8',windowsHide:true});
    assert.equal(result.trim(),'discord');
  }finally{await f.close();}
});
