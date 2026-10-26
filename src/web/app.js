import { request, StateConnection } from './api.js';
import { VolumeControl } from './volume.js';
import { escape as e, icon, iconButton as ib, button, art, heading, empty, channelSelect, botCard, commands, playlistCard, trackTable, resultCard, time, duration, source } from './components.js';

const $ = selector => document.querySelector(selector);
const connection = new StateConnection();
let state, botName = localStorage.getItem('radiospeak.bot') || '', activeView = '', libraryFilter = 'all', playlistId = null;
let panelNeedsReload = false;
let query = '', searchSource = 'youtube', searchResults = [], searchStatus = 'idle', searchError = '', searchController, searchTimer;
let dragging = null, sliderActive = false, toastTimer, modalSubmit, renderedView = '', renderedDock = '', renderedChrome = '';
let receivedAt = 0, lastRenderBot = '';
const lastVolumes = new Map();
const requestedVolumes = new Map();
const volumeControl = new VolumeControl({
  send: (name, volume) => request('/api/bots/' + encodeURIComponent(name) + '/volume', { volume }),
  onValue: (name, value) => { requestedVolumes.set(name,value); if (value > 0) lastVolumes.set(name, value); paintVolume(name, value); },
  onSettled: () => { void connection.refresh(true).then(() => render()); },
  onError: (name, error) => {
    requestedVolumes.delete(name);
    toast('Could not change volume: ' + error.message, true);
    if (bot()?.name === name) paintVolume(name, bot().volume);
    void connection.refresh(true).then(() => render());
  },
});
function paintVolume(name, value) {
  if (bot()?.name !== name) return;
  const slider = $('#volume');
  if (slider) { slider.value = value; slider.style.setProperty('--fill', value + '%'); slider.setAttribute('aria-valuetext', value + '%'); slider.title = 'Bot volume: ' + value + '%'; }
  if ($('#volume-number')) $('#volume-number').textContent = value;
  const mute = $('#player-dock [data-action="mute"]');
  if (mute) { mute.innerHTML = icon(value ? 'volume' : 'mute'); mute.setAttribute('aria-pressed', String(value === 0)); mute.setAttribute('aria-label', value ? 'Mute bot' : 'Unmute bot'); mute.title = value ? 'Mute bot' : 'Unmute bot'; }
}
let viewTracks = new Map();
const playlistCache = new Map(), playlistRequests = new Map(), pages = new Map(), viewVersions = new Map();
const PAGE_SIZE = 50;
const dismissedImports = new Set();
const playlistErrors = new Map();
const views = { dashboard:'Now playing', queue:'Up next', library:'Collections & playlists', search:'Search & import', settings:'Bot & TeamSpeak' };
const bot = () => state?.bots.find(b => b.name === botName) || state?.bots[0];
const trackCount = p => p?.trackCount ?? p?.total ?? p?.tracks?.length ?? 0;
const playlist = () => playlistCache.get(playlistId) || state?.playlists.find(p => p.id === playlistId);
const listPath = id => '/api/playlists/' + encodeURIComponent(id);
const currentTrack = () => bot()?.track || (bot()?.radio ? { url:bot().radio.url, title:bot().radioTitle || bot().radio.name, artist:'Live radio' } : null);
const paused = b => b.userPaused || b.autoPaused || b.connectionPaused;
function toast(message, error = false, undoToken, undoBot) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  if (undoToken) {
    const control = document.createElement('button');
    control.type = 'button'; control.textContent = 'Undo'; control.dataset.action = 'undo';
    control.dataset.token = undoToken; control.dataset.bot = undoBot || bot().name;
    $('#toast').append(control);
  }
  $('#toast').className = 'show' + (error ? ' error' : '');
  toastTimer = setTimeout(() => { $('#toast').className = ''; }, undoToken ? 10000 : error ? 6500 : 3500);
}
async function mutate(path, body = {}, method = 'POST') {
  if (panelNeedsReload) throw new Error('Reload the panel to use the updated controls.');
  try {
    const result = await request(path, body, method);
    await connection.refresh(true);
    render();
    if (result.message) toast(result.message, false, result.undoToken, path.startsWith('/api/bots/') ? decodeURIComponent(path.split('/')[3]) : undefined);
    return result;
  } catch (error) {
    await connection.refresh(true);
    render();
    throw error;
  }
}
function action(name, body = {}) {
  if (!bot()) throw new Error('No music bot is available');
  return mutate('/api/bots/' + encodeURIComponent(bot().name) + '/' + name, body);
}
function tracksFor(scope) {
  if (scope === 'queue') return viewTracks.get(scope) || bot()?.queue || [];
  if (scope === 'search') return searchResults;
  if (scope === 'favorites') return state?.favorites || [];
  return viewTracks.get(scope) || state?.playlists.find(p => p.id === scope)?.tracks || [];
}
function orderData(scope) {
  return scope === 'queue' ? { expected: tracksFor(scope).map(t=>t.url) } : { expectedVersion: viewVersions.get(scope) };
}
async function ensurePlaylist(id) {
  const meta = state.playlists.find(p=>p.id===id);
  if (!meta) return;
  const page = Math.min(pages.get(id)||0,Math.max(0,Math.ceil(trackCount(meta)/PAGE_SIZE)-1));
  pages.set(id,page);
  const current = playlistCache.get(id);
  if (current?.version === meta.version && current.offset === page * PAGE_SIZE) return;
  const key = id + ':' + page + ':' + meta.version;
  if (playlistRequests.has(key)) return playlistRequests.get(key);
  const promise = request(listPath(id) + '?offset=' + (page*PAGE_SIZE) + '&limit=' + PAGE_SIZE,undefined,'GET',AbortSignal.timeout(10000)).then(detail => {
    if (state.playlists.find(p=>p.id===id)?.version !== detail.version || (pages.get(id)||0)!==page) return;
    playlistCache.set(id,detail); renderedView=''; render();
  }).catch(error=>{ playlistErrors.set(id,error.message); renderedView='';render(); }).finally(()=>playlistRequests.delete(key));
  playlistRequests.set(key,promise);
  return promise;
}
function pageControls(scope, total) {
  if (total <= PAGE_SIZE) return '';
  const max = Math.max(0,Math.ceil(total/PAGE_SIZE)-1), page = Math.min(pages.get(scope)||0,max);
  pages.set(scope,page);
  return '<div class="pagination" aria-label="Track pages"><button class="button secondary" data-action="page" data-scope="' + e(scope) + '" data-page="' + (page-1) + '" ' + (!page?'disabled':'') + '>Previous</button><span>' + (page*PAGE_SIZE+1) + '–' + Math.min(total,(page+1)*PAGE_SIZE) + ' of ' + total + '</span><button class="button secondary" data-action="page" data-scope="' + e(scope) + '" data-page="' + (page+1) + '" ' + (page===max?'disabled':'') + '>Next</button></div>';
}
function showModal(title, body, submit, label = 'Save', danger = false) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-error').textContent = '';
  $('#modal-submit').textContent = label;
  $('#modal-submit').className = 'button ' + (danger ? 'danger-button' : 'primary');
  $('#modal-submit').disabled = false;
  modalSubmit = submit;
  $('#modal').showModal();
  requestAnimationFrame(() => $('#modal-body input, #modal-body select')?.focus());
}
function confirmAction(title, text, submit, label = 'Delete') {
  showModal(title, '<p>' + e(text) + '</p>', submit, label, true);
}
function collectionOptions(value = null) {
  return '<option value="">Standalone playlist</option>' + state.collections.map(c => '<option value="' + e(c.id) + '" ' + (value === c.id ? 'selected' : '') + '>' + e(c.name) + '</option>').join('');
}
function playlistEditor(list) {
  showModal(list ? 'Edit playlist' : 'Create a playlist',
    '<label class="field-label" for="list-name">Playlist name</label><input id="list-name" name="name" class="field" required maxlength="80" placeholder="e.g. Late night sessions" value="' + e(list?.name) + '"><label class="field-label" for="list-collection">Collection</label><select name="collectionId" id="list-collection">' + collectionOptions(list?.collectionId ?? (state.collections.some(c => c.id === libraryFilter) ? libraryFilter : null)) + '</select>',
    async data => {
      const result = await mutate(list ? listPath(list.id) : '/api/playlists', { name:data.get('name'), collectionId:data.get('collectionId') || null }, list ? 'PATCH' : 'POST');
      if (!list) { playlistId = result.playlist.id; location.hash = 'library'; render(true); }
    }, list ? 'Save changes' : 'Create playlist');
}
function collectionEditor(collection) {
  showModal(collection ? 'Rename collection' : 'Create a collection',
    '<p>Group your playlists by mood, genre, or occasion.</p><label class="field-label" for="collection-name">Collection name</label><input class="field" id="collection-name" name="name" required maxlength="80" placeholder="e.g. Gaming BGM" value="' + e(collection?.name) + '">',
    data => mutate('/api/collections' + (collection ? '/' + encodeURIComponent(collection.id) : ''), { name:data.get('name') }, collection ? 'PATCH' : 'POST'),
    collection ? 'Rename' : 'Create collection');
}
function saveTrack(track) {
  if (!track) throw new Error('No track selected');
  showModal('Save to a playlist',
    '<p>' + e(track.title) + '</p>' + (state.playlists.length ? '<label class="field-label" for="save-playlist">Choose playlist</label><select name="playlist" id="save-playlist"><option value="">Create a new playlist…</option>' + state.playlists.map(p => '<option value="' + e(p.id) + '">' + e(p.name) + '</option>').join('') + '</select>' : '') + '<label class="field-label" for="new-list-name">New playlist name (if creating)</label><input class="field" id="new-list-name" name="name" maxlength="80" placeholder="e.g. Favorites for Friday">',
    async data => {
      let id = data.get('playlist');
      if (!id) {
        if (!String(data.get('name') || '').trim()) throw new Error('Name your new playlist or choose an existing one.');
        id = (await mutate('/api/playlists', { name:data.get('name') })).playlist.id;
      }
      await mutate(listPath(id) + '/add', { tracks:[track] });
    }, 'Save track');
}
function reorderDialog(scope, index) {
  const tracks = tracksFor(scope), track = tracks[index], expected = orderData(scope);
  if (!track) return;
  showModal('Move track', '<p>' + e(track.title) + '</p><label class="field-label" for="track-position">New position (1–' + tracks.length + ')</label><input class="field" id="track-position" name="position" type="number" min="1" max="' + tracks.length + '" value="' + (index + 1) + '" required>',
    data => moveTrack(scope, index + 1, Number(data.get('position')), expected), 'Move track');
}
function moveTrack(scope, from, to, expected = orderData(scope)) {
  if (scope === 'queue') return action('move', { from, to, ...expected });
  return mutate(listPath(scope) + '/move', { from, to, ...expected });
}

