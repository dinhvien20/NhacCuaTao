const resolveApiBase = () => {
  const config = window.__APP_CONFIG__ || {};
  const currentHost = window.location.hostname || 'localhost';
  const currentProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const configuredBase = config.apiBase || config.API_BASE || config.apiBaseUrl || config.API_BASE_URL || new URLSearchParams(window.location.search).get('apiBase') || `${currentProtocol}//${currentHost}:5000/api`;
  const base = String(configuredBase).replace(/\/+$/, '');
  return base.endsWith('/api') ? base : `${base}/api`;
};

const API_BASE = resolveApiBase();
const API_ORIGIN = API_BASE.replace(/\/api$/, '');
const getStreamUrl = (trackId) => `${API_ORIGIN}/api/stream/${encodeURIComponent(trackId)}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const formatTime = (timeValue) => {
  if (!Number.isFinite(timeValue) || timeValue < 0) return '0:00';
  const seconds = Math.floor(timeValue);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const state = {
  view: 'library',
  search: '',
  tracks: [],
  artists: [],
  playlists: [],
  favorites: [],
  selectedArtist: null,
  selectedAlbumId: null,
  selectedPlaylistId: null,
  selectedTrackId: null,
  currentQueue: [],
  queueIndex: -1,
  hiddenTrackIds: new Set(),
  audioQualityByTrackId: new Map(),
  qualityRequestTrackId: null,
  isPlaying: false,
  repeat: false,
  shuffle: false,
  volume: 0.8,
  contextTrackId: null,
};

const audio = document.getElementById('audioPlayer');
const mainContent = document.getElementById('mainContent');
const searchInput = document.getElementById('searchInput');
const trackCount = document.getElementById('trackCount');
const sidebarTrackCount = document.getElementById('sidebarTrackCount');
const playlistCount = document.getElementById('playlistCount');
const favoriteCount = document.getElementById('favoriteCount');
const viewTitle = document.getElementById('viewTitle');
const viewEyebrow = document.getElementById('viewEyebrow');
const newPlaylistBtn = document.getElementById('newPlaylistBtn');
const requestDialog = document.getElementById('requestDialog');
const requestForm = document.getElementById('requestForm');
const requestFormMessage = document.getElementById('requestFormMessage');
const playlistDialog = document.getElementById('playlistDialog');
const playlistForm = document.getElementById('playlistForm');
const contextMenu = document.getElementById('contextMenu');
const toast = document.getElementById('toast');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const albumArt = document.getElementById('albumArt');
const audioQualityBadge = document.getElementById('audioQualityBadge');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const progressSlider = document.getElementById('progressSlider');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const playPauseBtn = document.getElementById('playPauseBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const repeatBtn = document.getElementById('repeatBtn');

const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

const formatAudioQuality = (quality) => {
  const codec = (quality.codec || quality.format || 'Audio').toUpperCase();
  const details = [];
  if (quality.bit_depth) details.push(`${quality.bit_depth}-bit`);
  if (quality.sample_rate_hz) details.push(`${(Number(quality.sample_rate_hz) / 1000).toLocaleString('en-US')}kHz`);
  if (quality.bitrate_kbps) details.push(`${quality.bitrate_kbps} kbps`);
  const label = quality.lossless === true ? '[LOSSLESS]' : quality.lossless === false ? '[LOSSY]' : '[AUDIO]';
  return `${label} ${codec}${details.length ? ` • ${details.join(' / ')}` : ''}`;
};

const loadAudioQuality = async (trackId) => {
  if (state.audioQualityByTrackId.has(trackId) || state.qualityRequestTrackId === trackId) return;
  state.qualityRequestTrackId = trackId;
  try {
    const data = await apiRequest(`/quality/${encodeURIComponent(trackId)}`);
    state.audioQualityByTrackId.set(trackId, data.quality || {});
    if (state.selectedTrackId === trackId) {
      audioQualityBadge.textContent = formatAudioQuality(data.quality || {});
      audioQualityBadge.hidden = false;
    }
  } catch (error) {
    console.error('Failed to load audio quality:', error);
  } finally {
    if (state.qualityRequestTrackId === trackId) state.qualityRequestTrackId = null;
  }
};

const getTrackById = (trackId) => state.tracks.find((track) => track.id === trackId) || null;
const getArtistNames = (track) => track.artists?.length ? track.artists : [track.artist || 'Unknown Artist'];
const getQuery = () => state.search.trim().toLocaleLowerCase();
const filterBySearch = (items, getText) => {
  const query = getQuery();
  return query ? items.filter((item) => getText(item).toLocaleLowerCase().includes(query)) : items;
};
const sortedTracks = (tracks) => [...tracks].sort((left, right) => collator.compare(left.title, right.title));
const shuffleArray = (items) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};
const getFavorite = (type, id) => state.favorites.find((favorite) => favorite.type === type && favorite.id === id);
const isFavorite = (type, id) => Boolean(getFavorite(type, id));
const artistId = (name) => name.trim().toLocaleLowerCase();

const getAlbums = () => {
  const groups = new Map();
  state.tracks.forEach((track) => {
    const name = (track.album || '').trim();
    if (!name || /^unknown album$/i.test(name)) return;
    const artists = getArtistNames(track);
    const key = `${artists.map(artistId).sort().join('|')}::${name.toLocaleLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { id: key, name, artists, tracks: [], coverTrackId: track.id, coverUrl: track.cover_url });
    groups.get(key).tracks.push(track);
  });
  return [...groups.values()].sort((left, right) => collator.compare(left.name, right.name));
};

