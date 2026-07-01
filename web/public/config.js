window.DN_CONFIG = window.DN_CONFIG || {
  API_URL: 'https://ethglobalnyc-production.up.railway.app',
  RUN: {
    agents: 200,
    rooms: 12,
    seed: 205,
    voice_mode: 'llm',
    agent_wallets: true,
    wallet_provider: 'dynamic',
    wallet_store: 'colony/data/agent-wallets.dynamic.200.public.json',
  },
  KG_RUN: {
    mode: 'fast',
    modules: ['fixture', 'public_x', 'polymarket_market_context', 'wikidata_profiles', 'txline_full'],
    timeout: 120,
    camel_agents: 4,
  },
  FORECAST: {
    CONTRACT: '0xc40a8f2e29fe061cd4c0fe92cc73b9b43f9ada87',
    HOME_TEAM: 'Brazil',
    AWAY_TEAM: 'Morocco',
  },

  // ---------------- Supabase (live world: colonies + queens) -----------
  // URL is the public project endpoint. Anon key is a public JWT — safe to
  // ship to the browser (RLS gates writes). Grab it from Supabase →
  // Project Settings → API → "anon public". Until you paste it the live
  // world stays offline and the client falls back to localStorage.
  SUPABASE_URL: '',
  // Supabase "publishable" key (new format replacing legacy anon JWT).
  // Public-safe to ship in the browser; RLS gates writes.
  SUPABASE_ANON_KEY: '',
};
