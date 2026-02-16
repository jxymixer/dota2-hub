// =============================================================================
// Dota 2 Team Tracker - Frontend
// =============================================================================

const TEAMS = {
  xg: { id: 8261500, name: 'Xtreme Gaming', tag: 'XG' },
  yb: { id: 9351740, name: 'Yakult Brothers', tag: 'YB' },
  vg: { id: 726228, name: 'Vici Gaming', tag: 'VG' }
};

let teamsData = {};
let heroMap = {};
let liveMatches = [];
let upcomingMatches = [];
let lastUpdated = null;
let lastRenderedHash = '';
let pollInterval = null;
const playerHeroCache = {}; // account_id -> heroes[]

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function fetchData() {
  const res = await fetch('/api/data');
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  teamsData = data.teams || {};
  heroMap = data.heroMap || {};
  liveMatches = data.liveMatches || [];
  upcomingMatches = data.upcoming || [];
  lastUpdated = data.lastUpdated;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '--';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function formatDate(epoch) {
  if (!epoch) return '--';
  return new Date(epoch * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ts) {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d)) return 'TBD';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(epoch) {
  if (!epoch) return '';
  const diff = Date.now() / 1000 - epoch;
  if (diff < 0) {
    const a = Math.abs(diff);
    if (a < 3600) return `in ${Math.floor(a / 60)}m`;
    if (a < 86400) return `in ${Math.floor(a / 3600)}h`;
    return `in ${Math.floor(a / 86400)}d`;
  }
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(epoch);
}

function winRate(w, total) {
  if (!total) return '0.0';
  return ((w / total) * 100).toFixed(1);
}

function didWin(m) {
  return (m.radiant === true && m.radiant_win === true) || (m.radiant === false && m.radiant_win === false);
}

function heroImg(id) {
  const h = heroMap[id];
  return (h && h.img) ? 'https://cdn.cloudflare.steamstatic.com' + h.img : '';
}

function heroIconUrl(id) {
  const h = heroMap[id];
  return (h && h.icon) ? 'https://cdn.cloudflare.steamstatic.com' + h.icon : '';
}

function heroName(id) {
  const h = heroMap[id];
  return h ? h.localized_name : `Hero ${id}`;
}

// ---------------------------------------------------------------------------
// Series grouping
// ---------------------------------------------------------------------------
function groupMatchesIntoSeries(matches) {
  if (!matches || !matches.length) return [];
  const sorted = [...matches].sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  const series = [];
  let cur = null;

  for (const m of sorted) {
    const oppId = m.opposing_team_id;
    const league = m.league_name || '';
    if (cur && cur.opponentId === oppId && cur.league === league && cur.games.length > 0) {
      const lastTime = cur.games[cur.games.length - 1].start_time || 0;
      if (Math.abs((m.start_time || 0) - lastTime) < 6 * 3600) {
        cur.games.push(m);
        if (didWin(m)) cur.wins++; else cur.losses++;
        continue;
      }
    }
    const won = didWin(m);
    cur = {
      league, leagueid: m.leagueid, opponent: m.opposing_team_name || 'Unknown',
      opponentId: oppId, wins: won ? 1 : 0, losses: won ? 0 : 1,
      games: [m], latestTime: m.start_time || 0,
    };
    series.push(cur);
  }

  for (const s of series) {
    const total = s.games.length;
    const max = Math.max(s.wins, s.losses);
    if (total === 1) s.boType = 'BO1';
    else if (max === 2 && total <= 3) s.boType = 'BO3';
    else if (max === 3 && total <= 5) s.boType = 'BO5';
    else s.boType = `${total}G`;
    s.seriesWon = s.wins > s.losses;
    s.games.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
  }
  return series;
}

function groupSeriesByLeague(list) {
  const leagues = [], map = {};
  for (const s of list) {
    const key = s.league || 'Unknown League';
    if (!map[key]) { map[key] = { name: key, series: [], latestTime: 0, totalW: 0, totalL: 0, seriesW: 0, seriesL: 0 }; leagues.push(map[key]); }
    const lg = map[key];
    lg.series.push(s); lg.totalW += s.wins; lg.totalL += s.losses;
    if (s.seriesWon) lg.seriesW++; else lg.seriesL++;
    if (s.latestTime > lg.latestTime) lg.latestTime = s.latestTime;
  }
  leagues.sort((a, b) => b.latestTime - a.latestTime);
  return leagues;
}

function getOngoingTournaments() {
  const cutoff = Date.now() / 1000 - 5 * 86400;
  const tournaments = {};
  for (const [key, team] of Object.entries(teamsData)) {
    if (!team.matches) continue;
    for (const s of groupMatchesIntoSeries(team.matches).filter(s => s.latestTime > cutoff)) {
      const lg = s.league || 'Unknown';
      if (!tournaments[lg]) tournaments[lg] = { name: lg, teams: {}, latestTime: 0 };
      if (!tournaments[lg].teams[key]) tournaments[lg].teams[key] = { series: [], wins: 0, losses: 0 };
      tournaments[lg].teams[key].series.push(s);
      if (s.seriesWon) tournaments[lg].teams[key].wins++; else tournaments[lg].teams[key].losses++;
      if (s.latestTime > tournaments[lg].latestTime) tournaments[lg].latestTime = s.latestTime;
    }
  }
  return Object.values(tournaments).sort((a, b) => b.latestTime - a.latestTime);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function showLoading() { const el = document.getElementById('loading-overlay'); if (el) el.style.display = 'flex'; }
function hideLoading() { const el = document.getElementById('loading-overlay'); if (el) el.style.display = 'none'; }

// ---------------------------------------------------------------------------
// Toggle helpers
// ---------------------------------------------------------------------------
function toggleSeries(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const row = el.previousElementSibling;
  el.classList.toggle('open');
  if (row) row.classList.toggle('expanded');
}

async function togglePlayerHeroes(accountId, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const row = el.previousElementSibling;

  if (el.classList.contains('open')) {
    el.classList.remove('open');
    if (row) row.classList.remove('expanded');
    return;
  }

  el.classList.add('open');
  if (row) row.classList.add('expanded');

  // Check cache
  if (playerHeroCache[accountId]) {
    renderPlayerHeroes(el, playerHeroCache[accountId]);
    return;
  }

  el.innerHTML = '<div class="player-heroes-loading"><div class="spinner-sm"></div> Loading heroes...</div>';

  try {
    const res = await fetch(`/api/player/${accountId}/heroes`);
    const heroes = await res.json();
    playerHeroCache[accountId] = heroes;
    renderPlayerHeroes(el, heroes);
  } catch (err) {
    el.innerHTML = '<div class="text-muted" style="padding:8px 12px">Could not load hero data</div>';
  }
}

function renderPlayerHeroes(el, heroes) {
  if (!heroes || !heroes.length) {
    el.innerHTML = '<div class="text-muted" style="padding:8px 12px">No hero data available</div>';
    return;
  }
  el.innerHTML = `<div class="player-heroes-grid">
    ${heroes.map(h => {
      const img = heroImg(h.hero_id);
      const name = heroName(h.hero_id);
      const wr = winRate(h.win, h.games);
      return `<div class="player-hero-item">
        ${img ? `<img class="player-hero-img" src="${img}" alt="${esc(name)}" onerror="this.style.display='none'">` : ''}
        <div class="player-hero-info">
          <span class="player-hero-name">${esc(name)}</span>
          <span class="player-hero-stats">${h.games}G ${wr}%</span>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// Render: Live Banner
// ---------------------------------------------------------------------------
function renderLive() {
  const el = document.getElementById('live-banner');
  if (!el) return;
  if (!liveMatches.length) { el.innerHTML = ''; el.className = ''; return; }
  el.className = 'live-banner';
  el.innerHTML = `
    <div class="live-indicator"></div>
    <span class="live-label">LIVE</span>
    <div class="live-matches-list">
      ${liveMatches.map(m => {
        const rad = esc(m.team_name_radiant || 'Radiant');
        const dire = esc(m.team_name_dire || 'Dire');
        return `<div class="live-match-item">
          <span class="live-team">${rad}</span>
          <span class="live-score">${m.radiant_score ?? '?'} - ${m.dire_score ?? '?'}</span>
          <span class="live-team">${dire}</span>
          ${m.game_time ? `<span class="live-time">${formatDuration(m.game_time)}</span>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Render: Upcoming & Ongoing
// ---------------------------------------------------------------------------
function renderUpcomingSection() {
  let html = '';

  // Scheduled upcoming from Liquipedia
  if (upcomingMatches.length > 0) {
    const cards = upcomingMatches.map(m => {
      const timeStr = m.timestamp ? relativeTime(m.timestamp) : '';
      const dateStr = m.timestamp ? formatDateTime(m.timestamp) : 'TBD';
      // Get team logos - proxy Liquipedia URLs to avoid hotlink blocking
      const proxyUrl = (url) => url && url.startsWith('https://liquipedia.net/')
        ? `/api/img?url=${encodeURIComponent(url)}` : url;
      const ourTeam = teamsData[m.teamKey];
      const ourLogo = proxyUrl(m.ourLogo) || ourTeam?.info?.logo_url;
      const oppLogo = proxyUrl(m.oppLogo);
      const ourLogoHtml = ourLogo
        ? `<img class="upcoming-logo" src="${esc(ourLogo)}" alt="${esc(m.teamTag)}" onerror="this.style.display='none'">`
        : '';
      const oppLogoHtml = oppLogo
        ? `<img class="upcoming-logo" src="${esc(oppLogo)}" alt="${esc(m.opponent)}" onerror="this.style.display='none'">`
        : '';
      return `<div class="upcoming-card">
        <div class="upcoming-teams">
          <div class="upcoming-team-block ours">
            ${ourLogoHtml}
            <span class="upcoming-team-name">${esc(m.teamTag)}</span>
          </div>
          <span class="upcoming-vs">vs</span>
          <div class="upcoming-team-block">
            ${oppLogoHtml}
            <span class="upcoming-team-name">${esc(m.opponent)}</span>
          </div>
        </div>
        <div class="upcoming-meta">
          ${m.bestOf ? `<span class="upcoming-bo">${esc(m.bestOf)}</span>` : ''}
          <span class="upcoming-tournament">${esc(m.tournament)}</span>
        </div>
        <div class="upcoming-time">${dateStr} <span class="text-muted">${timeStr}</span></div>
      </div>`;
    }).join('');
    html += `<div class="upcoming-block fade-in">
      <h2 class="section-title">Upcoming Matches</h2>
      <div class="upcoming-grid">${cards}</div>
    </div>`;
  }

  // Ongoing tournaments
  const ongoing = getOngoingTournaments();
  if (ongoing.length > 0) {
    const cards = ongoing.map(t => {
      const ago = relativeTime(t.latestTime);
      const teamRows = Object.entries(t.teams).map(([key, data]) => {
        const last = data.series[0];
        return `<div class="ongoing-team-row">
          <span class="ongoing-team-tag" onclick="navigate('${key}')">${esc(TEAMS[key].tag)}</span>
          <span class="ongoing-record">${data.wins}W-${data.losses}L</span>
          ${last ? `<span class="ongoing-last">Last: vs ${esc(last.opponent)} <span class="${last.seriesWon ? 'text-win' : 'text-loss'}">${last.wins}:${last.losses}</span></span>` : ''}
        </div>`;
      }).join('');
      return `<div class="ongoing-card">
        <div class="ongoing-header">
          <span class="ongoing-name">${esc(t.name)}</span>
          <span class="ongoing-ago">${ago}</span>
        </div>
        ${teamRows}
      </div>`;
    }).join('');
    html += `<div class="ongoing-block fade-in">
      <h2 class="section-title">${upcomingMatches.length ? 'Ongoing Tournaments' : 'Upcoming & Recent Tournaments'}</h2>
      <div class="ongoing-grid">${cards}</div>
    </div>`;
  }

  return html || '';
}

// ---------------------------------------------------------------------------
// Render: Overview
// ---------------------------------------------------------------------------
function renderOverview() {
  const el = document.getElementById('content');
  const keys = Object.keys(TEAMS);

  const upcomingHtml = renderUpcomingSection();

  const cards = keys.map(key => {
    const t = teamsData[key];
    if (!t) return `<div class="team-card"><p class="text-muted">Loading ${TEAMS[key].name}...</p></div>`;
    const info = t.info || {};
    const w = info.wins || 0, l = info.losses || 0;
    const rating = info.rating ? Math.round(info.rating) : '--';
    const wr = winRate(w, w + l);
    const logo = info.logo_url
      ? `<img class="team-logo" src="${esc(info.logo_url)}" alt="${esc(info.tag)}" onerror="this.style.display='none'">`
      : `<div class="team-logo-placeholder">${esc(TEAMS[key].tag)}</div>`;

    const recentSeries = groupMatchesIntoSeries(t.matches || []).slice(0, 5);
    const dots = recentSeries.map(s =>
      `<span class="form-dot ${s.seriesWon ? 'win' : 'loss'}" title="${s.seriesWon ? 'Win' : 'Loss'} vs ${esc(s.opponent)} (${s.wins}:${s.losses})">${s.wins}:${s.losses}</span>`
    ).join('');

    return `<div class="team-card" onclick="navigate('${key}')">
      <div class="card-header">
        ${logo}
        <div class="card-title">
          <h2>${esc(info.name || TEAMS[key].name)}</h2>
          <span class="team-tag">${esc(TEAMS[key].tag)}</span>
        </div>
      </div>
      <div class="card-stats">
        <div class="stat-block"><span class="stat-value">${rating}</span><span class="stat-label">Rating</span></div>
        <div class="stat-block"><span class="stat-value">${w}<span class="text-muted">-</span>${l}</span><span class="stat-label">Record</span></div>
        <div class="stat-block"><span class="stat-value">${wr}<small>%</small></span><span class="stat-label">Win Rate</span></div>
      </div>
      <div class="win-rate-bar"><div class="win-rate-fill" style="width:${wr}%"></div></div>
      <div class="recent-form">
        <span class="form-label">Recent Series</span>
        <div class="form-dots">${dots}</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = upcomingHtml +
    `<h2 class="section-title">Teams</h2>
    <div class="overview-grid fade-in">${cards}</div>`;
  renderTimestamp();
}

// ---------------------------------------------------------------------------
// Render: Team Dashboard
// ---------------------------------------------------------------------------
function renderTeamDashboard(key) {
  const el = document.getElementById('content');
  const t = teamsData[key];
  if (!t) { el.innerHTML = '<div class="error-box">No data available.</div>'; return; }

  const info = t.info || {};
  const w = info.wins || 0, l = info.losses || 0;
  const wr = winRate(w, w + l);
  const rating = info.rating ? Math.round(info.rating) : '--';
  const logo = info.logo_url
    ? `<img class="team-logo-lg" src="${esc(info.logo_url)}" alt="" onerror="this.style.display='none'">`
    : `<div class="team-logo-placeholder lg">${esc(TEAMS[key].tag)}</div>`;

  // --- Header ---
  const header = `<div class="team-header fade-in">
    ${logo}
    <div class="team-header-info">
      <h1>${esc(info.name || TEAMS[key].name)}</h1>
      <div class="team-header-meta">
        <span class="meta-badge">Rating: <strong>${rating}</strong></span>
        <span class="meta-badge">Record: <strong>${w}W - ${l}L</strong></span>
      </div>
      <div class="wr-bar-wrap">
        <div class="wr-bar-track"><div class="wr-bar-fill" style="width:${wr}%"></div></div>
        <span class="wr-label">${wr}% Win Rate</span>
      </div>
    </div>
  </div>`;

  // --- Roster (exactly 5 current players from recent match) ---
  const players = t.roster || [];
  let playerCounter = 0;
  const rosterRows = players.map(p => {
    const gp = p.games_played || 0;
    const pw = p.wins || 0;
    const pid = `player-heroes-${key}-${playerCounter++}`;
    const lastHeroImg = p.hero_id ? heroIconUrl(p.hero_id) : '';
    const lastHeroName = p.hero_id ? heroName(p.hero_id) : '';

    return `<tr class="player-row" onclick="togglePlayerHeroes(${p.account_id}, '${pid}')">
      <td class="player-name">
        <span class="player-expand-icon">&#9654;</span>
        ${esc(p.name)}
      </td>
      <td>${lastHeroImg ? `<img class="last-hero-icon" src="${lastHeroImg}" alt="${esc(lastHeroName)}" title="Last played: ${esc(lastHeroName)}">` : '--'}</td>
      <td>${gp}</td>
      <td>${pw}</td>
      <td>${winRate(pw, gp)}%</td>
    </tr>
    <tr class="player-heroes-row"><td colspan="5">
      <div class="player-heroes-container" id="${pid}"></div>
    </td></tr>`;
  }).join('');

  const roster = `<div class="dash-section fade-in">
    <h2 class="section-title">Current Roster</h2>
    <div class="table-wrap">
      <table class="data-table roster-table">
        <thead><tr><th>Player</th><th>Last Hero</th><th>Games</th><th>Wins</th><th>Win Rate</th></tr></thead>
        <tbody>${rosterRows || '<tr><td colspan="5" class="text-muted">No roster data</td></tr>'}</tbody>
      </table>
    </div>
    <p class="roster-hint">Click a player to see their most played heroes</p>
  </div>`;

  // --- Match History ---
  const allSeries = groupMatchesIntoSeries(t.matches || []);
  const leagues = groupSeriesByLeague(allSeries);
  let sc = 0;
  const matchSection = leagues.map(lg => {
    const lgWr = winRate(lg.totalW, lg.totalW + lg.totalL);
    const rows = lg.series.map(s => {
      const sid = `series-${key}-${sc++}`;
      const ago = relativeTime(s.latestTime);
      const details = s.games.map((g, i) => {
        const gW = didWin(g);
        const rs = g.radiant_score ?? '?', ds = g.dire_score ?? '?';
        const our = g.radiant ? rs : ds, their = g.radiant ? ds : rs;
        return `<div class="game-detail ${gW ? 'game-win' : 'game-loss'}">
          <span class="game-num">Game ${i + 1}</span>
          <span class="game-score">${our} - ${their}</span>
          <span class="game-badge ${gW ? 'badge-win' : 'badge-loss'}">${gW ? 'WIN' : 'LOSS'}</span>
          <span class="game-duration">${formatDuration(g.duration)}</span>
          <span class="game-date">${formatDate(g.start_time)}</span>
        </div>`;
      }).join('');
      return `<div class="series-row ${s.seriesWon ? 'series-won' : 'series-lost'}" onclick="toggleSeries('${sid}')">
        <span class="series-chevron">&#9654;</span>
        <span class="series-opponent">${esc(s.opponent)}</span>
        <span class="series-bo">${esc(s.boType)}</span>
        <span class="series-score ${s.seriesWon ? 'text-win' : 'text-loss'}">${s.wins}:${s.losses}</span>
        <span class="series-result-badge ${s.seriesWon ? 'badge-win' : 'badge-loss'}">${s.seriesWon ? 'WIN' : 'LOSS'}</span>
        <span class="series-time">${ago}</span>
      </div>
      <div class="series-games" id="${sid}">${details}</div>`;
    }).join('');

    return `<div class="league-block fade-in">
      <div class="league-header">
        <h3 class="league-name-title">${esc(lg.name)}</h3>
        <div class="league-meta">
          <span class="league-record">${lg.seriesW}W - ${lg.seriesL}L series</span>
          <span class="league-wr">${lgWr}% map WR</span>
        </div>
      </div>
      <div class="series-list">${rows}</div>
    </div>`;
  }).join('');

  const matchHistory = `<div class="dash-section fade-in">
    <h2 class="section-title">Match History</h2>
    ${matchSection || '<p class="text-muted">No match data</p>'}
  </div>`;

  // --- Top Heroes ---
  const topHeroes = [...(t.heroes || [])].sort((a, b) => (b.games_played || 0) - (a.games_played || 0)).slice(0, 10);
  const heroCards = topHeroes.map(h => {
    const img = heroImg(h.hero_id);
    const name = heroName(h.hero_id);
    const gp = h.games_played || 0, hw = h.wins || 0;
    return `<div class="hero-card">
      ${img ? `<img class="hero-img" src="${img}" alt="${esc(name)}" onerror="this.style.display='none'">` : '<div class="hero-img-placeholder"></div>'}
      <div class="hero-overlay">
        <div class="hero-name">${esc(name)}</div>
        <div class="hero-stat">${gp} games | ${winRate(hw, gp)}% WR</div>
      </div>
    </div>`;
  }).join('');

  const heroSection = `<div class="dash-section fade-in">
    <h2 class="section-title">Team Hero Pool</h2>
    <div class="hero-grid">${heroCards || '<p class="text-muted">No hero data</p>'}</div>
  </div>`;

  el.innerHTML = header + roster + matchHistory + heroSection;
  renderTimestamp();
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------
function renderTimestamp() {
  let el = document.getElementById('last-updated');
  if (!el) { el = document.createElement('div'); el.id = 'last-updated'; document.getElementById('content').appendChild(el); }
  if (lastUpdated) el.textContent = `Last updated: ${new Date(lastUpdated).toLocaleTimeString()}`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function navigate(view) { window.location.hash = view; }

function getCurrentView() { return window.location.hash.replace('#', '') || 'overview'; }

function renderCurrentView() {
  const hash = getCurrentView();
  setActiveTab(hash);
  if (hash === 'overview') renderOverview();
  else if (TEAMS[hash]) renderTeamDashboard(hash);
  else { renderOverview(); setActiveTab('overview'); }
  renderLive();
  lastRenderedHash = lastUpdated;
}

function setActiveTab(view) {
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.classList.toggle('tab-active', tab.dataset.view === view);
  });
}

// ---------------------------------------------------------------------------
// Polling - only update live banner, no full re-render
// ---------------------------------------------------------------------------
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const prev = lastUpdated;
      await fetchData();
      renderLive();
      if (lastUpdated !== prev && lastUpdated !== lastRenderedHash) renderCurrentView();
      else renderTimestamp();
    } catch (_) {}
  }, 30000);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => navigate(tab.dataset.view));
  });
  window.addEventListener('hashchange', renderCurrentView);

  showLoading();
  (async function tryLoad(n) {
    try {
      await fetchData();
      hideLoading();
      renderCurrentView();
      startPolling();
    } catch (err) {
      if (n < 10) {
        document.querySelector('.loading-text').textContent = 'Waiting for server...';
        setTimeout(() => tryLoad(n + 1), 2000);
      } else {
        hideLoading();
        document.getElementById('content').innerHTML =
          '<div class="error-box">Could not connect. Make sure <code>node server.js</code> is running.</div>';
      }
    }
  })(0);
});