const getAlbumById = (id) => getAlbums().find((album) => album.id === id) || null;
const getSelectedArtist = () => state.artists.find((artist) => artist.name === state.selectedArtist) || null;
const getSelectedPlaylist = () => state.playlists.find((playlist) => playlist.id === state.selectedPlaylistId) || null;
const getPlaylistTracks = (playlist) => (playlist?.track_ids || []).map(getTrackById).filter(Boolean);

const currentViewTracks = () => {
  if (state.view === 'library') return sortedTracks(filterBySearch(state.tracks, (track) => `${track.title} ${track.artist}`));
  if (state.view === 'artists' && state.selectedArtist) return sortedTracks(filterBySearch(getSelectedArtist()?.songs || [], (track) => `${track.title} ${track.artist}`));
  if (state.view === 'albums' && state.selectedAlbumId) return sortedTracks(filterBySearch(getAlbumById(state.selectedAlbumId)?.tracks || [], (track) => `${track.title} ${track.artist}`));
  if (state.view === 'playlists' && state.selectedPlaylistId) return filterBySearch(getPlaylistTracks(getSelectedPlaylist()), (track) => `${track.title} ${track.artist}`);
  if (state.view === 'favorites') {
    const ids = state.favorites.filter((favorite) => favorite.type === 'song').map((favorite) => favorite.id);
    return sortedTracks(filterBySearch(ids.map(getTrackById).filter(Boolean), (track) => `${track.title} ${track.artist}`));
  }
  return [];
};

const renderSongRows = (tracks, options = {}) => {
  if (!tracks.length) return '<div class="empty-state">No tracks here yet.</div>';
  return `
    <div class="song-list">
      <div class="song-list-head"><span>#</span><span>Title</span><span>Album</span><span>Duration</span><span></span></div>
      ${tracks.map((track, index) => `
        <div class="song-row ${track.id === state.selectedTrackId ? 'selected' : ''}" ${options.draggable ? `draggable="true" data-playlist-drag-id="${escapeHtml(track.id)}"` : ''}>
          <span class="song-index">${index + 1}</span>
          <button class="song-primary" type="button" data-action="play-track" data-id="${escapeHtml(track.id)}">
            <span class="song-name">${escapeHtml(track.title)}</span>
            <span class="song-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
          </button>
          <span class="song-album">${escapeHtml(track.album || 'Unknown Album')}</span>
          <span class="song-duration">${formatTime(track.duration)}</span>
          <span class="song-row-actions">
            ${options.hideQueue ? `<button class="icon-action" type="button" data-action="hide-queue" data-id="${escapeHtml(track.id)}" title="Hide from current queue" aria-label="Hide from current queue">⊖</button>` : ''}
            ${options.removeFromPlaylist ? `<button class="icon-action" type="button" data-action="remove-playlist-track" data-id="${escapeHtml(track.id)}" title="Remove from playlist" aria-label="Remove from playlist">−</button>` : ''}
            <button class="icon-action ${isFavorite('song', track.id) ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="song" data-id="${escapeHtml(track.id)}" data-name="${escapeHtml(track.title)}" title="Toggle favorite" aria-label="Toggle favorite">♥</button>
            <button class="icon-action" type="button" data-action="track-menu" data-id="${escapeHtml(track.id)}" aria-label="More options" aria-haspopup="menu">···</button>
          </span>
        </div>
      `).join('')}
    </div>
  `;
};

const renderCollectionControls = (tracks, options = {}) => `
  <div class="collection-controls">
    <button class="primary-button" type="button" data-action="play-all" ${tracks.length ? '' : 'disabled'}>▶ <span>Play all</span></button>
    <button class="quiet-button" type="button" data-action="shuffle-all" ${tracks.length ? '' : 'disabled'}>⇄ Shuffle</button>
    <button class="quiet-button" type="button" data-action="random-track" ${tracks.length ? '' : 'disabled'}>⤨ Random</button>
    ${options.trailing || ''}
  </div>
`;

const renderLibraryView = () => {
  const tracks = currentViewTracks();
  return `
    <div class="view-toolbar"><p>${state.tracks.length} tracks · Sorted by title</p>${renderCollectionControls(tracks)}</div>
    ${renderSongRows(tracks, { hideQueue: true })}
  `;
};

const renderArtistCards = () => {
  const artists = filterBySearch(state.artists, (artist) => artist.name);
  if (!artists.length) return '<div class="empty-state">No artists found.</div>';
  return `<div class="entity-grid artist-grid">${artists.map((artist) => `
    <article class="artist-card">
      <button class="entity-main" type="button" data-action="open-artist" data-name="${escapeHtml(artist.name)}">
        <span class="artist-avatar">${escapeHtml(artist.name.slice(0, 1).toUpperCase())}</span>
        <span class="entity-title">${escapeHtml(artist.name)}</span>
        <span class="entity-caption">${artist.songs.length} ${artist.songs.length === 1 ? 'track' : 'tracks'}</span>
      </button>
      <button class="entity-favorite ${isFavorite('artist', artistId(artist.name)) ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="artist" data-id="${escapeHtml(artistId(artist.name))}" data-name="${escapeHtml(artist.name)}" aria-label="Favorite artist">♥</button>
    </article>
  `).join('')}</div>`;
};