function hero(b) {
  const t = currentTrack(), isPaused = paused(b), idle = !t;
  const label = b.autoPaused ? 'PAUSED · NO LISTENERS' : isPaused ? 'PLAYBACK PAUSED' : t ? 'ON THE AIR' : 'READY WHEN YOU ARE';
  return '<section class="hero" aria-label="Now playing">' + art(t, 'hero-art') +
    '<div class="hero-copy"><div class="eyebrow"><span class="status-dot ' + (t && !isPaused ? 'on' : '') + '"></span>' + label + '</div><h2>' + e(t?.title || 'Your channel.\nYour soundtrack.') + '</h2><div class="artist">' + e(t?.artist || (idle ? 'Good music sounds better together.' : source(t))) + '</div><div class="hero-meta">' +
    (t ? '<span>' + (b.track ? duration(b.track.duration) : 'LIVE STREAM') + '</span><span>·</span><span>' + e(b.track?.auto ? 'From your idle playlist' : b.track ? 'Requested by ' + (b.track.requestedBy || 'web') : 'Radio fallback') + '</span>' : '<span>YouTube</span><span>·</span><span>SoundCloud</span><span>·</span><span>Live radio</span>') +
    '</div><div class="hero-actions">' + (idle ? '<a href="#search" class="button primary">' + icon('plus') + 'Find your first track</a>' : button(isPaused ? 'Resume' : 'Pause', isPaused ? 'play' : 'pause', 'toggle-play')) +
    (t ? ib('next', 'Skip track', 'skip', !b.track ? 'disabled' : '') + ib('library', 'Save to playlist', 'save-current') : '') + '</div></div><div class="hero-indicator ' + (idle || isPaused ? 'paused' : '') + '" aria-hidden="true"><i></i><i></i><i></i><i></i></div></section>';
}
function queueSection(b, full = false) {
  const offset = full ? Math.min(pages.get('queue')||0,Math.max(0,Math.ceil(b.queue.length/PAGE_SIZE)-1))*PAGE_SIZE : 0;
  const tracks = full ? b.queue.slice(offset,offset+PAGE_SIZE) : b.queue.slice(0,5);
  let wait = b.track ? (b.track.duration ? Math.max(0,b.track.duration-b.elapsed) : null) : 0;
  const estimates = b.queue.map(t=>{ const estimate=wait; wait=wait===null||!t.duration?null:wait+t.duration; return estimate; });
  return '<section><div class="section-heading"><h2>Up next <span class="count-badge">' + b.queue.length + '</span></h2>' +
    (full ? '<div class="heading-actions">' + button('Save queue', 'library', 'save-queue', b.queue.length || b.track ? '' : 'disabled', 'secondary') + button('Clear queue', 'trash', 'clear-queue', b.queue.length ? '' : 'disabled', 'secondary') + '</div>' : '<a href="#queue" class="text-button">View queue ' + icon('arrow') + '</a>') +
    '</div><div class="queue-tabs"><span class="queue-tab active"><span class="status-dot on"></span>Queued by users · ' + b.queue.length + '</span><span class="queue-tab">' + icon('repeat') + 'Idle autoplay ' + (b.track?.auto || (!b.track && b.radio) ? '· Active' : '· Standby') + '</span></div>' +
    trackTable(tracks, 'queue', { queue:true, offset, estimates }) + (full ? pageControls('queue',b.queue.length) : '') + '<div class="queue-footer">' + icon('repeat') + '<span>' + e(b.radio ? 'Radio plays when the queue is empty.' : b.defaultPlaylist.size ? (b.defaultPlaylist.name || 'Default playlist') + ' takes over when the queue is empty.' : 'Keep the music going with a default idle playlist.') + '</span><a href="#library">Manage playlists ' + icon('arrow') + '</a></div>' +
    (full && b.track?.auto ? '<div class="notice">Auto-playing from <strong>' + e(b.defaultPlaylist.name || 'Default playlist') + '</strong>. User requests play immediately and take priority.</div>' : '') +
    (full ? '<p class="small subtle">Drag a row to reorder, or select its number to choose a position. “Play next” and “Move to top” place a track directly after the current song.</p>' : '') + '</section>';
}
function playlistsSection(b) {
  return '<section><div class="section-heading"><h2>Made for your moments</h2><a href="#library" class="text-button">Your library ' + icon('arrow') + '</a></div><div class="library-cards">' + state.playlists.slice(0, 3).map((p,i) => playlistCard(p,i,state.defaults[b.name] === p.id)).join('') + (state.playlists.length < 3 ? '<button class="playlist-card new-playlist-card" data-action="new-playlist">' + icon('plus') + '<span>Create a playlist</span></button>' : '') + '</div></section>';
}
function dashboard(b) {
  return heading('Let the good tracks roll.', 'A little music. A better channel. You’re in control.', '<a href="#search" class="button secondary">' + icon('download') + 'Import music</a><a href="#search" class="button primary">' + icon('plus') + 'Add to queue</a>', 'YOUR CHANNEL’S SOUNDTRACK') +
    '<div class="overview-layout"><div class="content-stack">' + hero(b) + queueSection(b) + playlistsSection(b) + '</div><aside class="overview-aside">' + botCard(b) + commands(state.commandPrefix) + '<p class="aside-note">' + icon('shield') + '<span>Built for your community.<br>Music streams directly to TeamSpeak.</span></p></aside></div>';
}
function library(b) {
  const list = playlist();
  if (list) {
    if (playlistErrors.has(list.id)) return heading(list.name,'Could not load this page.') + '<div class="notice">'+e(playlistErrors.get(list.id))+'</div>'+button('Retry loading','repeat','retry-playlist','data-id="'+e(list.id)+'"');
    const meta=state.playlists.find(p=>p.id===list.id);
    pages.set(list.id,Math.min(pages.get(list.id)||0,Math.max(0,Math.ceil(trackCount(meta)/PAGE_SIZE)-1)));
    if (list.version!==meta?.version || !playlistCache.has(list.id) || list.offset!==(pages.get(list.id)||0)*PAGE_SIZE) {
      void ensurePlaylist(list.id);
      return heading(list.name,'Loading playlist tracks?') + '<div class="loading">Loading tracks?</div>';
    }
    return playlistDetail(b,list);
  }
  const favorites = libraryFilter === 'favorites', collection = state.collections.find(c => c.id === libraryFilter);
  const lists = state.playlists.filter(p => libraryFilter === 'all' || (libraryFilter === 'standalone' ? !p.collectionId : p.collectionId === libraryFilter));
  return heading('A home for every mood.', 'Collect the tracks you love. Keep your channel’s soundtrack close.', button('New collection', 'folder', 'new-collection', '', 'secondary') + button('New playlist', 'plus', 'new-playlist')) +
    '<div class="library-toolbar">' + [['all','All playlists'],['standalone','Standalone'],['favorites','Favorites'],...state.collections.map(c => [c.id,c.name])].map(([id,name]) => '<button class="filter-button ' + (libraryFilter === id ? 'active' : '') + '" data-action="filter" data-id="' + e(id) + '" aria-pressed="' + (libraryFilter === id) + '">' + e(name) + '</button>').join('') + '</div>' +
    (collection ? '<div class="collection-heading">' + icon('folder') + '<h2>' + e(collection.name) + '</h2>' + ib('edit','Rename collection','rename-collection','data-id="' + e(collection.id) + '"') + ib('trash','Delete collection','delete-collection','data-id="' + e(collection.id) + '"','danger') + '</div>' : '') +
    (favorites ? '<div class="section-heading"><h2>Favorite tracks <span class="count-badge">' + state.favorites.length + '</span></h2></div>' + trackTable(state.favorites,'favorites',{ editable:false }) : '<div class="library-cards library-grid">' + lists.map((p,i) => playlistCard(p,i,state.defaults[b.name] === p.id)).join('') + '<button class="playlist-card new-playlist-card" data-action="new-playlist">' + icon('plus') + '<span>Create a playlist</span></button></div>') +
    '<section class="card import-card"><h3>' + icon('download') + ' Bring your playlist with you</h3><p>Import every track from a public YouTube playlist into your library.</p><form id="quick-import" class="inline-form"><input class="field" name="url" type="url" required placeholder="https://www.youtube.com/playlist?list=…" aria-label="Public playlist URL">' + '<button class="button secondary" type="submit">' + icon('download') + 'Import playlist</button></form></section>';
}
function playlistDetail(b,list) {
  const isDefault = state.defaults[b.name] === list.id;
  return '<button class="text-button" data-action="library-back" style="margin-bottom:22px">' + icon('back') + 'Back to your library</button><div class="playlist-header">' + art(list.tracks[0],'playlist-cover') + '<div><div class="intro-eyebrow">' + e(state.collections.find(c => c.id === list.collectionId)?.name || 'STANDALONE PLAYLIST') + '</div><h1>' + e(list.name) + '</h1><p class="small subtle">' + trackCount(list) + ' tracks · ' + time(state.playlists.find(p=>p.id===list.id)?.totalDuration || 0) + '</p><div class="heading-actions">' +
    button('Add to queue','plus','queue-playlist','data-id="' + e(list.id) + '" ' + (!trackCount(list) ? 'disabled' : '')) +
    button(isDefault ? 'Idle playlist · On' : 'Set as idle playlist','repeat','default-playlist','data-id="' + e(list.id) + '" ' + (!trackCount(list) && !isDefault ? 'disabled' : ''),'secondary') +
    ib('edit','Edit playlist','edit-playlist','data-id="' + e(list.id) + '"') + ib('trash','Delete playlist','delete-playlist','data-id="' + e(list.id) + '"','danger') +
    '</div></div></div>' + (isDefault ? '<div class="notice">This playlist automatically plays when user requests finish. Radio fallback takes priority if enabled.</div>' : '') +
    trackTable(list.tracks,list.id,{offset:list.offset||0}) + pageControls(list.id,list.total) + '<section class="card import-card"><h3>Add a track or import a playlist</h3><p>Paste a YouTube or SoundCloud URL, a public playlist, or search words.</p><form id="playlist-import" class="inline-form"><input class="field" name="input" required placeholder="Paste a link or search for a song…" aria-label="Track or playlist to import"><label class="check-label"><input type="checkbox" name="skipDuplicates" checked> Skip duplicates</label><button class="button primary" type="submit">' + icon('plus') + 'Add music</button></form></section>';
}
function searchView() {
  return heading('Find your next favorite.', 'Search a little. Discover a lot. Set the mood for your channel.') +
    '<section class="card search-panel"><div class="source-toggle" aria-label="Search source">' + ['youtube','soundcloud'].map(s => '<button data-action="search-source" data-id="' + s + '" class="' + (searchSource===s?'active':'') + '" aria-pressed="' + (searchSource===s) + '">' + icon(s) + (s==='youtube'?'YouTube':'SoundCloud') + '</button>').join('') + '</div><form id="search-form"><div class="search-input-wrap">' + icon('search') + '<input id="search-input" type="search" name="query" autocomplete="off" maxlength="1000" placeholder="Search for a track, artist, or paste a link…" aria-label="Search music" value="' + e(query) + '"><button class="button primary" type="submit">Search</button></div></form><p class="search-hint">Your next great find is a search away. Public YouTube and SoundCloud links work too.</p></section><div id="search-results">' + searchResultsMarkup() + '</div>' +
    '<section class="card import-card"><h3>' + icon('radio') + 'Tune into something good</h3><p>Set a live radio stream to play whenever your queue is empty. Supports HTTP, Icecast, and SHOUTcast streams.</p><form id="radio-form" class="inline-form"><input class="field" type="url" name="url" required placeholder="https://station.example.com/live" aria-label="Live radio stream URL"><button type="submit" class="button secondary">' + icon('radio') + 'Set radio</button></form><div class="radio-presets"><button class="radio-preset" data-action="radio-preset" data-id="groovesalad">' + icon('radio') + '<div>Groove Salad<span>SomaFM · Ambient & downtempo</span></div></button><button class="radio-preset" data-action="radio-preset" data-id="dronezone">' + icon('radio') + '<div>Drone Zone<span>SomaFM · Atmospheric ambient</span></div></button>' + (bot().radio ? button('Turn radio off','stop','radio-off','','secondary') : '') + '</div></section>';
}
function searchResultsMarkup() {
  if (searchStatus === 'loading') return '<div class="loading" aria-live="polite">Searching ' + (searchSource==='youtube'?'YouTube':'SoundCloud') + '…</div>';
  if (searchStatus === 'error') return '<div class="notice" role="alert">' + e(searchError) + '</div>';
  if (searchStatus === 'idle') return empty('There’s a whole world of music out there', 'Search by track, artist, or the song you can’t get out of your head.');
  if (!searchResults.length) return empty('No tracks found', 'Try another artist, title, or a public media link.');
  return '<div class="section-heading"><h2>Search results <span class="count-badge">' + searchResults.length + '</span></h2></div><div class="results-grid">' + searchResults.map(resultCard).join('') + '</div>';
}
function healthCard(b) {
  return '<section class="card card-padding health-card"><div class="card-title"><h2>Bot health</h2><span class="tag green">Live</span></div><div id="health-values"></div><div class="setting-line"><div>Prepare the next track<p>Prebuffer one upcoming song during the last 15 seconds. Uses extra CPU and memory.</p></div><button class="switch" data-action="prebuffer" role="switch" aria-label="Prepare next track" aria-checked="' + !!b.health?.prebufferEnabled + '"></button></div><div id="prebuffer-status" class="small subtle"></div></section>';
}
function renderBackground() {
  const b=bot(); if(!b) return;
  const h=b.health||{}, system=state.system||{}, container=$('#health-values');
  if(container) {
    const metrics=[
      ['Server uptime',time(Math.floor(system.uptime||0))], ['Node process memory',(system.memoryMB||0)+' MB'], ['Process ID',system.pid||'—'],
      ['Reconnects',h.reconnectCount||0], ['Audio buffer',Number(h.bufferedSeconds||0).toFixed(1)+'s'],
      ['Buffer underruns',h.underruns||0], ['Event loop delay',(system.eventLoopLagMs??'—')+' ms'],
      ['Playback recovery',h.retrying?'Retrying ('+h.retryAttempt+'/2)':h.restoredCheckpoint?'Checkpoint restored':'Ready'],
      ['Checkpoint',!h.checkpoint?'Not enabled':h.checkpoint.error?'Save failed':h.checkpoint.pending?'Saving…':h.checkpoint.lastSavedAt?'Saved '+new Date(h.checkpoint.lastSavedAt).toLocaleTimeString():'Waiting'],
      ['Media lookups',(system.media?.active||0)+' active · '+(system.media?.queued||0)+' queued'],
    ];
    container.innerHTML='<dl class="detail-list">'+metrics.map(([label,value])=>'<dt>'+e(label)+'</dt><dd>'+e(value)+'</dd>').join('')+'</dl>'+
      (b.lastDisconnect?'<p class="small subtle">Last disconnect: '+e(b.lastDisconnect.reason)+' · '+e(new Date(b.lastDisconnect.at).toLocaleString())+'</p>':'')+
      (h.lastError?'<p class="small subtle">Last audio error: '+e(h.lastError)+'</p>':'');
  }
  const toggle=$('[data-action="prebuffer"]');
  if(toggle) toggle.setAttribute('aria-checked',String(!!h.prebufferEnabled));
  if($('#prebuffer-status')) $('#prebuffer-status').textContent='Next track: '+(h.prebufferStatus||'off')+' · '+(h.activeProcesses||0)+' audio processes';
  const recovery=$('#recovery-status');
  if(recovery) {
    const message=h.retrying?'Retrying the current track from '+time(b.elapsed)+' · attempt '+h.retryAttempt+' of 2':b.connectionPaused&&b.track?'TeamSpeak is unavailable. Holding your current track and queue.':'';
    recovery.innerHTML=message?'<div class="notice">'+e(message)+'</div>':'';
  }
  const target=$('#import-progress');
  const jobs=(state.imports||[]).filter(job=>!dismissedImports.has(job.id)).slice(-3);
  const signature=JSON.stringify(jobs);
  if(target && target.dataset.signature!==signature) {
    target.dataset.signature=signature;
    target.innerHTML=jobs.map(job=>{
      const active=['queued','resolving'].includes(job.status);
      const label=active?job.status==='queued'?'Waiting for a media slot…':'Reading '+job.processed+(job.total?' / '+job.total:'')+' tracks…':job.status==='completed'?job.added+' added · '+job.duplicates+' duplicates skipped · '+job.failed+' unavailable':job.status;
      return '<section class="card import-job"><div><strong>'+e(job.playlistName)+'</strong><span class="small subtle">'+e(label)+'</span></div>'+
        (active?'<progress aria-label="Playlist import progress" '+(job.total?'max="'+job.total+'" value="'+job.processed+'"':'')+'></progress>':'')+
        (job.errors?.length?'<details><summary>'+job.errors.length+' import issue(s)</summary><ul>'+job.errors.map(error=>'<li>'+e(error)+'</li>').join('')+'</ul></details>':'')+
        '<button class="icon-button" data-action="'+(active?'cancel-import':'dismiss-import')+'" data-id="'+e(job.id)+'" aria-label="'+(active?'Cancel import':'Dismiss import result')+'">'+icon('close')+'</button></section>';
    }).join('');
  }
}
function settings(b) {
  return heading('Keep your channel in tune.', 'Manage your bot, choose its channel, and dial in the sound.') +
    '<section class="card import-card"><h3>Bot name</h3><p>This fixed name is shown in TeamSpeak. It stays the same when songs change.</p><form id="nickname-form" class="inline-form"><label class="field-label" for="bot-nickname" style="align-self:center;margin:0">TeamSpeak name</label><input class="field" id="bot-nickname" name="nickname" required maxlength="30" value="' + e(b.nickname || 'radiospeak') + '" placeholder="radiospeak"><button class="button primary" type="submit">' + icon('check') + 'Save name</button></form></section>' +
    healthCard(b) + '<div class="settings-grid">' + botCard(b) + '<section class="card card-padding"><div class="card-title"><h2>Playback & output</h2>' + icon('headphones') + '</div><div class="setting-line"><div>Shuffle queue<p>Randomize queued and newly added tracks</p></div><button class="switch" role="switch" aria-label="Shuffle queue" aria-checked="' + b.shuffle + '" data-action="shuffle"></button></div><div class="setting-line"><div>Repeat mode<p>Applies to tracks requested by users</p></div><select data-control="repeat" aria-label="Repeat mode">' + ['off','all','one'].map(m => '<option value="' + m + '" ' + (b.loop===m?'selected':'') + '>' + ({off:'Off',all:'Repeat all',one:'Repeat one'}[m]) + '</option>').join('') + '</select></div><div class="setting-line"><div>Default idle playlist<p>Used when the queue is empty and radio is off</p></div><select data-control="default" aria-label="Default idle playlist"><option value="">None</option>' + state.playlists.map(p => '<option value="' + e(p.id) + '" ' + (state.defaults[b.name]===p.id?'selected':'') + (!trackCount(p)?' disabled':'') + '>' + e(p.name) + '</option>').join('') + '</select></div><dl class="detail-list"><dt>Output</dt><dd>TeamSpeak · Opus Music</dd><dt>Bot gain</dt><dd>' + b.volume + '%</dd><dt>Listener auto-pause</dt><dd>' + (b.autoPaused?'Paused · empty channel':'Ready') + '</dd><dt>Radio fallback</dt><dd>' + e(b.radio?.name || 'Off') + '</dd></dl>' + (b.radio ? button('Turn radio off','stop','radio-off','','secondary') : '') + '</section>' + commands(state.commandPrefix) + '<section class="card card-padding"><h3>Your listeners</h3><p class="small subtle">People in the current channel who can hear the bot.</p>' + (b.listeners.length ? b.listeners.map(n => '<div class="listeners-row"><span>' + e(n) + '</span><span class="tag green">Listening</span></div>').join('') : '<p class="small subtle">No listeners in this channel yet.</p>') + '</section></div>';
}

