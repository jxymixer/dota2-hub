# Dota 2 Team Tracker

A local web dashboard for tracking Dota 2 teams — **Xtreme Gaming (XG)**, **Yakult Brothers (YB)**, and **Vici Gaming (VG)**.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Dependencies](https://img.shields.io/badge/dependencies-zero-blue)

## Features

- **Upcoming Matches** — Scraped from Liquipedia with team logos, BO format, and countdown timers
- **Match History** — Grouped by series (BO1/BO3/BO5) within leagues, expandable to see individual game details
- **Current Rosters** — 5-man active roster detected from most recent match data
- **Player Hero Stats** — Click any player to see their most played heroes in competitive (Captain's Mode) games
- **Live Matches** — Banner showing live game scores when any tracked team is playing
- **Auto-refresh** — Full data refresh every 5 minutes, live scores every 60 seconds

## Setup

**Prerequisites:** [Node.js](https://nodejs.org/) 18+

1. Clone the repo:
   ```bash
   git clone https://github.com/jxymixer/dota2-hub.git
   cd dota2-hub
   ```

2. Create a `.env` file with your [OpenDota API key](https://www.opendota.com/api-keys):
   ```
   OPENDOTA_API_KEY=your-api-key-here
   ```
   > The app works without an API key, but you'll hit rate limits faster.

3. Start the server:
   ```bash
   node server.js
   ```

4. Open http://localhost:3000 in your browser.

## Data Sources

- **[OpenDota API](https://docs.opendota.com/)** — Team stats, match history, player data, hero stats, live games
- **[Liquipedia](https://liquipedia.net/dota2/)** — Upcoming match schedules and team logos

## Tech Stack

Zero external dependencies — built entirely on Node.js built-in modules (`http`, `https`, `fs`, `path`, `zlib`).

| File | Description |
|------|-------------|
| `server.js` | Backend server — API proxy, data caching, Liquipedia scraper, image proxy |
| `app.js` | Frontend logic — rendering, series grouping, navigation, polling |
| `styles.css` | Dark esports theme with Dota 2 styling |
| `index.html` | Minimal HTML shell |