const renderArtistView = () => {
  const artist = getSelectedArtist();
  if (!artist) return `<div class="view-toolbar"><p>${state.artists.length} artists</p></div>${renderArtistCards()}`;
  const tracks = currentViewTracks();
  const albums = getAlbums().filter((album) => album.artists.some((name) => artistId(name) === artistId(artist.name)));
  const favorite = isFavorite('artist', artistId(artist.name));
  return `
    <button class="back-link" type="button" data-action="back-to-list">← All artists</button>
    <div class="detail-hero artist-hero"><span class="artist-avatar large">${escapeHtml(artist.name.slice(0, 1).toUpperCase())}</span><div><p class="eyebrow">ARTIST</p><h2>${escapeHtml(artist.name)}</h2><p>${artist.songs.length} tracks · ${albums.length} albums</p></div>
      <button class="entity-favorite ${favorite ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="artist" data-id="${escapeHtml(artistId(artist.name))}" data-name="${escapeHtml(artist.name)}" aria-label="Favorite artist">♥</button>
    </div>
    ${renderCollectionControls(tracks)}
    <section class="detail-section"><div class="section-heading"><h3>Albums</h3><span>${albums.length}</span></div>${renderAlbumCards(albums)}</section>
    <section class="detail-section"><div class="section-heading"><h3>All tracks</h3><span>${tracks.length}</span></div>${renderSongRows(tracks, { hideQueue: true })}</section>
  `;
};

const renderAlbumCards = (albums) => {
  const visibleAlbums = filterBySearch(albums, (album) => `${album.name} ${album.artists.join(' ')}`);
  if (!visibleAlbums.length) return '<div class="empty-state compact">No tagged albums found.</div>';
  return `<div class="entity-grid album-grid">${visibleAlbums.map((album) => `
    <article class="album-card">
      <button class="album-open" type="button" data-action="open-album" data-id="${escapeHtml(album.id)}">
        <span class="album-cover"><span class="cover-fallback">${escapeHtml(album.name.slice(0, 1).toUpperCase())}</span>${album.coverUrl ? `<img src="${API_ORIGIN}${escapeHtml(album.coverUrl)}" alt="" loading="lazy" />` : ''}</span>
        <span class="entity-title">${escapeHtml(album.name)}</span>
        <span class="entity-caption">${escapeHtml(album.artists.join(', '))} · ${album.tracks.length} tracks</span>
      </button>
      <button class="entity-favorite ${isFavorite('album', album.id) ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="album" data-id="${escapeHtml(album.id)}" data-name="${escapeHtml(album.name)}" aria-label="Favorite album">♥</button>
    </article>
  `).join('')}</div>`;
};

const renderAlbumsView = () => {
  const album = getAlbumById(state.selectedAlbumId);
  if (!album) return `<div class="view-toolbar"><p>${getAlbums().length} tagged albums</p></div>${renderAlbumCards(getAlbums())}`;
  const tracks = currentViewTracks();
  return `
    <button class="back-link" type="button" data-action="back-to-list">← All albums</button>
    <div class="detail-hero album-hero"><span class="album-cover large"><span class="cover-fallback">${escapeHtml(album.name.slice(0, 1).toUpperCase())}</span>${album.coverUrl ? `<img src="${API_ORIGIN}${escapeHtml(album.coverUrl)}" alt="" />` : ''}</span><div><p class="eyebrow">ALBUM</p><h2>${escapeHtml(album.name)}</h2><p>${escapeHtml(album.artists.join(', '))} · ${album.tracks.length} tracks</p></div></div>
    ${renderCollectionControls(tracks)}
    ${renderSongRows(tracks, { hideQueue: true })}
  `;
};

const renderPlaylistCards = () => {
  const playlists = filterBySearch(state.playlists, (playlist) => playlist.name);
  if (!playlists.length) return '<div class="empty-state">No playlists yet. Create one to start collecting tracks.</div>';
  return `<div class="entity-grid playlist-grid">${playlists.map((playlist) => `
    <article class="playlist-card">
      <button class="playlist-open" type="button" data-action="open-playlist" data-id="${escapeHtml(playlist.id)}">
        <span class="playlist-cover" aria-hidden="true">☷</span>
        <span class="entity-title">${escapeHtml(playlist.name)}</span>
        <span class="entity-caption">${playlist.track_ids.length} tracks</span>
      </button>
      <button class="entity-favorite ${isFavorite('playlist', playlist.id) ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="playlist" data-id="${escapeHtml(playlist.id)}" data-name="${escapeHtml(playlist.name)}" aria-label="Favorite playlist">♥</button>
    </article>
  `).join('')}</div>`;
};

const renderPlaylistsView = () => {
  const playlist = getSelectedPlaylist();
  if (!playlist) return `<div class="view-toolbar"><p>${state.playlists.length} playlists</p></div>${renderPlaylistCards()}`;
  const tracks = currentViewTracks();
  return `
    <button class="back-link" type="button" data-action="back-to-list">← All playlists</button>
    <div class="detail-hero playlist-hero"><span class="playlist-cover large" aria-hidden="true">☷</span><div><p class="eyebrow">PLAYLIST</p><h2>${escapeHtml(playlist.name)}</h2><p>${playlist.track_ids.length} tracks · Drag rows to reorder</p></div>
      <button class="entity-favorite ${isFavorite('playlist', playlist.id) ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-type="playlist" data-id="${escapeHtml(playlist.id)}" data-name="${escapeHtml(playlist.name)}" aria-label="Favorite playlist">♥</button>
    </div>
    ${renderCollectionControls(tracks, { trailing: `<button class="quiet-button danger-button" type="button" data-action="delete-playlist" data-id="${escapeHtml(playlist.id)}">Delete playlist</button>` })}
    ${renderSongRows(tracks, { draggable: true, hideQueue: true, removeFromPlaylist: true })}
  `;
};