function dock(b) {
  const t = currentTrack(), isPaused = paused(b), liked = state.favorites.some(f => f.url === t?.url), canStart = t || b.queue.length || b.defaultPlaylist.size;
  return '<div class="dock-track">' + art(t,'dock-art') + '<div class="dock-info"><div class="dock-title" title="' + e(t?.title || 'Nothing playing yet') + '"><span>' + e(t?.title || 'Nothing playing yet') + '</span></div><div class="dock-artist">' + e(t?.artist || (t ? source(t) : 'Your next track is waiting')) + '</div></div>' +
    ib('heart', liked ? 'Remove from favorites' : 'Favorite current track', 'favorite-current', 'aria-pressed="' + liked + '" ' + (!t?'disabled':''),'dock-heart ' + (liked?'active':'')) + '</div><div class="dock-center"><div class="transport">' +
    ib('shuffle','Shuffle queue','shuffle','aria-pressed="' + b.shuffle + '"','shuffle-button ' + (b.shuffle?'active':'')) +
    ib('previous','Previous track','previous',b.canGoBack?'':'disabled') +
    '<button class="dock-play" data-action="toggle-play" aria-label="' + (t && !isPaused?'Pause':'Play') + '" ' + (!canStart?'disabled':'') + '>' + icon(t && !isPaused?'pause':'play') + '</button>' +
    ib('stop','Stop playback and clear queue','stop',!t&&!b.queue.length?'disabled':'','stop-button') +
    ib('next','Next track','skip',!b.track?'disabled':'') +
    '<button class="icon-button repeat-button ' + (b.loop!=='off'?'active':'') + '" data-action="repeat" aria-label="Repeat: ' + b.loop + '" title="Repeat: ' + b.loop + '" aria-pressed="' + (b.loop!=='off') + '">' + icon('repeat') + (b.loop==='one'?'<span class="repeat-one">1</span>':'') + '</button></div>' +
    '<div class="timeline"><span id="elapsed">' + time(b.elapsed) + '</span><input id="seek" type="range" min="0" max="' + (b.track?.duration||1) + '" value="' + b.elapsed + '" aria-label="Playback position" ' + (!b.track?.duration?'disabled':'') + '><span>' + (t ? duration(b.track?.duration) : '0:00') + '</span></div></div>' +
    '<div class="dock-right"><div class="volume-controls">' + ib(b.volume?'volume':'mute',b.volume?'Mute bot':'Unmute bot','mute','aria-pressed="' + (b.volume===0) + '"') + '<input type="range" id="volume" min="0" max="100" value="' + b.volume + '" aria-label="Bot volume gain" aria-valuetext="' + b.volume + '%" title="Bot volume: ' + b.volume + '%" style="--fill:' + b.volume + '%"><span class="volume-number" id="volume-number">' + b.volume + '</span></div><div class="output-info"><div class="output-label">' + icon('headphones') + 'TeamSpeak</div><div class="small">' + e(b.radio ? 'Radio fallback · ' + (!b.track ? 'Active' : 'Ready') : b.defaultPlaylist.size ? 'Idle playlist · ' + (b.track?.auto ? 'Active' : 'Ready') : b.channel || 'Not connected') + '</div></div></div>';
}

