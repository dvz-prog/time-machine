'use strict';

/*
  Faz o app.js (escrito para extensão do Chrome) rodar dentro do aplicativo Android.
  Simula só o que o app usa: chrome.storage.local, chrome.downloads, chrome.permissions,
  chrome.tabs.captureVisibleTab e chrome.extension.inIncognitoContext.
*/
(() => {
  const bridge = window.AndroidBridge;          // criado pelo Android (só nesta página)
  const pending = new Map();
  let seq = 0;

  if (bridge) {
    bridge.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.res(m); else p.rej(new Error(m.error || 'Falha na operação.'));
      } catch { /* ignora */ }
    };
  }

  function call(op, payload = {}) {
    return new Promise((res, rej) => {
      if (!bridge) { rej(new Error('Recurso indisponível: atualize o Android System WebView.')); return; }
      const id = ++seq;
      pending.set(id, { res, rej });
      bridge.postMessage(JSON.stringify({ id, op, ...payload }));
      setTimeout(() => { if (pending.delete(id)) rej(new Error('Tempo esgotado.')); }, 90000);
    });
  }

  const KEY = (k) => 'tm:' + k;
  const storage = {
    async get(keys) {
      const out = {};
      let list;
      if (keys == null) list = Object.keys(localStorage).filter((k) => k.startsWith('tm:')).map((k) => k.slice(3));
      else if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys;
      else list = Object.keys(keys);
      for (const k of list) {
        let raw = null;
        try { raw = localStorage.getItem(KEY(k)); } catch { /* ignora */ }
        if (raw !== null) { try { out[k] = JSON.parse(raw); } catch { /* ignora */ } }
        else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) localStorage.setItem(KEY(k), JSON.stringify(v));
    }
  };

  window.chrome = {
    extension: { inIncognitoContext: false },
    runtime: {},
    storage: { local: storage, onChanged: { addListener() {} } },
    permissions: { request: async () => true },
    tabs: {
      captureVisibleTab: async () => (await call('capture')).data
    },
    downloads: {
      download: async ({ url, filename }) => { await call('download', { url, name: filename }); }
    }
  };

  // Downloads de arquivos gerados no app (blob:) -> pasta Downloads do celular
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && /^blob:/i.test(this.href)) {
      const name = this.download;
      fetch(this.href)
        .then((r) => r.blob())
        .then((b) => new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res({ b, s: String(fr.result) });
          fr.onerror = () => rej(new Error('Não foi possível ler o arquivo.'));
          fr.readAsDataURL(b);
        }))
        .then(({ b, s }) => call('saveBase64', { name, mime: b.type || 'application/octet-stream', data: s.slice(s.indexOf(',') + 1) }))
        .catch((e) => alert('Não foi possível salvar: ' + (e && e.message ? e.message : e)));
      return;
    }
    return origClick.call(this);
  };
})();