const renderFavoriteEntities = (type) => {
  const favorites = filterBySearch(state.favorites.filter((favorite) => favorite.type === type), (favorite) => favorite.name);
  if (!favorites.length) return '';
  return `<div class="favorite-entity-list">${favorites.map((favorite) => `
    <article class="favorite-entity">
      <button type="button" class="favorite-entity-main" data-action="open-favorite-entity" data-type="${escapeHtml(favorite.type)}" data-id="${escapeHtml(favorite.id)}">
        <span class="entity-symbol">${type === 'artist' ? '♬' : type === 'album' ? '▦' : '☷'}</span><span><strong>${escapeHtml(favorite.name)}</strong><small>${escapeHtml(type)}</small></span>
      </button>
      <button class="icon-action is-favorite" type="button" data-action="toggle-favorite" data-type="${escapeHtml(favorite.type)}" data-id="${escapeHtml(favorite.id)}" data-name="${escapeHtml(favorite.name)}" aria-label="Remove favorite">♥</button>
    </article>
  `).join('')}</div>`;
};

const renderFavoritesView = () => {
  const tracks = currentViewTracks();
  const songFavorites = state.favorites.filter((favorite) => favorite.type === 'song').length;
  const otherTypes = ['artist', 'album', 'playlist'].map(renderFavoriteEntities).join('');
  const hasEntities = state.favorites.some((favorite) => favorite.type !== 'song');
  return `
    <div class="view-toolbar"><p>${state.favorites.length} saved favorites</p>${renderCollectionControls(tracks)}</div>
    ${hasEntities ? `<section class="detail-section"><div class="section-heading"><h3>Saved collections</h3></div>${otherTypes}</section>` : ''}
    <section class="detail-section"><div class="section-heading"><h3>Favorite tracks</h3><span>${songFavorites}</span></div>${renderSongRows(tracks, { hideQueue: true })}</section>
    ${!state.favorites.length ? '<div class="empty-state">Use the heart menu on a track, artist, album, or playlist to save it here.</div>' : ''}
  `;
};

const viewTitles = { library: 'Library', artists: 'Artists', albums: 'Albums', playlists: 'Playlists', favorites: 'Favorites' };

const renderView = () => {
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  viewTitle.textContent = state.view === 'artists' && state.selectedArtist ? state.selectedArtist : state.view === 'albums' && state.selectedAlbumId ? getAlbumById(state.selectedAlbumId)?.name || 'Albums' : state.view === 'playlists' && state.selectedPlaylistId ? getSelectedPlaylist()?.name || 'Playlists' : viewTitles[state.view];
  viewEyebrow.textContent = state.view === 'library' ? 'YOUR COLLECTION' : viewTitles[state.view].toUpperCase();
  newPlaylistBtn.hidden = state.view !== 'playlists';
  const renderers = { library: renderLibraryView, artists: renderArtistView, albums: renderAlbumsView, playlists: renderPlaylistsView, favorites: renderFavoritesView };
  mainContent.innerHTML = renderers[state.view]();
  document.querySelectorAll('.album-cover img').forEach((image) => {
    image.addEventListener('error', () => { image.hidden = true; }, { once: true });
  });
  trackCount.textContent = String(state.tracks.length);
  sidebarTrackCount.textContent = `${state.tracks.length} tracks`;
  playlistCount.textContent = String(state.playlists.length);
  favoriteCount.textContent = String(state.favorites.length);
};

const toastMessage = (message) => {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastMessage.timeoutId);
  toastMessage.timeoutId = window.setTimeout(() => toast.classList.remove('visible'), 2400);
};

const currentTrackScope = () => currentViewTracks();

const updatePlayerMeta = () => {
  const track = getTrackById(state.selectedTrackId);
  if (!track) {
    trackTitle.textContent = 'No song selected';
    trackArtist.textContent = 'Choose a track from your library';
    audioQualityBadge.hidden = true;
    audioQualityBadge.textContent = '';
    albumArt.innerHTML = '<span aria-hidden="true">♪</span>';
    return;
  }
  trackTitle.textContent = track.title;
  trackArtist.textContent = track.artist || 'Unknown Artist';
  albumArt.innerHTML = `<span aria-hidden="true">${escapeHtml(track.title.slice(0, 1).toUpperCase() || '♪')}</span>`;
  audioQualityBadge.textContent = 'Reading file quality...';
  audioQualityBadge.hidden = false;
  const quality = state.audioQualityByTrackId.get(track.id);
  if (quality) audioQualityBadge.textContent = formatAudioQuality(quality);
  else loadAudioQuality(track.id);
};

const syncPlaybackUI = () => {
  playPauseBtn.textContent = state.isPlaying ? '❚❚' : '▶';
  playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
  playPauseBtn.title = state.isPlaying ? 'Pause' : 'Play';
  shuffleBtn.classList.toggle('active', state.shuffle);
  repeatBtn.classList.toggle('active', state.repeat);
};

const supportsNativeAlac = () => {
  const tester = document.createElement('audio');
  const canPlay = tester.canPlayType('audio/mp4; codecs="alac"') || tester.canPlayType('audio/alac');
  if (canPlay === 'probably' || canPlay === 'maybe') return true;
  const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Android/.test(navigator.userAgent);
  if (isApple && (tester.canPlayType('audio/mp4') || tester.canPlayType('audio/x-m4a'))) {
    return true;
  }
  return false;
};

const isTrackAlac = (track) => {
  if (!track) return false;
  const quality = state.audioQualityByTrackId.get(track.id);
  if (quality?.codec && quality.codec.toLowerCase().includes('alac')) return true;
  if (quality?.format && quality.format.toUpperCase() === 'ALAC') return true;
  if (track.format === 'alac') return true;
  if ((track.format === 'm4a' || track.filename?.endsWith('.m4a')) && /\[ALAC\]|\bALAC\b/i.test(track.filename || track.quality || '')) return true;
  return false;
};

class AlacWebAudioPlayer {
  constructor() {
    this.ctx = null;
    this.gainNode = null;
    this.sourceNode = null;
    this.bufferCache = new Map();
    this.currentTrackId = null;
    this.currentBuffer = null;
    this.duration = 0;
    this.startTime = 0;
    this.startOffset = 0;
    this.isPlaying = false;
    this.abortController = null;
    this.animFrameId = null;
  }

  initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.setValueAtTime(state.volume, this.ctx.currentTime);
      this.gainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  setVolume(vol) {
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
    }
  }

  stopSource() {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (_) {}
      this.sourceNode = null;
    }
    this.cancelProgress();
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.stopSource();
    this.isPlaying = false;
    this.startOffset = 0;
  }

  pause() {
    if (this.isPlaying && this.ctx) {
      this.startOffset = Math.min(this.getCurrentTime(), this.duration);
      this.stopSource();
      this.isPlaying = false;
      state.isPlaying = false;
      syncPlaybackUI();
    }
  }

  resume() {
    if (this.currentBuffer && !this.isPlaying) {
      this.initContext();
      this.playFromOffset(this.startOffset);
    }
  }

  seek(targetSeconds) {
    if (this.currentBuffer) {
      this.startOffset = Math.max(0, Math.min(targetSeconds, this.duration));
      if (this.isPlaying) {
        this.stopSource();
        this.playFromOffset(this.startOffset);
      } else {
        currentTimeEl.textContent = formatTime(this.startOffset);
        if (this.duration > 0) {
          progressSlider.value = String((this.startOffset / this.duration) * 100);
        }
      }
    }
  }

  getCurrentTime() {
    if (!this.ctx || !this.isPlaying) return this.startOffset;
    return Math.min((this.ctx.currentTime - this.startTime) + this.startOffset, this.duration);
  }

  playFromOffset(offset) {
    this.initContext();
    this.stopSource();

    this.startOffset = offset;
    this.startTime = this.ctx.currentTime;
    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      const pos = this.getCurrentTime();
      if (this.isPlaying && pos >= this.duration - 0.3) {
        if (state.repeat) {
          this.playFromOffset(0);
          return;
        }
        this.isPlaying = false;
        state.isPlaying = false;
        syncPlaybackUI();
        this.cancelProgress();
        nextTrack();
      }
    };

    this.sourceNode.start(0, this.startOffset);
    this.isPlaying = true;
    state.isPlaying = true;
    syncPlaybackUI();
    this.startProgress();
  }

  startProgress() {
    this.cancelProgress();
    const update = () => {
      if (this.isPlaying && this.duration > 0) {
        const cur = this.getCurrentTime();
        currentTimeEl.textContent = formatTime(cur);
        progressSlider.value = String((cur / this.duration) * 100);
        this.animFrameId = requestAnimationFrame(update);
      }
    };
    this.animFrameId = requestAnimationFrame(update);
  }

  cancelProgress() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  async loadAndDecode(track) {
    this.stop();
    this.currentTrackId = track.id;

    if (this.bufferCache.has(track.id)) {
      this.currentBuffer = this.bufferCache.get(track.id);
      this.duration = this.currentBuffer.duration;
      totalTimeEl.textContent = formatTime(this.duration);
      progressSlider.max = '100';
      audioQualityBadge.textContent = '[LOSSLESS] ALAC (Web Audio PCM)';
      audioQualityBadge.hidden = false;
      this.playFromOffset(0);
      return;
    }

    if (typeof window.AV === 'undefined') {
      throw new Error('Aurora.js (AV) decoder is not loaded. Please verify vendor/aurora.js.');
    }

    toastMessage('Downloading ALAC file for client-side decoding...');
    audioQualityBadge.textContent = 'Downloading ALAC...';
    audioQualityBadge.hidden = false;

    this.abortController = new AbortController();
    const streamUrl = `${getStreamUrl(track.id)}?direct=1`;
    const response = await fetch(streamUrl, { signal: this.abortController.signal });
    if (!response.ok) {
      throw new Error(`Failed to download audio file (${response.status})`);
    }

    audioQualityBadge.textContent = 'Decoding ALAC to PCM...';
    const arrayBuffer = await response.arrayBuffer();

    return new Promise((resolve, reject) => {
      const asset = window.AV.Asset.fromBuffer(arrayBuffer);
      asset.on('error', (err) => {
        reject(new Error(typeof err === 'string' ? err : err?.message || 'Decoder failed'));
      });

      asset.decodeToBuffer((pcmData) => {
        try {
          const sampleRate = asset.format?.sampleRate || 44100;
          const channels = asset.format?.channelsPerFrame || 2;
          const numFrames = Math.floor(pcmData.length / channels);

          const ctx = this.initContext();
          const audioBuf = ctx.createBuffer(channels, numFrames, sampleRate);

          for (let ch = 0; ch < channels; ch++) {
            const channelArray = audioBuf.getChannelData(ch);
            for (let i = 0, j = ch; i < numFrames; i++, j += channels) {
              channelArray[i] = pcmData[j];
            }
          }

          this.bufferCache.set(track.id, audioBuf);
          this.currentBuffer = audioBuf;
          this.duration = audioBuf.duration;
          totalTimeEl.textContent = formatTime(this.duration);
          progressSlider.max = '100';

          audioQualityBadge.textContent = `[LOSSLESS] ALAC • ${channels}ch / ${(sampleRate / 1000).toLocaleString('en-US')}kHz (Web Audio)`;
          audioQualityBadge.hidden = false;

          this.playFromOffset(0);
          resolve();
        } catch (convErr) {
          reject(convErr);
        }
      });
    });
  }
}

const alacPlayer = new AlacWebAudioPlayer();
let playbackEngine = 'native';

