import { Events, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder, type Client, type Guild, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { joinVoiceChannel, entersState, VoiceConnectionStatus, VoiceConnectionDisconnectReason, type VoiceConnection } from "@discordjs/voice";
import { MusicBot, type App, type LogLevel } from "./bot.ts";
import { acquireDiscordClient, discordError } from "./discord-client.ts";
import { validateNickname, type BotConfig } from "./config.ts";
import { fetchIcyTitle } from "./icy.ts";
import type { Role } from "./policies.ts";

const commands=new SlashCommandBuilder().setName("radiospeak").setDescription("Control the radiospeak music bot")
  .addSubcommand(s=>s.setName("play").setDescription("Request a track or public playlist").addStringOption(o=>o.setName("query").setDescription("Song name or public media URL").setMaxLength(1000).setRequired(true)))
  .addSubcommand(s=>s.setName("queue").setDescription("Show the current track and upcoming requests"))
  .addSubcommand(s=>s.setName("skip").setDescription("Skip, or vote to skip, the current track"))
  .addSubcommand(s=>s.setName("pause").setDescription("Pause playback (DJ)"))
  .addSubcommand(s=>s.setName("resume").setDescription("Resume playback (DJ)"))
  .addSubcommand(s=>s.setName("stop").setDescription("Stop playback and clear the queue (DJ)"))
  .addSubcommand(s=>s.setName("volume").setDescription("Set bot volume (DJ)").addIntegerOption(o=>o.setName("level").setDescription("0 to 100").setMinValue(0).setMaxValue(100).setRequired(true)))
  .addSubcommand(s=>s.setName("join").setDescription("Move the bot to your voice channel (DJ)"))
  .addSubcommand(s=>s.setName("nowplaying").setDescription("Show the current track"));

export interface DiscordDependencies {
  acquire: typeof acquireDiscordClient;
  join: typeof joinVoiceChannel;
  ready: typeof entersState;
}
const dependencies: DiscordDependencies={acquire:acquireDiscordClient,join:joinVoiceChannel,ready:entersState};

export class DiscordMusicBot extends MusicBot {
  #deps: DiscordDependencies; #lease?: ReturnType<typeof acquireDiscordClient>; #gateway?: Client; #guild?: Guild;
  #voice?: VoiceConnection; #online=false; #closing=false; #started=false; #error: string|null=null;
  #abort=new AbortController(); #timers: NodeJS.Timeout[]=[]; #retry?:NodeJS.Timeout; #retryMs=15000;
  #cleanup:(()=>void)[]=[]; #emptySince?:number; #joinTask?:Promise<void>; #radioUrl?:string;
  #applicationId: string|null=null;
  constructor(app: App,cfg: BotConfig,index: number,deps=dependencies) {super(app,cfg,index);this.#deps=deps;}
  override get connected() {return this.#online;}
  override get connectionError() {return this.#error;}
  override get serverName() {return this.#guild?.name ?? "Discord server "+(this.cfg.discord?.guildId ?? "");}
  override get channelId() {return this.#voice?.joinConfig.channelId ?? undefined;}
  override get channelName() {return this.#guild?.channels.cache.get(this.channelId ?? "")?.name;}
  override get homeChannel() {return this.app.playlists.channelFor(this.name) ?? this.cfg.discord?.channelId ?? "";}
  override get channels() {
    if(!this.#guild)return [];
    return [...this.#guild.channels.cache.values()].flatMap(c=>c.type===ChannelType.GuildVoice && c.viewable?[{id:c.id,name:c.name,position:c.rawPosition}]:[]).sort((a,b)=>a.position-b.position).map(({id,name})=>({id,name}));
  }
  override get discord() {return {guildId:this.cfg.discord?.guildId ?? "",channelId:this.homeChannel,applicationId:this.#applicationId};}
  override listeners(): {nickname:string}[] {
    const channel=this.#guild?.channels.cache.get(this.channelId ?? "");
    return channel?.type===ChannelType.GuildVoice?[...channel.members.values()].filter(member=>!member.user.bot && !member.voice.deaf).map(member=>({nickname:member.displayName})):[];
  }
  override channelPathById(id: string) {return this.channels.some(c=>c.id===id)?id:undefined;}
  override async moveToChannel(id: string,remember=false) {
    if(!this.#gateway?.isReady() || !this.#guild)throw new Error("Connect the Discord bot before switching channels");
    await this.#join(id);
    if(remember)this.app.playlists.setChannel(this.name,id);
  }
  override async setNickname(value: string) {
    const nickname=validateNickname(value);
    if(this.#guild?.members.me && this.#gateway?.isReady())await this.#guild.members.me.setNickname(nickname);
    this.app.playlists.setNickname(this.name,nickname);
  }
  override log(level: LogLevel,message: string) {super.log(level,discordError(message,this.cfg.discord?.token ?? ""));}
  protected override sendAudioFrame(frame: Uint8Array) {
    if(!this.#voice || !this.#online)return;
    try {if(frame.length)this.#voice.playOpusPacket(Buffer.from(frame));else this.#voice.setSpeaking(false);}
    catch(error){this.#setError(error);this.player.setConnectionPaused(true);const voice=this.#voice;this.#voice=undefined;this.#online=false;if(voice?.state.status!==VoiceConnectionStatus.Destroyed)voice?.destroy();this.#scheduleRetry();}
  }
  override async start() {
    if(this.#started || this.#closing)return;this.#started=true;
    this.#timers.push(setInterval(()=>this.checkpoint(),10000).unref(),setInterval(()=>this.syncLibrary(),15000).unref(),setInterval(()=>this.#syncConnected(),5000).unref(),setInterval(()=>void this.#pollRadio(),20000).unref());
    await this.#connect();
  }
  async #connect() {
    if(this.#closing)return;
    const cfg=this.cfg.discord;
    if(!cfg?.token || !cfg.guildId || !this.homeChannel){this.#setError("Discord connection settings are missing. Edit this instance to add its token, server and voice channel IDs.");return;}
    this.#error=null;this.revision++;
    try {
      this.#lease=this.#deps.acquire(this.app,cfg.token);this.#gateway=this.#lease.client;
      const watch=(event:string,handler:(...args:any[])=>void)=>{this.#gateway!.on(event,handler);this.#cleanup.push(()=>this.#gateway?.off(event,handler));};
      watch(Events.Error,(error:unknown)=>this.#setError(error));
      watch(Events.ShardDisconnect,(event)=>{this.#setError("Discord gateway disconnected (code "+event.code+"). Check this instance's bot credentials and reconnect.");this.#syncConnected();});
      watch(Events.ShardResume,()=>this.#syncConnected());
      watch(Events.ShardReady,()=>this.#syncConnected());
      watch(Events.GuildUnavailable,(guild)=>{if(guild.id===cfg.guildId){this.#setError("Discord server is temporarily unavailable");this.#syncConnected();}});
      watch(Events.GuildAvailable,(guild)=>{if(guild.id===cfg.guildId){this.#guild=guild;this.#syncConnected();if(!this.#online)this.#scheduleRetry(1000);}});
      watch(Events.VoiceStateUpdate,(oldState,newState)=>{
        if(newState.guild.id!==cfg.guildId)return;
        if(newState.id===this.#gateway?.user?.id && newState.channelId && newState.channelId!==this.#voice?.joinConfig.channelId && this.#voice?.state.status===VoiceConnectionStatus.Ready)this.app.playlists.setChannel(this.name,newState.channelId);
        if(oldState.channelId===this.channelId || newState.channelId===this.channelId || newState.id===this.#gateway?.user?.id){this.revision++;this.#syncConnected();this.#checkListeners();}
      });
      watch(Events.ChannelUpdate,(_before,channel)=>{if(channel.guildId===cfg.guildId){this.revision++;this.#syncConnected();}});
      watch(Events.InteractionCreate,(interaction)=>{if(interaction.isChatInputCommand() && interaction.commandName==="radiospeak" && interaction.guildId===cfg.guildId)void this.#handleCommand(interaction).catch(error=>this.log("warn","Discord command reply failed: "+discordError(error,cfg.token)));});
      await this.#untilReady(this.#lease.ready);
      this.#abort.signal.throwIfAborted();
      this.#applicationId=this.#gateway.user?.id ?? null;this.revision++;
      this.#guild=await this.#gateway.guilds.fetch(cfg.guildId);
      await this.#guild.channels.fetch();await this.#guild.members.fetchMe();
      this.#abort.signal.throwIfAborted();
      // Upsert only our command; other applications' command names are untouched.
      void this.#guild.commands.create(commands.toJSON()).catch(error=>this.#setError("Discord slash commands could not be registered: "+discordError(error,cfg.token)));
      const nickname=this.nickname;
      if(this.#guild.members.me?.nickname!==nickname)void this.#guild.members.me?.setNickname(nickname).catch(error=>this.log("warn","Discord nickname could not be applied: "+discordError(error,cfg.token)));
      await this.#join(this.homeChannel);
      if(!this.#closing)void this.loadDefaultPlaylist();
    }catch(error){
      if(this.#closing)return;
      this.#setError(error);await this.#disposeConnection();
      if(!/token|Unknown Guild|Missing Access|settings are missing/i.test(this.#error ?? ""))this.#scheduleRetry();
    }
  }
  async #untilReady(promise: Promise<unknown>) {
    const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(30000)]);
    let abort!:()=>void;
    try {await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(new Error("Discord gateway connection timed out or was stopped"));signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}
    finally{signal.removeEventListener("abort",abort);}
  }
  async #join(id: string):Promise<void> {
    if(this.#joinTask)throw new Error("Discord is already switching voice channels. Try again shortly.");
    this.#joinTask=this.#joinVoice(id);try{await this.#joinTask;}catch(error){if(!this.#closing){this.#setError(error);this.#scheduleRetry();}throw error;}finally{this.#joinTask=undefined;}
  }
  async #joinVoice(id: string) {
    const guild=this.#guild;if(!guild || this.#closing)return;
    const channel=await guild.channels.fetch(id);
    if(!channel || channel.type!==ChannelType.GuildVoice)throw new Error("Choose a regular Discord voice channel in this server");
    const me=guild.members.me;if(!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw new Error("The Discord bot needs View Channel, Connect and Speak permissions in this voice channel");
    this.player.setConnectionPaused(true);this.#online=false;
    const old=this.#voice;this.#voice=undefined;if(old?.state.status!==VoiceConnectionStatus.Destroyed)old?.destroy();
    const voice=this.#deps.join({guildId:guild.id,channelId:id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true,selfMute:false,group:this.name});this.#voice=voice;
    voice.on("error",error=>{if(this.#voice===voice){this.#setError(error);this.#scheduleRetry();}});
    voice.on("stateChange",(_before,after)=>{
      if(this.#voice!==voice || this.#closing)return;
      this.#syncConnected();
      if(after.status===VoiceConnectionStatus.Disconnected) {
        // Give channel moves/recovery a chance before an explicit rejoin.
        this.#scheduleRetry(after.reason===VoiceConnectionDisconnectReason.WebSocketClose && after.closeCode===4014?10000:5000);
      }
      if(after.status===VoiceConnectionStatus.Destroyed)this.#scheduleRetry(5000);
    });
    await this.#deps.ready(voice,VoiceConnectionStatus.Ready,AbortSignal.any([this.#abort.signal,AbortSignal.timeout(20000)]));
    this.#abort.signal.throwIfAborted();
    this.#error=null;this.#retryMs=15000;this.#syncConnected();
  }
  #syncConnected() {
    const online=!!this.#gateway?.isReady() && this.#guild?.available!==false && this.#voice?.state.status===VoiceConnectionStatus.Ready;
    if(this.#online!==online){if(online){this.connectedAt=Date.now();if(this.lastDisconnect)this.reconnectCount++;}else if(this.#online)this.lastDisconnect={at:new Date().toISOString(),reason:"Discord voice connection interrupted"};this.#online=online;this.revision++;}
    const muted=this.#guild?.members.me?.voice.serverMute;
    const channel=this.#guild?.channels.cache.get(this.channelId ?? ""),me=this.#guild?.members.me;
    const denied=online && (!me || !channel || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]));
    if(muted)this.#setError("Discord has server-muted this bot. A server moderator needs to unmute it.");
    else if(denied)this.#setError("Discord voice permissions are missing. Grant View Channel, Connect and Speak to this bot.");
    else if(this.#error?.startsWith("Discord has server-muted") || this.#error?.startsWith("Discord voice permissions") || (online && this.#error==="Discord server is temporarily unavailable")){this.#error=null;this.revision++;}
    this.player.setConnectionPaused(!online || !!muted || !!denied);
    if(online)this.#checkListeners();
  }
  #setError(error: unknown) {const message=discordError(error,this.cfg.discord?.token ?? "");if(this.#error===message)return;this.#error=message;this.revision++;this.log("warn",message);}
  #scheduleRetry(delay=this.#retryMs) {
    if(this.#retry || this.#closing)return;
    this.#retryMs=Math.min(this.#retryMs*2,120000);
    this.#retry=setTimeout(()=>{this.#retry=undefined;if(this.#closing)return;if(this.#gateway?.isReady() && this.#voice?.state.status===VoiceConnectionStatus.Ready){this.#syncConnected();return;}
      void (async()=>{if(this.#gateway?.isReady() && this.#guild){try{await this.#join(this.homeChannel);}catch(error){this.#setError(error);this.#scheduleRetry();}}else{await this.#disposeConnection();await this.#connect();}})().catch(error=>this.#setError(error));
    },delay).unref();
  }
  #checkListeners() {
    if(!this.app.config.pauseWhenEmpty || !this.#online)return;
    if(this.listeners().length){this.#emptySince=undefined;this.player.setAutoPaused(false);return;}
    this.#emptySince ??= Date.now();
    if(Date.now()-this.#emptySince>=this.app.config.emptyGraceSeconds*1000)this.player.setAutoPaused(true);
  }
  async #pollRadio() {
    const url=this.player.radioUrl;if(!url || this.player.paused || !this.connected)return;
    const title=await fetchIcyTitle(url);if(url!==this.player.radioUrl || (url===this.#radioUrl && title===this.radioTitle))return;
    this.#radioUrl=url;this.radioTitle=title;this.revision++;
  }
  roleFor(member: GuildMember): Role {
    if(member.permissions.has(PermissionFlagsBits.ManageGuild) || this.app.config.admins.includes("discord:"+member.id))return "admin";
    const policy=this.app.playlists.chatAccess,roles=[policy.users["discord:"+member.id],...member.roles.cache.map(role=>policy.groups["discord:"+role.id])];
    return roles.includes("admin")?"admin":roles.includes("dj") || member.permissions.has(PermissionFlagsBits.ManageChannels)?"dj":"listener";
  }
  async #handleCommand(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try {
      const member=await this.#guild!.members.fetch(interaction.user.id),role=this.roleFor(member),command=interaction.options.getSubcommand();
      if(!["queue","nowplaying","join"].includes(command) && member.voice.channelId!==this.channelId)throw new Error("Join the bot's voice channel to request music or control playback");
      if(["pause","resume","stop","volume","join"].includes(command) && role==="listener")throw new Error("A DJ or server manager controls playback and channels. You can request songs or vote to skip.");
      let message="";
      switch(command) {
        case "play":message=await this.play(interaction.options.getString("query",true),{requesterId:"discord:"+member.id,requestedBy:member.displayName,privileged:role!=="listener"});break;
        case "skip":message=role==="listener"?this.voteSkip("discord:"+member.id):this.player.skip()?"Skipped.":"Nothing playing.";break;
        case "pause":this.player.pause();message="Paused.";break;
        case "resume":if(this.player.userPaused)this.player.resume();else this.player.playIfIdle();message="Resumed.";break;
        case "stop":message=this.stop();break;
        case "volume":message=this.setVolume(interaction.options.getInteger("level",true));break;
        case "join":if(!member.voice.channelId)throw new Error("Join a voice channel first");await this.moveToChannel(member.voice.channelId,true);message="Joined your voice channel.";break;
        case "queue":message=this.status()+"\n"+this.player.queue.slice(0,10).map((track,i)=>`${i+1}. ${track.title}`).join("\n");break;
        default:message=this.status();
      }
      if(!["queue","nowplaying"].includes(command)){this.app.operations?.audit("discord:"+member.id,"DISCORD","/bots/"+this.name+"/"+command);await this.app.operations?.flush();}
      await interaction.editReply({content:message.replace(/\[\/?b\]/g,"").slice(0,1900),allowedMentions:{parse:[]}});
    }catch(error){await interaction.editReply({content:discordError(error,this.cfg.discord?.token ?? ""),allowedMentions:{parse:[]}}).catch(()=>{});}
  }
  async #disposeConnection() {
    this.#online=false;this.player.setConnectionPaused(true);
    const voice=this.#voice;this.#voice=undefined;if(voice?.state.status!==VoiceConnectionStatus.Destroyed)voice?.destroy();
    for(const cleanup of this.#cleanup)cleanup();this.#cleanup=[];
    const lease=this.#lease;this.#lease=undefined;this.#gateway=undefined;this.#guild=undefined;await lease?.release();
  }
  override async shutdown() {
    if(this.#closing)return;this.#closing=true;this.#abort.abort();clearTimeout(this.#retry);this.#timers.forEach(clearInterval);this.#timers=[];
    await super.shutdown();await this.#disposeConnection();
  }
}
