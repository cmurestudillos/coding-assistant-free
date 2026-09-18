/* ============================================================
   Coding Assistant Free — SPA (router hash, tema, galería y descargas)
   Sin dependencias externas. Misma base que la landing de Test Runner.
   ============================================================ */
(() => {
  'use strict';

  const REPO = 'cmurestudillos/coding-assistant-free';
  const RELEASES_URL = `https://github.com/${REPO}/releases`;
  const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

  /* ---------- almacenamiento tolerante a fallos ---------- */
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* modo privado o cookies bloqueadas: se ignora */
      }
    },
  };

  /* ---------- tema claro / oscuro ---------- */
  const root = document.documentElement;
  const savedTheme = store.get('caf-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    root.setAttribute('data-theme', savedTheme);
  }

  document.getElementById('themeToggle').addEventListener('click', () => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = root.getAttribute('data-theme');
    const isDark = current === 'dark' || (current === 'auto' && prefersDark) || (!current && prefersDark);
    const next = isDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store.set('caf-theme', next);
  });

  /* ---------- menú móvil ---------- */
  const navToggle = document.getElementById('navToggle');
  const siteNav = document.getElementById('siteNav');

  navToggle.addEventListener('click', () => {
    const open = siteNav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });

  /* ---------- router por hash ---------- */
  // Hash y no History API: GitHub Pages no reescribe rutas (/descargas daría 404)
  const views = document.querySelectorAll('[data-route]');
  const navLinks = document.querySelectorAll('[data-route-link]');
  const routes = new Set([...views].map(v => v.dataset.route));

  const titles = {
    '/': 'Coding Assistant Free — Asistente de programación local y gratuito',
    '/caracteristicas': 'Características — Coding Assistant Free',
    '/capturas': 'Capturas — Coding Assistant Free',
    '/descargas': 'Descargas — Coding Assistant Free',
    '/documentacion': 'Documentación — Coding Assistant Free',
  };

  function currentRoute() {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    return routes.has(path) ? path : '/';
  }

  function render(scrollTop = true) {
    const route = currentRoute();

    views.forEach(view => view.classList.toggle('active', view.dataset.route === route));
    navLinks.forEach(link => {
      const isActive = link.dataset.routeLink === route;
      link.classList.toggle('active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    document.title = titles[route] || titles['/'];
    siteNav.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');

    if (scrollTop) {
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    }
  }

  window.addEventListener('hashchange', () => render());
  render(false);

  // Enlaces a una sección dentro de la vista actual: un href="#id" normal lo trataría
  // el router como una ruta y llevaría al inicio
  document.querySelectorAll('[data-scroll-to]').forEach(link => {
    link.addEventListener('click', e => {
      const target = document.getElementById(link.dataset.scrollTo);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /* ---------- lightbox de capturas ---------- */
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  let lastFocused = null;

  function openLightbox(src, caption, alt) {
    lastFocused = document.activeElement;
    lightboxImg.src = src;
    lightboxImg.alt = alt || caption;
    lightboxCaption.textContent = caption;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('lightboxClose').focus();
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = '';
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
  }

  document.querySelectorAll('.shot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const img = btn.querySelector('img');
      openLightbox(btn.dataset.full, btn.dataset.caption || '', img ? img.alt : '');
    });
  });

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
  });

  /* ---------- descargas ---------- */
  const OS_LABEL = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

  function detectOS() {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    const ua = `${platform} ${navigator.userAgent}`.toLowerCase();
    if (/mac|iphone|ipad/.test(ua)) return 'mac';
    if (/linux|android|cros/.test(ua)) return 'linux';
    if (/win/.test(ua)) return 'windows';
    return null;
  }

  // Sistema de cada instalador y preferencia cuando hay varios para el mismo sistema
  // (electron-builder publica, p. ej., .dmg y .zip para macOS). Se ignoran los ficheros
  // auxiliares de las actualizaciones (.blockmap, latest.yml)
  function assetOS(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.blockmap') || n.endsWith('.yml')) return null;
    if (n.endsWith('.exe')) return { os: 'windows', rank: 2 };
    if (n.endsWith('.msi')) return { os: 'windows', rank: 1 };
    if (n.endsWith('.dmg')) return { os: 'mac', rank: 2 };
    if (n.endsWith('.pkg') || n.endsWith('.zip')) return { os: 'mac', rank: 1 };
    if (n.endsWith('.appimage')) return { os: 'linux', rank: 3 };
    if (n.endsWith('.deb')) return { os: 'linux', rank: 2 };
    if (n.endsWith('.rpm')) return { os: 'linux', rank: 1 };
    return null;
  }

  const formatMB = bytes => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

  const heroDownload = document.getElementById('heroDownload');
  const os = detectOS();

  function highlightOS(links) {
    if (!os) return;
    const card = document.querySelector(`.download-card[data-os="${os}"]`);
    if (card) card.classList.add('recommended');

    const direct = links[os];
    heroDownload.textContent = `⬇ Descargar para ${OS_LABEL[os]}`;
    if (direct) {
      heroDownload.href = direct;
      heroDownload.setAttribute('download', '');
    }
  }

  // Todavía no hay ninguna versión publicada: se dice claramente en vez de enseñar
  // botones que llevarían a una página de releases vacía
  function showNoRelease() {
    document.getElementById('releaseNotice').hidden = false;
    document.getElementById('releaseTag').textContent = 'aún sin publicar';
    document.querySelectorAll('[data-dl]').forEach(btn => {
      btn.textContent = 'Próximamente';
      btn.setAttribute('aria-disabled', 'true');
      btn.removeAttribute('href');
    });
    document.querySelectorAll('[data-size]').forEach(size => {
      size.textContent = 'Instalador en preparación';
    });
    heroDownload.textContent = '⬇ Cómo instalarla';
    heroDownload.href = '#/descargas';
  }

  async function loadRelease() {
    // Enlaces por defecto: si la API de GitHub falla (sin red o límite de peticiones),
    // la página sigue llevando a la última versión publicada.
    const links = {};

    try {
      const res = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } });
      if (res.status === 404) {
        showNoRelease();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const tag = data.tag_name || '';
      document.getElementById('releaseTag').textContent = tag;
      if (tag) {
        // Sin espacio inicial: el eyebrow es flex y ya separa sus elementos
        document.getElementById('heroVersion').textContent = `· ${tag}`;
      }

      if (data.published_at) {
        const fecha = new Date(data.published_at).toLocaleDateString('es-ES', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        document.getElementById('releaseDate').textContent = ` · publicada el ${fecha}`;
      }

      const best = {};
      (data.assets || []).forEach(asset => {
        const target = assetOS(asset.name);
        if (target && (!best[target.os] || target.rank > best[target.os].rank)) {
          best[target.os] = { ...target, asset };
        }
      });

      Object.entries(best).forEach(([target, { asset }]) => {
        links[target] = asset.browser_download_url;

        const btn = document.querySelector(`[data-dl="${target}"]`);
        if (btn) {
          btn.href = asset.browser_download_url;
          btn.setAttribute('download', '');
          btn.title = asset.name;
        }
        const size = document.querySelector(`[data-size="${target}"]`);
        if (size) size.textContent = `${asset.name} · ${formatMB(asset.size)}`;
      });

      // Sistemas sin instalador en esta versión
      Object.keys(OS_LABEL).forEach(target => {
        if (best[target]) return;
        const btn = document.querySelector(`[data-dl="${target}"]`);
        if (btn) {
          btn.textContent = 'No disponible';
          btn.setAttribute('aria-disabled', 'true');
          btn.removeAttribute('href');
        }
        const size = document.querySelector(`[data-size="${target}"]`);
        if (size) size.textContent = 'Sin instalador en esta versión';
      });
    } catch {
      document.querySelectorAll('[data-dl]').forEach(btn => {
        btn.href = `${RELEASES_URL}/latest`;
      });
    }

    highlightOS(links);
  }

  loadRelease();
})();