const logPlaybackError = (error) => {
  console.error('Playback error detail:', error);
  const quality = state.audioQualityByTrackId.get(state.selectedTrackId);
  if (error?.name === 'NotSupportedError' && quality?.codec?.toLowerCase().includes('alac')) {
    console.warn('This browser cannot decode ALAC. Client-side decoding should be activated.');
  }
  toastMessage(`Playback error: ${error?.message || error?.name || 'Cannot play this track'}`);
};

const playQueueIndex = (index) => {
  if (index < 0 || index >= state.currentQueue.length) return;
  state.queueIndex = index;
  const track = getTrackById(state.currentQueue[index]);
  if (!track) return;
  state.selectedTrackId = track.id;
  updatePlayerMeta();
  renderView();

  const isAlac = isTrackAlac(track);
  const nativeAlac = supportsNativeAlac();

  if (isAlac && !nativeAlac) {
    audio.pause();
    audio.removeAttribute('src');
    playbackEngine = 'alac-webaudio';

    alacPlayer.loadAndDecode(track).catch((err) => {
      console.error('ALAC Web Audio decode error:', err);
      toastMessage(`Client ALAC decode failed: ${err.message}. Trying direct stream...`);
      playbackEngine = 'native';
      audio.src = `${getStreamUrl(track.id)}?direct=1`;
      audio.load();
      audio.play().catch(logPlaybackError);
    });
  } else {
    alacPlayer.stop();
    playbackEngine = 'native';
    const streamUrl = isAlac ? `${getStreamUrl(track.id)}?direct=1` : getStreamUrl(track.id);
    audio.src = streamUrl;
    audio.load();
    audio.play().catch((error) => {
      state.isPlaying = false;
      syncPlaybackUI();
      logPlaybackError(error);
    });
  }
};

const setQueueAndPlay = (tracks, startTrackId = null, shuffle = false) => {
  state.hiddenTrackIds.clear();
  const uniqueTracks = [...new Map(tracks.filter(Boolean).map((track) => [track.id, track])).values()];
  state.currentQueue = shuffle ? shuffleArray(uniqueTracks).map((track) => track.id) : uniqueTracks.map((track) => track.id);
  if (!state.currentQueue.length) {
    toastMessage('No playable tracks in this collection.');
    return;
  }
  const selectedIndex = startTrackId ? state.currentQueue.indexOf(startTrackId) : 0;
  playQueueIndex(selectedIndex < 0 ? 0 : selectedIndex);
};

const playTrack = (trackId) => setQueueAndPlay(currentTrackScope(), trackId);
const playAll = (shuffle = false, random = false) => {
  const tracks = currentTrackScope();
  const startTrackId = random && tracks.length ? tracks[Math.floor(Math.random() * tracks.length)].id : null;
  setQueueAndPlay(tracks, startTrackId, shuffle || random);
};

const nextTrack = () => {
  if (!state.currentQueue.length) return;
  if (state.queueIndex + 1 < state.currentQueue.length) playQueueIndex(state.queueIndex + 1);
  else if (state.repeat) playQueueIndex(0);
  else {
    if (playbackEngine === 'alac-webaudio') alacPlayer.stop();
    else audio.pause();
    state.isPlaying = false;
    syncPlaybackUI();
  }
};

const previousTrack = () => {
  if (!state.currentQueue.length) return;
  const currentPos = playbackEngine === 'alac-webaudio' ? alacPlayer.getCurrentTime() : audio.currentTime;
  if (currentPos > 3) {
    if (playbackEngine === 'alac-webaudio') alacPlayer.seek(0);
    else audio.currentTime = 0;
    return;
  }
  playQueueIndex(Math.max(0, state.queueIndex - 1));
};

const hideFromQueue = (trackId) => {
  const removedIndex = state.currentQueue.indexOf(trackId);
  if (removedIndex < 0) {
    toastMessage('Track is not in the current queue.');
    return;
  }
  const wasPlaying = removedIndex === state.queueIndex;
  state.currentQueue.splice(removedIndex, 1);
  state.hiddenTrackIds.add(trackId);
  if (wasPlaying) {
    if (playbackEngine === 'alac-webaudio') alacPlayer.stop();
    else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    state.isPlaying = false;
    state.queueIndex = Math.min(removedIndex, state.currentQueue.length - 1);
    if (state.queueIndex >= 0) playQueueIndex(state.queueIndex);
    else {
      state.selectedTrackId = null;
      updatePlayerMeta();
    }
  } else if (removedIndex < state.queueIndex) {
    state.queueIndex -= 1;
  }
  renderView();
  toastMessage('Track hidden from the current queue.');
};

