// =============================================================================
// Dota 2 Tracker - Backend Server (zero dependencies)
// =============================================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Load .env file if present
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
} catch (_) {}

const PORT = process.env.PORT || 3000;
const API_BASE = 'https://api.opendota.com/api';
const API_KEY = process.env.OPENDOTA_API_KEY || '';
const REFRESH_INTERVAL = 5 * 60 * 1000;
const LIVE_REFRESH_INTERVAL = 60 * 1000;

const TEAMS = {
  xg: { id: 8261500, name: 'Xtreme Gaming', tag: 'XG' },
  yb: { id: 9351740, name: 'Yakult Brothers', tag: 'YB' },
  vg: { id: 726228, name: 'Vici Gaming', tag: 'VG' }
};

let cachedData = null;
let isRefreshing = false;
const playerHeroCache = {}; // account_id -> { data, timestamp }

// ---------------------------------------------------------------------------
// HTTPS JSON fetcher (OpenDota)
// ---------------------------------------------------------------------------
function fetchJSON(endpoint) {
  return new Promise((resolve, reject) => {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = API_KEY ? `${API_BASE}${endpoint}${sep}api_key=${API_KEY}` : `${API_BASE}${endpoint}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode === 429) { reject(new Error('Rate limited')); return; }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error on ${endpoint}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchWithRetry(endpoint, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fetchJSON(endpoint); }
    catch (err) { if (i === retries - 1) throw err; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}

// ---------------------------------------------------------------------------
// Generic HTTPS GET
// ---------------------------------------------------------------------------
function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Dota2PersonalTracker/1.0',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      ...extraHeaders
    };
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
        res.resume(); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Build REAL 5-man rosters from most recent match data
// ---------------------------------------------------------------------------
async function buildCurrentRosters(teamResults, proPlayers) {
  // Build pro player name lookup by account_id
  const proNameMap = {};
  (proPlayers || []).forEach(p => {
    if (p.account_id && p.name) proNameMap[p.account_id] = p.name;
  });

  const rosters = {};

  for (const t of teamResults) {
    const teamId = TEAMS[t.key].id;
    const recentMatch = (t.matches || [])[0];
    if (!recentMatch) { rosters[t.key] = []; continue; }

    try {
      const matchDetail = await fetchWithRetry(`/matches/${recentMatch.match_id}`);
      if (!matchDetail || !matchDetail.players) { rosters[t.key] = []; continue; }

      // Determine if our team was radiant or dire
      const isRadiant = recentMatch.radiant === true;
      const teamPlayers = matchDetail.players.filter(p =>
        isRadiant ? p.player_slot < 128 : p.player_slot >= 128
      );

      // Build team player stats lookup from the team/players endpoint
      const statsMap = {};
      (t.players || []).forEach(p => { statsMap[p.account_id] = p; });

      rosters[t.key] = teamPlayers.map(p => ({
        account_id: p.account_id,
        name: proNameMap[p.account_id] || p.personaname || String(p.account_id),
        personaname: p.personaname || '',
        games_played: statsMap[p.account_id]?.games_played || 0,
        wins: statsMap[p.account_id]?.wins || 0,
        hero_id: p.hero_id, // hero from latest match
      }));

      console.log(`  ${t.key.toUpperCase()} roster: ${rosters[t.key].map(p => p.name).join(', ')}`);
    } catch (err) {
      console.log(`  ${t.key.toUpperCase()} roster fetch failed: ${err.message}`);
      rosters[t.key] = [];
    }
  }
  return rosters;
}

// ---------------------------------------------------------------------------
// Fetch upcoming tournament data from Liquipedia
// ---------------------------------------------------------------------------
async function fetchUpcoming() {
  const upcoming = [];
  try {
    // Correct page: Liquipedia:Matches (the old page redirects here)
    const raw = await httpsGet(
      'https://liquipedia.net/dota2/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text'
    );
    const data = JSON.parse(raw);
    const html = data?.parse?.text?.['*'] || '';
    if (html.length < 1000) return upcoming;

    // Build lookup for our team names (from Liquipedia link titles)
    const teamLookup = {};
    for (const [key, cfg] of Object.entries(TEAMS)) {
      teamLookup[cfg.name.toLowerCase()] = key;
      teamLookup[cfg.tag.toLowerCase()] = key;
      // Also match partial names
      teamLookup[cfg.name.split(' ')[0].toLowerCase()] = key;
    }

    // Split HTML by individual match blocks
    const matchBlocks = html.split(/<div class="match-info">/);

    for (let i = 1; i < matchBlocks.length; i++) {
      // Trim to just this match block (up to next match-info or end)
      const block = matchBlocks[i].substring(0, 5000);

      // Extract team names and logos from <a href="/dota2/Team"><img src="...">
      const teamImgRe = /href="\/dota2\/([^"]+)"\s+title="([^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/g;
      const teamNamesSet = new Set();
      const teamLogos = {}; // team name -> logo URL
      let m;
      while ((m = teamImgRe.exec(block)) !== null) {
        const title = m[2].trim();
        const imgSrc = m[3];
        if (title.includes('/') || title.includes('#')) continue;
        if (title.length >= 2 && title.length < 40) {
          teamNamesSet.add(title);
          // Prefer darkmode or allmode logos for our dark theme
          if (!teamLogos[title] || imgSrc.includes('darkmode') || imgSrc.includes('allmode')) {
            teamLogos[title] = 'https://liquipedia.net' + imgSrc;
          }
        }
      }
      const teamNames = [...teamNamesSet];
      if (teamNames.length < 2) continue;

      // Check if any of our teams are in this match
      let ourKey = null;
      for (const name of teamNames) {
        const lower = name.toLowerCase();
        for (const [pattern, key] of Object.entries(teamLookup)) {
          if (lower.includes(pattern) || pattern.includes(lower)) { ourKey = key; break; }
        }
        if (ourKey) break;
      }
      if (!ourKey) continue;

      // Extract timestamp
      const tsMatch = block.match(/data-timestamp="(\d+)"/);
      const timestamp = tsMatch ? parseInt(tsMatch[1]) : null;

      // Only include upcoming matches (future or very recent)
      if (timestamp && timestamp < Date.now() / 1000 - 3600) continue;

      // Extract tournament from match-info-tournament
      const tournRe = /class="match-info-tournament"[^]*?title="([^"]+)"/;
      const tournMatch = block.match(tournRe);
      let tournament = '';
      if (tournMatch) {
        const parts = tournMatch[1].replace(/_/g, ' ').split('/');
        // e.g. "DreamLeague/28/Group Stage 1#February 16-B" -> "DreamLeague Season 28 - Group Stage"
        const name = parts[0].trim();
        const season = parts[1] ? parts[1].trim() : '';
        const stage = parts[2] ? parts[2].split('#')[0].trim() : '';
        tournament = season ? `${name} Season ${season}` : name;
        if (stage) tournament += ` - ${stage}`;
      }

      // Extract best-of
      const boMatch = block.match(/\(Bo(\d)\)/i);
      const bestOf = boMatch ? `BO${boMatch[1]}` : '';

      // Determine opponent and logos
      const ourNames = [TEAMS[ourKey].name.toLowerCase(), TEAMS[ourKey].tag.toLowerCase()];
      const opponent = teamNames.find(t =>
        !ourNames.some(n => t.toLowerCase().includes(n))
      ) || teamNames[1] || 'TBD';

      // Find our team's Liquipedia logo
      const ourTeamName = teamNames.find(t =>
        ourNames.some(n => t.toLowerCase().includes(n))
      );
      const ourLogo = ourTeamName ? teamLogos[ourTeamName] : null;
      const oppLogo = teamLogos[opponent] || null;

      upcoming.push({
        teamKey: ourKey, teamTag: TEAMS[ourKey].tag,
        opponent, tournament, bestOf,
        ourLogo, oppLogo,
        timestamp, dateStr: timestamp ? new Date(timestamp * 1000).toISOString() : null
      });
    }

    // Sort by timestamp
    upcoming.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    console.log(`[${new Date().toLocaleTimeString()}] Liquipedia: ${upcoming.length} upcoming matches`);
  } catch (err) {
    console.log(`[${new Date().toLocaleTimeString()}] Liquipedia failed: ${err.message}`);
  }
  return upcoming;
}

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------
async function refreshAllData() {
  if (isRefreshing) return;
  isRefreshing = true;
  console.log(`[${new Date().toLocaleTimeString()}] Refreshing all data...`);

  try {
    const teamKeys = Object.keys(TEAMS);

    const teamPromises = teamKeys.map(async key => {
      const id = TEAMS[key].id;
      const [info, matches, players, heroes] = await Promise.all([
        fetchWithRetry(`/teams/${id}`),
        fetchWithRetry(`/teams/${id}/matches`),
        fetchWithRetry(`/teams/${id}/players`),
        fetchWithRetry(`/teams/${id}/heroes`)
      ]);
      return { key, info: info || {}, matches: (matches || []).slice(0, 50), players: players || [], heroes: heroes || [] };
    });

    const [heroStats, live, proPlayers, ...teamResults] = await Promise.all([
      fetchWithRetry('/heroStats'),
      fetchWithRetry('/live').catch(() => []),
      fetchWithRetry('/proPlayers').catch(() => []),
      ...teamPromises
    ]);

    // Build hero lookup
    const heroMap = {};
    (heroStats || []).forEach(h => { heroMap[h.id] = h; });

    // Build real 5-man rosters from most recent match details
    const rosters = await buildCurrentRosters(teamResults, proPlayers);

    // Store team data
    const teams = {};
    teamResults.forEach(t => {
      teams[t.key] = { ...t, roster: rosters[t.key] || [] };
    });

    // Filter live matches
    const ourIds = new Set(teamKeys.map(k => TEAMS[k].id));
    const liveMatches = (live || []).filter(m =>
      ourIds.has(m.radiant_team_id) || ourIds.has(m.dire_team_id)
    );

    // Fetch upcoming (best effort)
    const upcoming = await fetchUpcoming().catch(() => []);

    cachedData = {
      teams, heroMap, liveMatches, upcoming,
      teamConfig: TEAMS,
      lastUpdated: new Date().toISOString()
    };

    console.log(`[${new Date().toLocaleTimeString()}] Data refreshed successfully`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Refresh failed:`, err.message);
  } finally {
    isRefreshing = false;
  }
}

