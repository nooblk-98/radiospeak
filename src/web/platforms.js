import { escape as e, icon } from './components.js';

export const platformName=bot=>bot?.platform==='discord'?'Discord':'TeamSpeak';
export const platformIcon=bot=>'<img class="platform-logo" src="/'+(bot?.platform==='discord'?'discord':'teamspeak')+'.svg" width="22" height="22" alt="" aria-hidden="true">';
export const platformBadge=bot=>'<span class="platform-badge '+(bot?.platform==='discord'?'discord':'teamspeak')+'">'+platformIcon(bot)+platformName(bot)+'</span>';

export function discordFields(bot,required=true) {
  return '<p class="small subtle">Create a bot in the <a class="text-button" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a>, invite it to your server, and copy the server and voice channel IDs using Discord Developer Mode. The bot needs View Channel, Connect and Speak. Slash commands use <code>/radiospeak</code>; Message Content intent is not needed.</p>'+
    '<label class="field-label" for="discord-token">Bot token</label><input class="field" id="discord-token" type="password" name="token" autocomplete="new-password" maxlength="200" '+(required?'required':'')+' placeholder="'+(required?'Discord bot token':'Leave blank to keep the current token')+'"><p class="small subtle">Stored encrypted on this server; excluded from library exports.</p>'+
    '<label class="field-label" for="discord-guild">Discord server ID</label><input class="field" id="discord-guild" name="guildId" inputmode="numeric" pattern="[0-9]{1,20}" maxlength="20" required value="'+e(bot?.discord?.guildId||'')+'" placeholder="e.g. 123456789012345678">'+
    '<label class="field-label" for="discord-channel">Voice channel ID</label><input class="field" id="discord-channel" name="channelId" inputmode="numeric" pattern="[0-9]{1,20}" maxlength="20" required value="'+e(bot?.discord?.channelId||'')+'" placeholder="Regular voice channel ID">';
}
export function discordConnectionCard(bot) {
  if(bot.platform!=='discord')return '';
  const invite=bot.discord?.applicationId?'https://discord.com/oauth2/authorize?client_id='+encodeURIComponent(bot.discord.applicationId)+'&scope=bot%20applications.commands&permissions=70255616&guild_id='+encodeURIComponent(bot.discord.guildId):'';
  return '<section class="card card-padding operations-card" data-min-role="admin"><div class="card-title"><h2>'+platformIcon(bot)+' Discord connection</h2></div><p class="small subtle">'+e(bot.serverName||'Discord server')+' · Server ID '+e(bot.discord?.guildId||'Not configured')+'</p>'+(bot.connectionError?'<p class="notice" role="alert">'+e(bot.connectionError)+'</p>':'')+'<div class="heading-actions">'+(bot.removable?'<button class="button secondary" data-action="edit-connection" data-id="'+e(bot.name)+'">'+icon('settings')+'Edit connection / reconnect</button>':'<span class="small subtle">Connection credentials come from the server configuration.</span>')+(invite?'<a class="button secondary" href="'+e(invite)+'" target="_blank" rel="noopener noreferrer">Invite bot to server</a>':'')+'</div></section>';
}
