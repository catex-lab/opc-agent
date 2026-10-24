(function () {
  var cfg = window.OPC_CONFIG || {};
  var I18N = window.OPC_I18N || { zh: {}, en: {} };
  var repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repo || '') ? cfg.repo : '';
  var apiBase = (cfg.apiBase || '').replace(/\/$/, '');
  var ghBase = 'https://github.com/' + repo;
  var LANG_KEY = 'opc-lang';

  // ══ 语言 ══════════════════════════════════════════════════════
  // 优先级：?lang= 显式指定 > 上次选择 > 浏览器语言
  // 默认回落到中文（这是中文优先的项目，英文用户多半会点 EN）
  function detectLang() {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'zh' || q === 'en') return q;
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) { /* 隐私模式 */ }
    if (saved === 'zh' || saved === 'en') return saved;
    var nav = (navigator.language || 'zh').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var lang = detectLang();
  var lastReleaseData = null;

  function applyLang(next, persist) {
    lang = next;
    var dict = I18N[next] || {};

    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n')];
      if (typeof v === 'string') el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) {
      var v = dict[el.getAttribute('data-i18n-alt')];
      if (typeof v === 'string') el.setAttribute('alt', v);
    });

    if (dict['meta.title']) document.title = dict['meta.title'];
    var md = document.querySelector('meta[name="description"]');
    if (md && dict['meta.description']) md.setAttribute('content', dict['meta.description']);

    document.querySelectorAll('.lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === next));
    });

    document.querySelectorAll('[data-link-pending]').forEach(function (el) {
      var key = el.getAttribute('data-link-pending');
      var title = dict[key] || '';
      if (title) el.setAttribute('title', title);
    });

    if (persist) {
      try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* 忽略 */ }
    }

    // 已拉到的版本数据要按新语言重绘（空状态文案在字典里）
    if (lastReleaseData !== null) renderRelease(lastReleaseData);
  }

  document.querySelectorAll('.lang button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = btn.getAttribute('data-lang');
      if (next && next !== lang) applyLang(next, true);
    });
  });

  // ══ 链接注入 ══════════════════════════════════════════════════
  var linkMap = {
    '[data-github]': repo ? 'https://github.com/' + repo : '',
    '[data-releases]': repo ? 'https://github.com/' + repo + '/releases' : '',
    '[data-issues]': repo ? 'https://github.com/' + repo + '/issues' : '',
  };
  Object.keys(linkMap).forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      if (linkMap[sel]) {
        el.setAttribute('href', linkMap[sel]);
        el.removeAttribute('aria-disabled');
        el.removeAttribute('tabindex');
        el.classList.remove('is-unavailable');
      } else {
        el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
        el.classList.add('is-unavailable');
        el.setAttribute('data-link-pending', 'link.pending');
      }
    });
  });

  // 下载地址：配了 Worker 就走统计中转，否则直连 GitHub
  function downloadUrl() {
    if (!repo) return '';
    if (apiBase) return apiBase + (cfg.downloadPath || '/d/win-x64') + '?ch=web';
    return 'https://github.com/' + repo + '/releases/latest';
  }
  document.querySelectorAll('[data-download]').forEach(function (el) {
    var url = downloadUrl();
    if (url) {
      el.setAttribute('href', url);
      el.removeAttribute('aria-disabled');
      el.removeAttribute('tabindex');
      el.classList.remove('is-unavailable');
    } else {
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('tabindex', '-1');
      el.classList.add('is-unavailable');
      el.setAttribute('data-link-pending', 'link.downloadPending');
    }
  });

  // ══ 工具 ══════════════════════════════════════════════════════
  function fmtSize(bytes) {
    if (!bytes || bytes < 1024) return '';
    var mb = bytes / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fetchJson(url, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || 6000);
    return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  // ══ 版本信息：Worker 代理 → GitHub API → 静态兜底 ══════════════
  function normalizeFromGitHub(list) {
    if (!Array.isArray(list) || !list.length) return null;
    var top = list[0];
    var exe = (top.assets || []).filter(function (a) { return /\.exe$/i.test(a.name); });
    var setup = exe.filter(function (a) { return /setup/i.test(a.name); })[0] || exe[0];
    return {
      latest: {
        version: (top.tag_name || '').replace(/^v/, ''),
        publishedAt: top.published_at,
        sizeBytes: setup ? setup.size : 0,
      },
      releases: list.map(function (r) {
        return { tag: r.tag_name || '', name: r.name || r.tag_name || '', publishedAt: r.published_at };
      }),
    };
  }

  function loadReleaseInfo() {
    var cached = null;
    try { cached = sessionStorage.getItem('opc-release-cache'); } catch (e) { /* 忽略 */ }
    if (cached) {
      try {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.__ts && Date.now() - parsed.__ts < 600000) {
          return Promise.resolve(parsed.data);
        }
      } catch (e) { /* 缓存坏了就重新拉 */ }
    }

    if (!repo) return Promise.resolve(null);

    var viaWorker = apiBase
      ? fetchJson(apiBase + '/api/v1/release', 6000)
      : Promise.reject(new Error('no worker'));

    return viaWorker
      .catch(function () {
        return fetchJson('https://api.github.com/repos/' + repo + '/releases?per_page=5', 6000)
          .then(normalizeFromGitHub);
      })
      .then(function (data) {
        if (!data) return null;
        try {
          sessionStorage.setItem('opc-release-cache', JSON.stringify({ __ts: Date.now(), data: data }));
        } catch (e) { /* 隐私模式下可能失败 */ }
        return data;
      })
      .catch(function () { return null; });
  }

  function renderRelease(data) {
    lastReleaseData = data;
    var dict = I18N[lang] || {};
    var fb = cfg.fallback || {};
    var latest = (data && data.latest) || {};
    var version = latest.version || (repo ? fb.version : '') || '';
    var sizeText = fmtSize(latest.sizeBytes) || fb.sizeText || '';

    var num = document.getElementById('meta-ver-num');
    if (num && version) num.textContent = ' v' + version;

    var size = document.getElementById('meta-size');
    if (size) size.textContent = sizeText;

    var box = document.getElementById('releases');
    if (!box) return;

    var list = (data && data.releases) || [];
    if (!list.length) {
      var key = repo ? 'changelog.empty' : 'changelog.pending';
      box.innerHTML = '<div class="empty">' + esc(dict[key] || '') + '</div>';
      return;
    }

    box.innerHTML = list.map(function (r) {
      var tag = r.tag ? (r.tag.charAt(0) === 'v' ? r.tag : 'v' + r.tag) : '';
      var name = (r.name || '').replace(/^v?[\d.]+\s*[-–—]?\s*/, '') || '';
      return '<div class="release">' +
        '<span class="release-tag">' + esc(tag) + '</span>' +
        '<span class="release-date">' + esc(fmtDate(r.publishedAt)) + '</span>' +
        '<span class="release-name">' + esc(name) + '</span>' +
        '</div>';
    }).join('');
  }

  // ══ 滚动入场 ══════════════════════════════════════════════════
  function initReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        // 同一组内错开一点，避免整块同时亮起
        var siblings = Array.prototype.slice.call(el.parentElement ? el.parentElement.children : []);
        var idx = Math.max(0, siblings.indexOf(el));
        el.style.transitionDelay = Math.min(idx * 60, 240) + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  // ══ 启动 ══════════════════════════════════════════════════════
  applyLang(lang, false);
  initReveal();
  // 告诉 index.html 里的看门狗：入场动画已经接管，别把内容放出来
  window.__opcRevealReady = true;

  loadReleaseInfo().then(function (data) {
    renderRelease(data);
    if (!data && apiBase && repo) {
      document.querySelectorAll('[data-download]').forEach(function (el) {
        el.setAttribute('href', 'https://github.com/' + repo + '/releases/latest');
      });
    }
  });
})();