const toggleFavorite = async (type, id, name) => {
  const current = getFavorite(type, id);
  try {
    if (current) {
      await apiRequest(`/favorites?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.favorites = state.favorites.filter((favorite) => !(favorite.type === type && favorite.id === id));
      toastMessage('Removed from favorites.');
    } else {
      const result = await apiRequest('/favorites', { method: 'POST', body: { type, id, name } });
      if (result.favorites) state.favorites = result.favorites;
      else state.favorites = [...state.favorites, result.favorite || result.item];
      toastMessage('Added to favorites.');
    }
    renderView();
  } catch (error) {
    toastMessage(error.message);
  }
};

const renderContextMenu = (trackId, anchor) => {
  const track = getTrackById(trackId);
  if (!track) return;
  state.contextTrackId = trackId;
  const favorite = isFavorite('song', trackId);
  const playlistActions = state.playlists.length ? state.playlists.map((playlist) => `
    <button type="button" role="menuitem" data-context-action="add-playlist" data-playlist-id="${escapeHtml(playlist.id)}">${escapeHtml(playlist.name)}</button>
  `).join('') : '<p class="context-empty">Create a playlist first.</p>';
  contextMenu.innerHTML = `
    <button type="button" role="menuitem" data-context-action="favorite">${favorite ? '♥ Remove favorite' : '♡ Add to favorites'}</button>
    <div class="context-divider"></div><p class="context-label">ADD TO PLAYLIST</p>${playlistActions}
    <div class="context-divider"></div><button type="button" role="menuitem" data-context-action="hide">⊖ Hide from current queue</button>
  `;
  const rect = anchor.getBoundingClientRect();
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.min(rect.right - 220, window.innerWidth - 232)}px`;
  contextMenu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - contextMenu.offsetHeight - 12)}px`;
};

const closeContextMenu = () => { contextMenu.hidden = true; };

const createPlaylist = async (name) => {
  const result = await apiRequest('/playlists', { method: 'POST', body: { name } });
  state.playlists = [...state.playlists, result.item];
  state.selectedPlaylistId = result.item.id;
  state.view = 'playlists';
  renderView();
  toastMessage(`Created “${result.item.name}”.`);
};

const loadCollections = async () => {
  const [songsResult, artistsResult, playlistsResult, favoritesResult] = await Promise.all([
    apiRequest('/songs'), apiRequest('/artists'), apiRequest('/playlists'), apiRequest('/favorites'),
  ]);
  state.tracks = sortedTracks((songsResult.songs || []).map((track) => ({
    ...track,
    artists: track.artists?.length ? track.artists : [track.artist || 'Unknown Artist'],
    title: track.title || track.filename || 'Untitled',
    artist: track.artist || 'Unknown Artist',
    album: track.album || 'Unknown Album',
    duration: Number(track.duration) || 0,
  })));
  state.artists = artistsResult.artists || [];
  state.playlists = playlistsResult.playlists || [];
  state.favorites = favoritesResult.favorites || [];
  if (!state.selectedTrackId && state.tracks.length) {
    state.selectedTrackId = state.tracks[0].id;
    state.currentQueue = state.tracks.map((track) => track.id);
    state.queueIndex = 0;
    const initialTrack = state.tracks[0];
    if (!isTrackAlac(initialTrack) || supportsNativeAlac()) {
      const directParam = isTrackAlac(initialTrack) ? '?direct=1' : '';
      audio.src = `${getStreamUrl(state.selectedTrackId)}${directParam}`;
      audio.load();
    }
    updatePlayerMeta();
  }
  renderView();
};

const showDialog = (dialog) => {
  if (!dialog.open) dialog.showModal();
};

const handleViewAction = async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, type, name } = button.dataset;
  try {
    switch (action) {
      case 'play-track': playTrack(id); break;
      case 'play-all': playAll(); break;
      case 'shuffle-all': state.shuffle = true; syncPlaybackUI(); playAll(true); break;
      case 'random-track': playAll(true, true); break;
      case 'hide-queue': hideFromQueue(id); break;
      case 'toggle-favorite': await toggleFavorite(type, id, name); break;
      case 'open-artist': state.selectedArtist = name; renderView(); break;
      case 'open-album': state.selectedAlbumId = id; renderView(); break;
      case 'open-playlist': state.selectedPlaylistId = id; renderView(); break;
      case 'back-to-list': state.selectedArtist = null; state.selectedAlbumId = null; state.selectedPlaylistId = null; renderView(); break;
      case 'remove-playlist-track': {
        const playlist = getSelectedPlaylist();
        if (!playlist) break;
        const result = await apiRequest(`/playlists/${encodeURIComponent(playlist.id)}/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.playlists = state.playlists.map((item) => item.id === result.playlist.id ? result.playlist : item);
        renderView();
        break;
      }
      case 'delete-playlist': {
        const playlist = getSelectedPlaylist();
        if (!playlist || !window.confirm(`Delete “${playlist.name}”?`)) break;
        await apiRequest(`/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.playlists = state.playlists.filter((item) => item.id !== id);
        state.favorites = state.favorites.filter((item) => !(item.type === 'playlist' && item.id === id));
        state.selectedPlaylistId = null;
        renderView();
        break;
      }
      case 'track-menu': renderContextMenu(id, button); break;
      case 'open-favorite-entity':
        if (type === 'artist') { state.view = 'artists'; state.selectedArtist = state.artists.find((artist) => artistId(artist.name) === id)?.name || name; }
        if (type === 'album') { state.view = 'albums'; state.selectedAlbumId = id; }
        if (type === 'playlist') { state.view = 'playlists'; state.selectedPlaylistId = id; }
        renderView();
        break;
      default: break;
    }
  } catch (error) {
    console.error('Collection action failed:', error);
    toastMessage(error.message);
  }
};

mainContent.addEventListener('click', handleViewAction);
mainContent.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-playlist-drag-id]');
  if (!row) return;
  event.dataTransfer.setData('text/plain', row.dataset.playlistDragId);
  event.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
mainContent.addEventListener('dragend', (event) => event.target.closest('.song-row')?.classList.remove('dragging'));
mainContent.addEventListener('dragover', (event) => {
  if (event.target.closest('[data-playlist-drag-id]')) event.preventDefault();
});
mainContent.addEventListener('drop', async (event) => {
  const targetRow = event.target.closest('[data-playlist-drag-id]');
  if (!targetRow || !state.selectedPlaylistId) return;
  event.preventDefault();
  const draggedId = event.dataTransfer.getData('text/plain');
  const targetId = targetRow.dataset.playlistDragId;
  if (!draggedId || draggedId === targetId) return;
  const playlist = getSelectedPlaylist();
  const order = [...playlist.track_ids];
  const fromIndex = order.indexOf(draggedId);
  const toIndex = order.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return;
  order.splice(fromIndex, 1);
  order.splice(toIndex, 0, draggedId);
  try {
    const result = await apiRequest(`/playlists/${encodeURIComponent(playlist.id)}`, { method: 'PUT', body: { track_ids: order } });
    state.playlists = state.playlists.map((item) => item.id === result.playlist.id ? result.playlist : item);
    renderView();
  } catch (error) {
    toastMessage(error.message);
  }
});

contextMenu.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-context-action]');
  if (!button) return;
  const track = getTrackById(state.contextTrackId);
  if (!track) return closeContextMenu();
  const { contextAction, playlistId } = button.dataset;
  closeContextMenu();
  try {
    if (contextAction === 'favorite') await toggleFavorite('song', track.id, track.title);
    if (contextAction === 'hide') hideFromQueue(track.id);
    if (contextAction === 'add-playlist') {
      const playlist = state.playlists.find((item) => item.id === playlistId);
      if (!playlist) return;
      const result = await apiRequest(`/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'POST', body: { track_id: track.id } });
      state.playlists = state.playlists.map((item) => item.id === result.playlist.id ? result.playlist : item);
      toastMessage(`Added to “${playlist.name}”.`);
    }
  } catch (error) {
    toastMessage(error.message);
  }
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  state.selectedArtist = null;
  state.selectedAlbumId = null;
  state.selectedPlaylistId = null;
  state.search = '';
  searchInput.value = '';
  renderView();
}));

