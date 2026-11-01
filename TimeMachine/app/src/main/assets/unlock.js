'use strict';

/*
  Remove telas/avisos de login das capturas do Wayback Machine.
  Só age dentro do quadro do visualizador da extensão; páginas abertas
  diretamente no Wayback não são alteradas.
*/
(() => {
  const HOST = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
    ? 'chrome-extension://' + chrome.runtime.id : 'https://appassets.androidplatform.net';
  try {
    if (window === window.top) return;
    const anc = location.ancestorOrigins;
    if (!anc || anc.length !== 1 || anc[0] !== HOST) return;
  } catch { return; }

  const WORDS = new RegExp([
    'log\\s?in', 'sign\\s?in', 'sign\\s?up', 'log\\s?on', 'create (an |your )?account', 'join (now|us|for free)',
    'continue (with|using)', 'don.t miss', 'to see more', 'see more on',
    'entrar', 'entre (na|no|com|para)', 'fa[cç]a (o )?login', 'fazer login', 'iniciar sess', 'inicie sess',
    'cadastr', 'criar (uma )?conta', 'crie (sua|uma) conta', 'continuar com', 'continue com', 'inscreva-se',
    'iniciar sesi', 'inicia sesi', 'crear (una )?cuenta', 'reg[ií]strate',
    '18\\s?\\+', '(maior|mais) de 18', '18 anos', 'over 18', '18 or older', '18 years', 'adults? only', 'adult content', 'age verif', 'age confirm',
    'conte[úu]do adulto', 'verifica[cç][aã]o de idade', 'sou maior', 'eu tenho 18', 'i am (over )?18', 'i.m (over )?18', 'enter (the )?site', 'enter here', 'i agree', 'concordo', 'mayor de 18', 'contenido para adultos',
    'se connecter', 'connexion', 'cr[ée]er un compte', 'anmelden', 'registrieren', 'accedi', 'iscriviti'
  ].join('|'), 'i');

  const HINT = /(modal|overlay|popup|pop-up|disclaimer|age[-_ ]?(gate|check|verif|warning|confirm)|agegate|adult|interstitial|lightbox|dialog|login|signin|signup|register|auth|consent|splash|welcome)/i;
  const hintOf = (el) => {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    return HINT.test(el.id + ' ' + c + ' ' + (el.getAttribute('aria-label') || ''));
  };

  // Regra especial para erome.com (endereço original está no caminho do Wayback)
  const EROME = /^\/web\/\d+[a-z_]*\/https?:\/{1,2}([a-z0-9-]+\.)?erome\.com(\/|:|$)/i.test(decodeURIComponent(location.pathname));
  const EROME_CSS = [
    '.modal', '.modal-backdrop', '.modal-overlay', '.modal-dialog',
    '[class*="modal" i]:not(body):not(html)', '[id*="modal" i]:not(body):not(html)',
    '[id*="disclaimer" i]', '[class*="disclaimer" i]',
    '[id*="age-" i]:not(body):not(html)', '[class*="age-gate" i]', '[class*="agegate" i]', '[class*="age-verif" i]',
    'a[href*="/login" i]', 'a[href*="/register" i]', 'a[href*="/signup" i]', 'a[href*="/auth/" i]',
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog'
  ].join(',\n') + ' { display: none !important; visibility: hidden !important; }\n' +
    'html, body { overflow: auto !important; overflow-y: auto !important; position: static !important; filter: none !important; }\n' +
    'body.modal-open, body.no-scroll, body.noscroll, body.overflow-hidden { overflow: auto !important; padding-right: 0 !important; }';

  let redirected = false;
  const done = new WeakSet();
  let removedAny = false;
  let scrollUnlocked = false;

  function addCss(text) {
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(text);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    } catch {
      const st = document.createElement('style');
      st.textContent = text;
      (document.head || document.documentElement).append(st);
    }
  }

  function kill(el) {
    if (done.has(el)) return;
    done.add(el);
    el.setAttribute('data-tm-hide', '1');
    el.style.setProperty('display', 'none', 'important');
    el.setAttribute('aria-hidden', 'true');
    removedAny = true;
  }

  const hasLoginText = (el) => {
    if (el.querySelector('input[type="password"]')) return true;
    const t = (el.textContent || '').slice(0, 2500);
    return WORDS.test(t);
  };

  function isLoginLayer(el, cs, vw, vh) {
    const pos = cs.position;
    const role = el.getAttribute('role');
    const dialog = el.tagName === 'DIALOG' || role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
    if (!dialog && pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') return false;

    const z = parseInt(cs.zIndex, 10);
    const hint = hintOf(el);
    if (!dialog && pos === 'absolute' && !(z >= 100) && !hint) return false;

    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 30) return false;
    const cover = (r.width * r.height) / (vw * vh);
    const wide = r.width >= vw * 0.9;
    const center = Math.abs(r.left + r.width / 2 - vw / 2) < vw * 0.2;

    // erome.com: qualquer camada flutuante grande, sem exigir texto, é tela de confirmação/login
    if (EROME && (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') && cover >= 0.2 && (z >= 10 || hint || pos === 'fixed')
        && el.tagName !== 'HEADER' && el.tagName !== 'NAV' && !el.querySelector('video, canvas, main, article')
        && el.querySelectorAll('*').length <= 900) return true;

    const wall = cover >= 0.4;                                     // tela cheia
    const modal = dialog || (cover >= 0.08 && center && (z >= 10 || pos === 'fixed'));
    const bottomBar = wide && r.top >= vh * 0.45 && r.height <= vh * 0.45 && (pos === 'fixed' || pos === 'sticky');
    if (!(wall || modal || bottomBar)) return false;

    // não derrubar o app inteiro nem o conteúdo principal
    const max = dialog ? 1500 : 700;
    if (el.querySelectorAll('*').length > max) return false;
    if (!dialog && el.querySelector('main, article, video, canvas')) return false;
    if (el.tagName === 'HEADER' || el.tagName === 'NAV' || role === 'banner' || role === 'navigation') return false;

    if (hasLoginText(el)) return true;
    return hint && (wall || modal);
  }

  function isBackdrop(el, cs, vw, vh) {
    if (cs.position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.9 || r.height < vh * 0.9) return false;
    if ((el.textContent || '').trim().length > 2) return false;
    if (el.querySelector('img, video, canvas, svg, iframe')) return false;
    const bg = cs.backgroundColor;
    return !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  }

  function sweep() {
    const body = document.body;
    if (!body) return;
    if (EROME) {
      for (const c of ['modal-open', 'no-scroll', 'noscroll', 'overflow-hidden', 'locked', 'is-locked']) body.classList.remove(c);
      document.documentElement.classList.remove('modal-open', 'no-scroll', 'noscroll', 'overflow-hidden');
    }
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vw || !vh) return;

    if (EROME) { eromeHomeHelper(); peel(); }

    const all = body.querySelectorAll('*');
    const found = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (done.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (isLoginLayer(el, cs, vw, vh)) found.push(el);
    }
    // só o elemento mais externo de cada grupo
    for (const el of found) {
      if (!found.some((o) => o !== el && o.contains(el))) kill(el);
    }

    if (removedAny) {
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (done.has(el)) continue;
        const cs = getComputedStyle(el);
        if (isBackdrop(el, cs, vw, vh)) { kill(el); continue; }
        if (cs.filter && cs.filter.includes('blur')) {
          const r = el.getBoundingClientRect();
          if (r.width * r.height >= vw * vh * 0.3) {
            el.style.setProperty('filter', 'none', 'important');
            el.style.setProperty('pointer-events', 'auto', 'important');
            el.style.setProperty('user-select', 'auto', 'important');
          }
        }
      }
      if (!scrollUnlocked) { scrollUnlocked = true; addCss('html, body { overflow: auto !important; overflow-y: auto !important; }'); }
    }
  }


  // Descobre o que está realmente por cima da tela (sem depender de nome de classe) e esconde a camada flutuante.
  function floatingLayer(el, vw, vh) {
    let best = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
      if (n.tagName === 'HEADER' || n.tagName === 'NAV') continue;
      const z = parseInt(cs.zIndex, 10);
      if (pos === 'absolute' && !(z >= 10) && !hintOf(n)) continue;
      const r = n.getBoundingClientRect();
      if ((r.width * r.height) / (vw * vh) < 0.2) continue;
      if (n.querySelector('video, canvas, main, article')) continue;
      if (n.querySelectorAll('*').length > 900) continue;
      best = n;             // continua subindo para pegar a camada mais externa
    }
    return best;
  }

  const ENTER = /(18 or older|i am 18|i.m 18|i am over|enter|entrar|sou maior|tenho 18|concordo|i agree|continue|continuar|accept|aceitar|yes|sim)/i;
  const EXIT = /(exit|sair|leave|no\b|n[aã]o)/i;
  function tryEnter(layer) {
    try {
      for (const b of layer.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')) {
        const t = ((b.textContent || '') + ' ' + (b.value || '')).trim();
        if (!t || t.length > 60 || EXIT.test(t) || !ENTER.test(t)) continue;
        const href = b.getAttribute && b.getAttribute('href');
        if (href && /^https?:/i.test(href) && !/erome\.com/i.test(href) && !/web\.archive\.org/i.test(href)) continue;
        b.click();
        return true;
      }
    } catch { /* ignora */ }
    return false;
  }


  // erome.com: se a captura de uma página interna terminou na página inicial (tela de login),
  // avisa o app, que tenta de novo sem JavaScript.
  function eromeHomeHelper() {
    if (!EROME || redirected || !document.getElementById('home-box')) return;
    if (!/^\/web\/\d+[a-z_]*\/https?:\/{1,2}([a-z0-9-]+\.)?erome\.com\/?$/i.test(decodeURIComponent(location.pathname))) return;
    redirected = true;                  // avisa o app uma única vez: esta captura caiu na página inicial
    try { parent.postMessage({ tmHome: true }, HOST); } catch { /* ignora */ }
  }

  function peel() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh || !document.elementsFromPoint) return;
    const pts = [[.5, .5], [.5, .3], [.5, .7], [.25, .5], [.75, .5], [.5, .12], [.5, .88], [.15, .3], [.85, .7]];
    for (let round = 0; round < 10; round++) {
      let hit = false;
      for (const [fx, fy] of pts) {
        const top = document.elementsFromPoint(vw * fx, vh * fy)[0];
        if (!top || top === document.body || top === document.documentElement) continue;
        const layer = floatingLayer(top, vw, vh);
        if (layer && !done.has(layer)) { tryEnter(layer); kill(layer); hit = true; }
      }
      if (!hit) break;
    }
  }

  function describe(el) {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c.trim().split(/\s+/).slice(0, 4).join('.') : '');
  }

  function diag() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const layers = [];
    let shadow = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) shadow++;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      const cover = (r.width * r.height) / (vw * vh);
      if (cover < 0.05) continue;
      layers.push({ el: describe(el), pos: cs.position, z: cs.zIndex, cover: +cover.toFixed(2), display: cs.display, hiddenByTM: el.hasAttribute('data-tm-hide'), nodes: el.querySelectorAll('*').length, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
    }
    layers.sort((a, b) => b.cover - a.cover);
    const at = [[.5, .5], [.5, .25], [.5, .8]].map(([fx, fy]) =>
      document.elementsFromPoint(vw * fx, vh * fy).slice(0, 4).map(describe));
    return {
      url: location.pathname.slice(0, 120), erome: EROME, viewport: [vw, vh],
      htmlClass: document.documentElement.className, bodyClass: document.body && document.body.className,
      bodyOverflow: document.body && getComputedStyle(document.body).overflow,
      iframes: document.querySelectorAll('iframe').length, shadowHosts: shadow,
      layers: layers.slice(0, 20), topAtPoints: at,
      bodyText: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    };
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== HOST || !e.data || !e.data.tmDiag) return;
    let data;
    try { data = diag(); } catch (err) { data = { error: String(err) }; }
    parent.postMessage({ tmDiagResult: data }, e.origin);
  });

  let timer = 0, last = 0;
  function schedule() {
    if (timer) return;
    const wait = Math.max(150, 700 - (Date.now() - last));
    timer = setTimeout(() => { timer = 0; last = Date.now(); try { sweep(); } catch { /* ignora */ } }, wait);
  }

  function start() {
    addCss('[data-tm-hide] { display: none !important; }');
    if (EROME) { addCss(EROME_CSS); removedAny = true; scrollUnlocked = true; }
    schedule();
    if (EROME) for (const t of [300, 800, 1500, 3000, 5000, 9000, 15000]) setTimeout(schedule, t);
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open']
    });
    window.addEventListener('load', () => { schedule(); setTimeout(schedule, 2500); setTimeout(schedule, 6000); });
    window.addEventListener('scroll', schedule, { passive: true });
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();