function renderChrome(b) {
  const signature = JSON.stringify([b.name,b.nickname,b.connected,b.channel,b.track?.url,b.userPaused,b.autoPaused,b.queue.length,state.collections,state.playlists.map(p=>p.collectionId),state.favorites.length,b.listeners,b.channels,b.normalization,b.defaultPlaylist,b.radio]);
  if (signature === renderedChrome) return;
  renderedChrome = signature;
  const status = !b.connected?'Offline':paused(b)?'Paused':currentTrack()?'Playing':'Connected · Idle';
  $('#connection').innerHTML = '<span class="status-dot ' + (b.connected?'on':'') + '"></span>' + status;
  $('#queue-badge').textContent = b.queue.length;
  $('#favorite-count').textContent = state.favorites.length;
  $('#sidebar-bot').textContent = b.nickname || b.name;
  $('#sidebar-channel').textContent = b.channel || 'Not connected';
  $('#sidebar-dot').className = 'status-dot ' + (b.connected?'on':'');
  $('#sidebar-collections').innerHTML = state.collections.length ? state.collections.map(c => '<button class="collection-link" data-action="collection" data-id="' + e(c.id) + '">' + icon('folder') + '<span class="name">' + e(c.name) + '</span><span class="small subtle" style="margin-left:auto">' + state.playlists.filter(p=>p.collectionId===c.id).length + '</span></button>').join('') : '<p class="subtle small">A home for every mood.</p>';
  const selector = $('#bot-select'), options = state.bots.map(b=>'<option value="' + e(b.name) + '">' + e(b.name) + '</option>').join('');
  if (selector.innerHTML !== options) selector.innerHTML = options;
  selector.value = b.name;
  $('#statusbar').innerHTML = '<span><span class="status-dot ' + (b.connected?'on':'') + '"></span>' + (b.connected?'Connected to TeamSpeak':'Bot offline') + '</span><span>' + icon('headphones') + channelSelect(b,'Move bot to channel') + '</span><span>' + icon('users') + b.listeners.length + ' listeners</span><button data-action="normalization" aria-pressed="' + b.normalization + '">' + icon('check') + 'Normalization ' + (b.normalization?'on':'off') + '</button><span class="status-end">Made for listening, together.</span>';
}
function render(force = false) {
  const actual = bot();
  const b = actual ? { ...actual, volume: volumeControl.get(actual.name) ?? requestedVolumes.get(actual.name) ?? actual.volume } : actual;
  if (!b) return;
  botName = b.name;
  renderChrome(b);
  if (!state.playlists.some(p=>p.id===playlistId)) playlistId = null;
  if (!['all','standalone','favorites'].includes(libraryFilter) && !state.collections.some(c=>c.id===libraryFilter)) libraryFilter = 'all';
  const bWithoutProgress = {...b}; delete bWithoutProgress.elapsed;
  delete bWithoutProgress.health;
  const signature = JSON.stringify([activeView,playlistId,libraryFilter,[...pages],bWithoutProgress,state.playlists,state.collections,state.defaults,state.favorites,searchSource]);
  const active = document.activeElement;
  const editing = $('#view').contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
  if ((force || signature !== renderedView) && !dragging && (!editing || force)) {
    const focusId = active?.id, selection = active?.tagName === 'INPUT' && active.type==='search' ? [active.selectionStart,active.selectionEnd] : null;
    const focusData = $('#view').contains(active) ? {...active.dataset} : null;
    renderedView = signature;
    viewTracks = new Map([['queue', [...b.queue]]]);
    viewVersions.clear();
    for (const [id,detail] of playlistCache) {
      const sparse=Array(detail.total);
      detail.tracks.forEach((t,i)=>{sparse[detail.offset+i]=t;});
      viewTracks.set(id,sparse);viewVersions.set(id,detail.version);
    }
    $('#view').innerHTML = (b.talkBlocked ? '<div class="notice" role="alert">The bot cannot be heard in this channel. Required talk power: ' + b.talkBlocked.needed + '; bot talk power: ' + b.talkBlocked.have + '. Ask a TeamSpeak admin to assign this bot a permanent server or channel group with enough talk power. A temporary talk grant can be lost on reconnect. You can also choose another channel.</div>' : '') +
      ({dashboard,queue:b=>heading('Good things are up next.', 'Your channel’s requests, in the order you want to hear them.', '<a href="#search" class="button primary">' + icon('plus') + 'Add tracks</a>') + hero(b) + '<div style="margin-top:28px">' + queueSection(b,true) + '</div>',library,search:searchView,settings}[activeView] || dashboard)(b);
    if (focusId && document.getElementById(focusId)) {
      document.getElementById(focusId).focus({preventScroll:true});
      if (selection) document.getElementById(focusId).setSelectionRange(...selection);
    } else if (focusData?.action) {
      [...$('#view').querySelectorAll('[data-action]')].find(el =>
        ['action','id','scope','index'].every(key=>el.dataset[key]===focusData[key]))?.focus({preventScroll:true});
    }
  }
  const dockSignature = JSON.stringify([b.name,b.track,b.radio,b.radioTitle,b.userPaused,b.autoPaused,b.loop,b.shuffle,b.canGoBack,b.volume,state.favorites.map(t=>t.url),b.defaultPlaylist]);
  if (dockSignature !== renderedDock && !sliderActive && !$('#player-dock').contains(document.activeElement)) {
    renderedDock = dockSignature;
    $('#player-dock').innerHTML = dock(b);
    const title = $('.dock-title'), text = $('.dock-title>span');
    if (text && text.scrollWidth > title.clientWidth) {
      title.style.setProperty('--marquee-distance', (title.clientWidth - text.scrollWidth - 10) + 'px');
      title.classList.add('is-long');
    }
  } else if (dockSignature !== renderedDock && !sliderActive) {
    // Keep the focused transport button usable while updating its labels and state.
    const focusedAction = document.activeElement?.dataset.action;
    if (focusedAction && document.activeElement.closest('#player-dock')) {
      renderedDock = dockSignature;
      $('#player-dock').innerHTML = dock(b);
      [...$('#player-dock').querySelectorAll('[data-action]')].find(el=>el.dataset.action===focusedAction)?.focus({preventScroll:true});
    }
  }
  updateProgress();
  renderBackground();
}
function updateProgress() {
  const b = bot(), seek = $('#seek');
  if (!b || !seek || sliderActive || document.activeElement === seek) return;
  const extra = !paused(b) && b.track ? Math.min(1.5,(Date.now()-receivedAt)/1000) : 0;
  const elapsed = Math.min(b.track?.duration || Infinity,b.elapsed+extra);
  seek.value = elapsed;
  seek.style.setProperty('--fill', b.track?.duration ? (elapsed/b.track.duration*100)+'%' : '0%');
  seek.setAttribute('aria-valuetext', time(Math.floor(elapsed)) + ' of ' + (b.track?.duration?duration(b.track.duration):'live stream'));
  $('#elapsed').textContent = time(Math.floor(elapsed));
  let wait=b.track?(b.track.duration?Math.max(0,b.track.duration-elapsed):null):0;
  const estimates=b.queue.map(t=>{const estimate=wait;wait=wait===null||!t.duration?null:wait+t.duration;return estimate;});
  document.querySelectorAll('[data-eta-index]').forEach(el=>{
    const estimate=estimates[Number(el.dataset.etaIndex)];
    el.textContent=b.loop==='one'&&!b.track?.auto?' · after repeat is off':estimate===null?' · time unavailable':estimate===undefined?'':' · ~'+time(Math.ceil(estimate))+(paused(b)?' after resume':' until play');
  });
}
function navigate() {
  activeView = location.hash.slice(1) in views ? location.hash.slice(1) : 'dashboard';
  $('#breadcrumb').textContent = views[activeView];
  document.title = views[activeView] + ' · radiospeak';
  document.querySelectorAll('nav a').forEach(a=>{
    const active = a.dataset.view===activeView;
    a.classList.toggle('active',active);
    if(active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  });
  $('#sidebar').classList.remove('open');
  $('[data-action="menu"]').setAttribute('aria-expanded','false');
  render(true);
}

async function search() {
  clearTimeout(searchTimer);
  searchController?.abort();
  if (!query.trim()) { searchStatus='idle';searchResults=[]; $('#search-results') && ($('#search-results').innerHTML=searchResultsMarkup()); return; }
  const controller = new AbortController(); searchController = controller;
  const timeout = setTimeout(()=>controller.abort(new Error('Search timed out. Please try again.')),95000);
  searchStatus='loading'; if($('#search-results')) $('#search-results').innerHTML=searchResultsMarkup();
  try {
    const results = await request('/api/search?q=' + encodeURIComponent(query.trim()) + '&source=' + searchSource,undefined,'GET',controller.signal);
    if (searchController!==controller) return;
    searchResults = results;searchStatus='done';
  } catch(error) {
    if (searchController!==controller || error.name==='AbortError') return;
    searchError=error.message;searchStatus='error';
  } finally {
    clearTimeout(timeout);
    if(searchController===controller && $('#search-results')) $('#search-results').innerHTML=searchResultsMarkup();
  }
}

document.addEventListener('click', async event => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const {action:kind,id,scope} = el.dataset, index=Number(el.dataset.index), b=bot();
  if (kind === 'reload-panel') { location.reload(); return; }
  if (panelNeedsReload && kind !== 'close-modal') { toast('Reload the panel to use the updated controls.',true); return; }
  try {
    switch(kind) {
      case 'page': pages.set(scope,Math.max(0,Number(el.dataset.page)));renderedView='';render();return;
      case 'retry-playlist': playlistErrors.delete(id);renderedView='';render();return;
      case 'undo': await mutate('/api/bots/'+encodeURIComponent(el.dataset.bot)+'/undo',{token:el.dataset.token});return;
      case 'prebuffer': await action('prebuffer',{enabled:!b.health?.prebufferEnabled});render(true);return;
      case 'cancel-import': await mutate('/api/imports/'+encodeURIComponent(id)+'/cancel',{});return;
      case 'dismiss-import': dismissedImports.add(id);renderBackground();return;
      case 'menu': {
        const open=$('#sidebar').classList.toggle('open');el.setAttribute('aria-expanded',String(open));return;
      }
      case 'close-modal': $('#modal').close();return;
      case 'new-collection': return collectionEditor();
      case 'new-playlist': return playlistEditor();
      case 'rename-collection': return collectionEditor(state.collections.find(c=>c.id===id));
      case 'delete-collection': return confirmAction('Delete collection?', 'Its playlists will be kept as standalone playlists.', async()=>{await mutate('/api/collections/'+encodeURIComponent(id),{},'DELETE');libraryFilter='all';render(true);});
      case 'collection': case 'filter': libraryFilter=id;playlistId=null;location.hash='library';render(true);return;
      case 'favorites': libraryFilter='favorites';playlistId=null;location.hash='library';render(true);return;
      case 'open-playlist': playlistId=id;location.hash='library';render(true);return;
      case 'library-back': playlistId=null;render(true);return;
      case 'edit-playlist': return playlistEditor(state.playlists.find(p=>p.id===id));
      case 'delete-playlist': return confirmAction('Delete playlist?', 'This deletes the playlist and its saved tracks. If it is an idle playlist, that fallback will be disabled.',async()=>{await mutate(listPath(id),{},'DELETE');playlistId=null;render(true);});
      case 'queue-playlist': await mutate(listPath(id)+'/play',{bot:b.name});return;
      case 'default-playlist': await action('default',{playlistId:state.defaults[b.name]===id?null:id});return;
      case 'toggle-play':
        if(b.connectionPaused) {toast('Playback is held until the bot reconnects to TeamSpeak.');return;}
        if(b.autoPaused) {toast('Playback will resume when a listener joins the channel.');return;}
        await action(currentTrack()?(b.userPaused?'resume':'pause'):'start');return;
      case 'skip': await action('skip');return;
      case 'previous': await action('previous');return;
      case 'stop': return confirmAction('Stop playback?', 'This stops audio and clears user requests. Your saved playlists remain available.',()=>action('stop'),'Stop playback');
      case 'shuffle': await action('shuffle',{enabled:!b.shuffle});return;
      case 'repeat': await action('loop',{mode:({off:'all',all:'one',one:'off'})[b.loop]});return;
      case 'normalization': await action('normalization',{enabled:!b.normalization});return;
      case 'mute': {
        const current = volumeControl.get(b.name) ?? requestedVolumes.get(b.name) ?? b.volume;
        if (current > 0) lastVolumes.set(b.name, current);
        volumeControl.set(b.name, current ? 0 : lastVolumes.get(b.name) || 50, true);
        return;
      }
      case 'clear-queue': {
        const expected=tracksFor('queue').map(t=>t.url);
        return confirmAction('Clear the queue?', 'Remove all upcoming user requests? The current track will keep playing.',()=>action('clear',{expected}),'Clear queue');
      }
      case 'queue-next': case 'queue-top': await moveTrack('queue',index+1,1);return;
      case 'reorder': return reorderDialog(scope,index);
      case 'remove-track': {
        const expected=orderData(scope);
        if(scope==='queue') await action('remove',{position:index+1,...expected});
        else await mutate(listPath(scope)+'/tracks/'+(index+1),expected,'DELETE');
        return;
      }
      case 'play-track': case 'enqueue-track': {
        const track=tracksFor(scope)[index];if(!track) throw new Error('This track is no longer available');
        await action(kind==='play-track'?'play-now':'enqueue',{tracks:[track]});return;
      }
      case 'favorite-current': await mutate('/api/favorites',{track:currentTrack()});return;
      case 'favorite-track': await mutate('/api/favorites',{track:tracksFor(scope)[index]});return;
      case 'save-track': return saveTrack(tracksFor(scope)[index]);
      case 'save-current': return saveTrack(currentTrack());
      case 'save-queue':
        return showModal('Save queue to playlist','<label class="field-label" for="queue-playlist-name">Playlist name</label><input class="field" id="queue-playlist-name" name="name" required maxlength="80" placeholder="e.g. Tonight’s session">',async data=>{
          const result=await mutate('/api/playlists',{name:data.get('name')});
          await mutate(listPath(result.playlist.id)+'/save',{bot:b.name});
        },'Save queue');
      case 'search-source': searchSource=id;render(true);if(query.trim()) void search();return;
      case 'radio-preset': await action('radio',{url:'https://ice5.somafm.com/'+id+'-128-mp3'});return;
      case 'radio-off': await action('radio',{url:''});return;
    }
  } catch(error) { toast(error.message,true); }
});
$('#modal-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if (panelNeedsReload) { $('#modal-error').textContent='A new panel version is available. Close this dialog and reload the panel.'; return; }
  const submit=$('#modal-submit'), handler=modalSubmit;
  submit.disabled=true;$('#modal-error').textContent='';
  try { await handler(new FormData(event.target));$('#modal').close(); }
  catch(error) { $('#modal-error').textContent=error.message; }
  finally { submit.disabled=false; }
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='modal-form') return;
  event.preventDefault();
  if (panelNeedsReload) { toast('Reload the panel to use the updated controls.',true); return; }
  const form=event.target, data=new FormData(form), submit=form.querySelector('[type=submit]');
  if(form.id==='search-form') {query=String(data.get('query'));void search();return;}
  if(!submit) return;
  submit.disabled=true;
  try {
    if(form.id==='nickname-form') {
      await action('nickname',{nickname:data.get('nickname')});
    } else if(form.id==='playlist-import') {
      await mutate('/api/imports',{playlistId,input:data.get('input'),skipDuplicates:data.get('skipDuplicates')==='on'});form.reset();
    } else if(form.id==='quick-import') {
      const url=String(data.get('url'));
      let importedId=null;
      showModal('Import a public playlist','<p>Import all playable tracks from this link into a new playlist.</p><label class="field-label" for="import-name">Playlist name</label><input class="field" id="import-name" name="name" required maxlength="80" placeholder="e.g. Weekend rotation"><label class="check-label"><input type="checkbox" name="skipDuplicates" checked> Skip duplicate tracks</label>',async d=>{
        if(!importedId) importedId=(await mutate('/api/playlists',{name:d.get('name'),collectionId:state.collections.some(c=>c.id===libraryFilter)?libraryFilter:null})).playlist.id;
        // Keep the created playlist selected even if the provider rejects the import.
        playlistId=importedId;render(true);
        await mutate('/api/imports',{playlistId,input:url,skipDuplicates:d.get('skipDuplicates')==='on'});
      },'Import playlist');
    } else if(form.id==='radio-form') {await action('radio',{url:data.get('url')});form.reset();}
    renderedView='';render();
  } catch(error) {toast(error.message,true);}
  finally {submit.disabled=false;}
});
document.addEventListener('input',event=>{
  if (panelNeedsReload) return;
  const el=event.target;
  if(el.id==='search-input') {
    query=el.value;
    clearTimeout(searchTimer);
    searchController?.abort();searchController=null;
    if(query.trim().length>=2) searchTimer=setTimeout(search,650);
    else {searchStatus='idle';searchResults=[];if($('#search-results')) $('#search-results').innerHTML=searchResultsMarkup();}
  }
  if(el.type==='range') {
    el.style.setProperty('--fill',(Number(el.value)/Number(el.max)*100)+'%');
    if(el.id==='volume') volumeControl.set(bot().name, Number(el.value));
    if(el.id==='seek') $('#elapsed').textContent=time(Number(el.value));
  }
});
document.addEventListener('change',async event=>{
  if (panelNeedsReload) return;
  const el=event.target;
  try {
    if(el.id==='bot-select') {botName=el.value;localStorage.setItem('radiospeak.bot',botName);receivedAt=Date.now();render(true);return;}
    if(el.id==='volume') volumeControl.set(bot().name, Number(el.value), true);
    if(el.id==='seek') {await action('seek',{seconds:Number(el.value),url:bot().track?.url});}
    if(el.dataset.control==='channel') await action('channel',{channelId:el.value});
    if(el.dataset.control==='repeat') await action('loop',{mode:el.value});
    if(el.dataset.control==='default') await action('default',{playlistId:el.value||null});
  } catch(error) {toast(error.message,true);}
  finally {sliderActive=false;render();}
});
document.addEventListener('pointerdown',event=>{if(event.target.type==='range') sliderActive=true;});
document.addEventListener('pointerup',()=>{sliderActive=false;});
document.addEventListener('pointercancel',()=>{sliderActive=false;render();});
document.addEventListener('focusout',()=>setTimeout(()=>render(),0));
document.addEventListener('error',event=>{if(event.target.tagName==='IMG') event.target.classList.add('failed');},true);
document.addEventListener('dragstart',event=>{
  const row=event.target.closest('tr[draggable=true]');if(!row) return;
  dragging={scope:row.dataset.scope,index:Number(row.dataset.index),expected:orderData(row.dataset.scope)};
  row.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',row.dataset.index);
});
document.addEventListener('dragover',event=>{
  const row=event.target.closest('tr[draggable=true]');
  if(!row || !dragging || row.dataset.scope!==dragging.scope) return;
  event.preventDefault();event.dataTransfer.dropEffect='move';
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));row.classList.add('drag-over');
});
document.addEventListener('drop',async event=>{
  const row=event.target.closest('tr[draggable=true]'), drag=dragging;
  if(!row||!drag||row.dataset.scope!==drag.scope) return;
  event.preventDefault();dragging=null;
  try {await moveTrack(drag.scope,drag.index+1,Number(row.dataset.index)+1,drag.expected);}catch(error){toast(error.message,true);}
  render(true);
});
document.addEventListener('dragend',()=>{
  dragging=null;document.querySelectorAll('.dragging,.drag-over').forEach(el=>el.classList.remove('dragging','drag-over'));render();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape') {$('#sidebar').classList.remove('open');$('[data-action="menu"]').setAttribute('aria-expanded','false');}
});
connection.addEventListener('updateavailable',()=>{
  panelNeedsReload = true;
  $('#update-banner').hidden = false;
  if ($('#modal').open) $('#modal-error').textContent='A new panel version is available. Close this dialog and reload the panel.';
});
connection.addEventListener('state',event=>{
  for(const b of event.detail.bots) if(volumeControl.get(b.name)===undefined&&requestedVolumes.get(b.name)===b.volume) requestedVolumes.delete(b.name);
  state={...event.detail,playlists:event.detail.playlists.map(p=>({...p,tracks:p.tracks||[]}))};receivedAt=Date.now();
  for(const [id,detail] of playlistCache) if(state.playlists.find(p=>p.id===id)?.version!==detail.version) playlistCache.delete(id);
  renderBackground();
  if(lastRenderBot!==bot()?.name) {lastRenderBot=bot()?.name;renderedView='';}
  render();
});
connection.addEventListener('playback_progress',event=>{
  for(const b of event.detail.bots) if(volumeControl.get(b.name)===undefined&&requestedVolumes.get(b.name)===b.volume) requestedVolumes.delete(b.name);
  if(!state) return;
  state={...state,bots:event.detail.bots,system:event.detail.system};
  receivedAt=Date.now(); updateProgress(); renderBackground();
});
connection.addEventListener('online',()=>{$('#offline-banner').hidden=true;});
connection.addEventListener('offline',()=>{
  $('#offline-banner').hidden=false;
  $('#connection').innerHTML='<span class="status-dot warning"></span>Panel disconnected';
  renderedChrome='';
});
window.addEventListener('hashchange',navigate);
window.addEventListener('resize',()=>{renderedDock='';render();});
document.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon);});
navigate();
connection.start();
setInterval(updateProgress,500);