document.querySelector('[data-view-link="library"]').addEventListener('click', (event) => {
  event.preventDefault();
  state.view = 'library';
  state.selectedArtist = null;
  state.selectedAlbumId = null;
  state.selectedPlaylistId = null;
  renderView();
});

searchInput.addEventListener('input', () => renderView());
document.getElementById('requestSongBtn').addEventListener('click', () => {
  requestFormMessage.textContent = '';
  showDialog(requestDialog);
});
document.getElementById('newPlaylistBtn').addEventListener('click', () => showDialog(playlistDialog));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(requestForm);
  try {
    await apiRequest('/requests', { method: 'POST', body: Object.fromEntries(formData.entries()) });
    requestForm.reset();
    requestDialog.close();
    toastMessage('Song request sent.');
  } catch (error) {
    requestFormMessage.textContent = error.message;
  }
});

playlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(playlistForm).get('name')?.toString().trim();
  if (!name) return;
  try {
    await createPlaylist(name);
    playlistForm.reset();
    playlistDialog.close();
  } catch (error) {
    toastMessage(error.message);
  }
});

document.addEventListener('click', (event) => {
  if (!contextMenu.hidden && !event.target.closest('#contextMenu') && !event.target.closest('[data-action="track-menu"]')) closeContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.target.matches('input, textarea')) {
    event.preventDefault();
    searchInput.focus();
  }
});

playPauseBtn.addEventListener('click', () => {
  if (!state.selectedTrackId) return;
  if (playbackEngine === 'alac-webaudio') {
    if (alacPlayer.isPlaying) {
      alacPlayer.pause();
    } else {
      alacPlayer.resume();
    }
  } else {
    if (audio.paused) audio.play().catch(logPlaybackError);
    else audio.pause();
  }
});
prevBtn.addEventListener('click', previousTrack);
nextBtn.addEventListener('click', nextTrack);
shuffleBtn.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  syncPlaybackUI();
  if (state.currentQueue.length > 1) {
    const trackId = state.currentQueue[state.queueIndex];
    const queuedTracks = state.currentQueue.map(getTrackById).filter(Boolean);
    setQueueAndPlay(queuedTracks, trackId, state.shuffle);
  }
});
repeatBtn.addEventListener('click', () => {
  state.repeat = !state.repeat;
  audio.loop = state.repeat;
  syncPlaybackUI();
});
progressSlider.addEventListener('input', () => {
  const fraction = Number(progressSlider.value) / 100;
  if (playbackEngine === 'alac-webaudio') {
    if (alacPlayer.duration > 0) {
      alacPlayer.seek(fraction * alacPlayer.duration);
    }
  } else {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = fraction * audio.duration;
  }
});
volumeSlider.addEventListener('input', () => {
  state.volume = Number(volumeSlider.value);
  audio.volume = state.volume;
  alacPlayer.setVolume(state.volume);
  volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
});
audio.addEventListener('loadedmetadata', () => {
  if (playbackEngine === 'native' && Number.isFinite(audio.duration)) {
    totalTimeEl.textContent = formatTime(audio.duration);
    progressSlider.max = '100';
  }
});
audio.addEventListener('timeupdate', () => {
  if (playbackEngine === 'native') {
    currentTimeEl.textContent = formatTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) progressSlider.value = String((audio.currentTime / audio.duration) * 100);
  }
});
audio.addEventListener('play', () => {
  if (playbackEngine === 'native') {
    state.isPlaying = true;
    syncPlaybackUI();
  }
});
audio.addEventListener('pause', () => {
  if (playbackEngine === 'native') {
    state.isPlaying = false;
    syncPlaybackUI();
  }
});
audio.addEventListener('ended', nextTrack);
audio.addEventListener('error', () => {
  if (playbackEngine === 'native') {
    state.isPlaying = false;
    syncPlaybackUI();
    const errCode = audio.error ? `Code ${audio.error.code}: ${audio.error.message || 'Media source error'}` : 'Unknown audio error';
    console.error('Audio source error:', audio.error);
    toastMessage(`Audio playback error (${errCode})`);
  }
});

volumeSlider.value = String(state.volume);
volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
audio.volume = state.volume;
alacPlayer.setVolume(state.volume);
syncPlaybackUI();
renderView();
loadCollections().catch((error) => {
  console.error('Failed to load library:', error);
  mainContent.innerHTML = `<div class="empty-state">Unable to load your library: ${escapeHtml(error.message)}</div>`;
});
