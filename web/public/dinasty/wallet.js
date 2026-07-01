// WorldColony — Phantom wallet module
// Exposes DN.wallet with a stable public contract. Other modules (HUD,
// colony spawn flow, on-chain hooks) depend on:
//   DN.wallet.installed, .connected, .pubkey
//   DN.wallet.connect(), .disconnect()
//   DN.wallet.shortAddress(), .accentColor()
//   DN.wallet.onChange(cb)
window.DN = window.DN || {};

DN.wallet = (function () {
  const W = {
    installed: false,
    connected: false,
    pubkey: null,
  };

  const DEFAULT_COLOR = 0xB07E1C; // matches --gold theme accent
  const listeners = [];
  let provider = null;
  let connecting = false;

  function detectProvider() {
    if (typeof window === 'undefined') return null;
    const phantomSol = window.phantom && window.phantom.solana;
    if (phantomSol) return phantomSol;
    if (window.solana && window.solana.isPhantom) return window.solana;
    return null;
  }

  function emit() {
    const snap = { installed: W.installed, connected: W.connected, pubkey: W.pubkey };
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](snap); } catch (err) { /* swallow listener errors */ }
    }
  }

  function setState(connected, pubkey) {
    const changed = (W.connected !== connected) || (W.pubkey !== pubkey);
    W.connected = !!connected;
    W.pubkey = pubkey || null;
    if (changed) emit();
  }

  function pubkeyToString(pk) {
    if (!pk) return null;
    if (typeof pk === 'string') return pk;
    if (typeof pk.toBase58 === 'function') {
      try { return pk.toBase58(); } catch (e) { /* fallthrough */ }
    }
    if (typeof pk.toString === 'function') return pk.toString();
    return null;
  }

  function attachProviderEvents(p) {
    if (!p || typeof p.on !== 'function') return;
    p.on('connect', (pk) => {
      setState(true, pubkeyToString(pk || p.publicKey));
    });
    p.on('disconnect', () => {
      setState(false, null);
    });
    p.on('accountChanged', (pk) => {
      const addr = pubkeyToString(pk);
      if (addr) setState(true, addr);
      else setState(false, null);
    });
  }

  // FNV-1a 32-bit hash of a string, used to derive a stable hue.
  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // HSL -> RGB (h, s, l in [0,1])
  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return ((Math.round(r * 255) & 0xff) << 16) |
           ((Math.round(g * 255) & 0xff) <<  8) |
            (Math.round(b * 255) & 0xff);
  }

  W.shortAddress = function () {
    if (!W.pubkey) return '';
    const s = String(W.pubkey);
    if (s.length <= 9) return s;
    return s.slice(0, 4) + '…' + s.slice(-4);
  };

  W.accentColor = function () {
    if (!W.pubkey) return DEFAULT_COLOR;
    const h = hashStr(W.pubkey);
    const hue = ((h & 0xffff) / 0xffff);            // 0..1
    const sat = 0.55 + (((h >>> 16) & 0xff) / 255) * 0.25;  // 0.55..0.80
    const lig = 0.46 + (((h >>> 24) & 0xff) / 255) * 0.12;  // 0.46..0.58
    return hslToRgb(hue, sat, lig);
  };

  W.onChange = function (cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    };
  };

  W.connect = async function () {
    if (!provider) {
      throw new Error('Phantom wallet not detected');
    }
    if (connecting) return;
    connecting = true;
    try {
      const res = await provider.connect();
      const pk = pubkeyToString((res && res.publicKey) || provider.publicKey);
      setState(true, pk);
    } finally {
      connecting = false;
    }
  };

  W.disconnect = async function () {
    if (!provider) {
      setState(false, null);
      return;
    }
    try {
      if (typeof provider.disconnect === 'function') await provider.disconnect();
    } finally {
      setState(false, null);
    }
  };

  function init() {
    provider = detectProvider();
    W.installed = !!provider;
    if (!provider) {
      // Re-probe a moment later: Phantom occasionally injects after load.
      setTimeout(() => {
        if (W.installed) return;
        provider = detectProvider();
        if (provider) {
          W.installed = true;
          attachProviderEvents(provider);
          if (provider.isConnected && provider.publicKey) {
            setState(true, pubkeyToString(provider.publicKey));
          } else {
            emit();
          }
        }
      }, 750);
      return;
    }
    attachProviderEvents(provider);
    // Trusted reconnect: if Phantom previously authorized this site, restore silently.
    if (typeof provider.connect === 'function') {
      provider.connect({ onlyIfTrusted: true })
        .then((res) => {
          const pk = pubkeyToString((res && res.publicKey) || provider.publicKey);
          if (pk) setState(true, pk);
        })
        .catch(() => { /* not trusted yet — ignore */ });
    }
    if (provider.isConnected && provider.publicKey && !W.connected) {
      setState(true, pubkeyToString(provider.publicKey));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return W;
})();