async function refreshLiveOnly() {
  try {
    const live = await fetchWithRetry('/live').catch(() => []);
    const ourIds = new Set(Object.keys(TEAMS).map(k => TEAMS[k].id));
    const liveMatches = (live || []).filter(m =>
      ourIds.has(m.radiant_team_id) || ourIds.has(m.dire_team_id)
    );
    if (cachedData) {
      cachedData.liveMatches = liveMatches;
      cachedData.liveUpdated = new Date().toISOString();
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Player heroes (lazy, cached 30 min)
// ---------------------------------------------------------------------------
async function getPlayerHeroes(accountId) {
  const cached = playerHeroCache[accountId];
  if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) return cached.data;
  // game_mode=2 = Captain's Mode (competitive/tournament games only)
  const data = await fetchWithRetry(`/players/${accountId}/heroes?game_mode=2`);
  const heroes = (data || []).filter(h => h.games > 0).slice(0, 10).map(h => ({
    hero_id: h.hero_id,
    games: h.games || 0,
    win: h.win || 0,
  }));
  playerHeroCache[accountId] = { data: heroes, timestamp: Date.now() };
  return heroes;
}

// ---------------------------------------------------------------------------
// Image proxy cache (Liquipedia blocks hotlinking)
// ---------------------------------------------------------------------------
const imgCache = {}; // url -> { data: Buffer, contentType, timestamp }

function proxyImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const cached = imgCache[imageUrl];
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      return resolve(cached);
    }
    https.get(imageUrl, {
      headers: { 'User-Agent': 'Dota2PersonalTracker/1.0', 'Accept': 'image/*', 'Accept-Encoding': 'gzip' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return proxyImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/png';
        const result = { data, contentType, timestamp: Date.now() };
        imgCache[imageUrl] = result;
        resolve(result);
      });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // API: cached data
  if (url === '/api/data') {
    res.writeHead(cachedData ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cachedData || { error: 'Data is loading...' }));
    return;
  }

  // API: player heroes
  const playerMatch = url.match(/^\/api\/player\/(\d+)\/heroes$/);
  if (playerMatch) {
    try {
      const heroes = await getPlayerHeroes(parseInt(playerMatch[1]));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(heroes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: image proxy (for Liquipedia logos that block hotlinking)
  if (url === '/api/img') {
    const imgUrl = req.url.split('?url=')[1];
    if (!imgUrl || !decodeURIComponent(imgUrl).startsWith('https://liquipedia.net/')) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    try {
      const img = await proxyImage(decodeURIComponent(imgUrl));
      res.writeHead(200, { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(img.data);
    } catch (err) {
      res.writeHead(502); res.end('Image fetch failed');
    }
    return;
  }

  // API: force refresh
  if (url === '/api/refresh') {
    refreshAllData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'refresh started' }));
    return;
  }

  // Static files
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       DOTA 2 TRACKER SERVER          ║');
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Tracking: ${Object.values(TEAMS).map(t => t.tag).join(', ')}`);
  console.log(`  Full refresh: every ${REFRESH_INTERVAL / 60000} min`);
  console.log(`  Live refresh: every ${LIVE_REFRESH_INTERVAL / 1000}s`);
  console.log('');

  refreshAllData();
  setInterval(refreshAllData, REFRESH_INTERVAL);
  setInterval(refreshLiveOnly, LIVE_REFRESH_INTERVAL);
});
