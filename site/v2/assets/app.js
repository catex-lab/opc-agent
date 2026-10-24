/* OPC Agent 官网 v2 交互脚本
   1. 入场动画 / 导航滚动态
   2. 下载与 GitHub 链接装配（仓库地址来自 config.js）
   3. 版本信息与更新日志（GitHub API，失败静默降级）
   4. Hero 演示窗口：群聊消息自动播放（随语言切换重播） */
(function () {
  'use strict';

  var CFG = window.OPC_SITE || {};
  var I18N = window.OPC_I18N_API || { lang: function () { return 'zh'; }, t: function (k) { return k; } };
  var REPO = CFG.repo || '';
  var GH = 'https://github.com/' + REPO;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────── 1. 基础交互 ───────── */
  window.__opcV2Ready = true;

  var nav = document.getElementById('nav');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* ───────── 2. 链接装配 ───────── */
  // 下载：配置了 Worker 走 /d/* 归因，否则退回 Releases 页（绝不给虚构的直链）
  var releasesUrl = REPO ? GH + '/releases' : '';
  document.querySelectorAll('a[data-download]').forEach(function (a) {
    var variant = a.getAttribute('data-variant') || 'setup';
    if (CFG.apiBase) {
      a.href = CFG.apiBase + (CFG.downloadPath[variant] || '/d/win-x64') + '?ch=web';
    } else {
      a.href = releasesUrl ? releasesUrl + '/latest' : '#download';
    }
  });
  document.querySelectorAll('[data-github]').forEach(function (a) {
    if (REPO) a.href = GH;
  });
  document.querySelectorAll('[data-releases]').forEach(function (a) {
    if (releasesUrl) a.href = releasesUrl;
  });
  document.querySelectorAll('[data-issues]').forEach(function (a) {
    if (REPO) a.href = GH + '/issues';
  });
  document.querySelectorAll('[data-dl-name]').forEach(function (el) {
    var variant = el.closest('[data-variant]');
    var key = variant ? variant.getAttribute('data-variant') : 'setup';
    if (CFG.artifacts && CFG.artifacts[key]) el.textContent = CFG.artifacts[key];
  });

  /* ───────── 3. 版本信息 + 更新日志 ───────── */
  // 安装包大小：GitHub Release 有真实值就用真实值（语言相关的「安装版 ≈」前缀
  // 从字典取），否则退回字典里的兜底文案
  var state = { setupBytes: 0, releasedTag: '', releasedAt: '' };
  function sizeText() {
    if (state.setupBytes) return I18N.t('ver.sizePrefix') + fmtSize(state.setupBytes) + ' MB';
    return I18N.t('ver.size');
  }
  function applyVersionText() {
    var tag = state.releasedTag || CFG.version || '';
    var v = document.getElementById('ver-version');
    var d = document.getElementById('ver-date');
    var s = document.getElementById('ver-size');
    var dl = document.getElementById('dl-version');
    if (v && tag) v.textContent = tag;
    if (dl && tag) dl.textContent = tag;
    if (d) d.textContent = state.releasedAt ? state.releasedAt.slice(0, 7) : (CFG.dateText || '');
    if (s) s.textContent = sizeText();
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    return (bytes / 1024 / 1024).toFixed(0);
  }
  applyVersionText();

  var changelogEl = document.getElementById('changelog-list');
  var changelogFailed = false;
  function changelogFail() {
    changelogFailed = true;
    if (!changelogEl) return;
    changelogEl.innerHTML = '<p class="changelog-empty">' + I18N.t('changelog.empty') + '</p>';
  }
  function renderReleases(list) {
    changelogFailed = false;
    var html = list.map(function (r) {
      var when = r.published_at ? r.published_at.slice(0, 10) : '';
      var notes = (r.body || '').split('\n').filter(function (l) { return l.trim(); }).slice(0, 4);
      var items = notes.map(function (l) { return '<li>' + l.replace(/^[-*]\s*/, '').replace(/[<>]/g, '') + '</li>'; }).join('');
      return '<article class="release">' +
        '<div><span class="release-tag">' + (r.tag_name || '') + '</span>' +
        '<span class="release-date">' + when + '</span></div>' +
        '<div class="release-body"><h3>' + (r.name || r.tag_name || '') + '</h3>' +
        (items ? '<ul>' + items + '</ul>' : '') +
        (r.html_url ? '<a href="' + r.html_url + '" target="_blank" rel="noopener">在 GitHub 查看 →</a>' : '') +
        '</div></article>';
    }).join('');
    changelogEl.innerHTML = html;
    var first = list[0];
    if (first) {
      var setupAsset = (first.assets || []).filter(function (a) { return /setup\.exe$/i.test(a.name); })[0];
      state.releasedTag = first.tag_name || '';
      state.releasedAt = first.published_at || '';
      state.setupBytes = setupAsset ? setupAsset.size : 0;
      applyVersionText();
    }
  }
  if (REPO && changelogEl) {
    fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=5')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (list) { Array.isArray(list) && list.length ? renderReleases(list) : changelogFail(); })
      .catch(changelogFail);
  } else if (changelogEl) {
    changelogFail();
  }

  /* ───────── 4. 演示窗口自动播放 ───────── */
  var stream = document.getElementById('chat-stream');
  var scrollBox = document.getElementById('chat-scroll');
  var modeChip = document.getElementById('chat-mode');
  var ghost = document.getElementById('input-ghost');
  var sendBtn = document.querySelector('.input-send');
  if (!stream || !scrollBox) return;

  var AG = {
    wb:    { name: 'WorkBuddy',  model: 'Sonnet 4.5',   color: '#2fbf71' },
    codex: { name: 'Codex',      model: 'gpt-5-codex',  color: '#7c5cff' },
    gemini:{ name: 'Gemini CLI', model: 'gemini-3-pro', color: '#4285f4' },
  };

  // 演示文案：静态 HTML 里的部分归 i18n.js，这里这份归剧本（切换语言时整段重播）
  var DEMO_T = {
    zh: {
      mode: '分派',
      ghostIdle: '输入消息…', ghostAt: '给 @Codex 发消息…',
      me1: '@Codex 写一个能玩的网页版五子棋，要能和电脑对战，今晚内部分享用。',
      wb1: '收到。拆成 3 个子任务：{{b:棋盘 UI}} → {{b:对战 AI}} → {{b:胜负判定}}。UI 派给 Codex，规则评审派给 Gemini。',
      cx1: '棋盘和对战 AI 完成：{{file:index.html}} + {{file:app.js}}，启发式评分，电脑会堵也会赢。',
      tool1: '写入 app.js · +186 行',
      gm1: '审了一遍：边界情况都处理了。建议补一条「禁手规则」的测试，内部分享容易被问。',
      cx2: '已补测试，{{b:5/5 通过}} ✓',
      goalTitle: '网页版五子棋 · 内部分享',
      goalMeta: '4/4 子任务 · 89K tokens · 12m',
    },
    en: {
      mode: 'Dispatch',
      ghostIdle: 'Type a message…', ghostAt: 'Message @Codex…',
      me1: '@Codex — build a playable web Gomoku with a computer opponent, I’m demoing it internally tonight.',
      wb1: 'On it. Split into 3 subtasks: {{b:board UI}} → {{b:game AI}} → {{b:win check}}. UI goes to Codex, rule review to Gemini.',
      cx1: 'Board and AI done: {{file:index.html}} + {{file:app.js}}. Heuristic scoring — the computer blocks and wins.',
      tool1: 'Wrote app.js · +186 lines',
      gm1: 'Reviewed it: edge cases handled. I’d add a forbidden-move test — people will ask at the demo.',
      cx2: 'Test added, {{b:5/5 passing}} ✓',
      goalTitle: 'Web Gomoku · Launch prep',
      goalMeta: '4/4 subtasks · 89K tokens · 12m',
    },
  };
  function T() { return DEMO_T[I18N.lang()] || DEMO_T.zh; }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // 消息正文里允许 {{file:xxx}} 与 {{b:xxx}} 两个标记
  function rich(s) {
    return esc(s)
      .replace(/\{\{file:([^}]+)\}\}/g, '<span class="file">$1</span>')
      .replace(/\{\{b:([^}]+)\}\}/g, '<b>$1</b>');
  }

  function avatarEl(a, small) {
    var av = document.createElement('span');
    av.className = 'avatar' + (small ? ' sm' : '');
    av.style.setProperty('--c', a.color);
    av.textContent = a.name.charAt(0);
    return av;
  }

  function scrollToBottom() {
    scrollBox.scrollTop = scrollBox.scrollHeight;
  }

  function addMsg(who, html) {
    var wrap = document.createElement('div');
    if (who === 'me') {
      wrap.className = 'msg msg-user';
      wrap.innerHTML = '<div class="msg-main"><span class="msg-name">' + esc(I18N.lang() === 'en' ? 'Me' : '我') + '</span>' +
        '<span class="bubble">' + rich(html) + '</span></div>';
    } else {
      var a = AG[who];
      wrap.className = 'msg';
      wrap.appendChild(avatarEl(a, true));
      var main = document.createElement('div');
      main.className = 'msg-main';
      main.innerHTML = '<span class="msg-name"><b>' + esc(a.name) + '</b>' +
        '<span class="model">' + esc(a.model) + '</span></span>' +
        '<span class="bubble">' + rich(html) + '</span>';
      wrap.appendChild(main);
    }
    stream.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function addTool(agent, label) {
    var a = AG[agent];
    var row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = '<span class="ticon"></span><b>' + esc(label) + '</b>';
    var last = stream.lastElementChild;
    if (last && last.classList.contains('msg') && !last.classList.contains('msg-user')) {
      last.querySelector('.msg-main').appendChild(row);
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'msg';
      wrap.appendChild(avatarEl(a, true));
      var main = document.createElement('div');
      main.className = 'msg-main';
      main.appendChild(row);
      wrap.appendChild(main);
      stream.appendChild(wrap);
    }
    scrollToBottom();
  }

  function addGoalCard(title, meta) {
    var card = document.createElement('div');
    card.className = 'goal-card';
    card.innerHTML =
      '<div class="goal-head"><span class="ok">✓</span>' + esc(title) + '</div>' +
      '<div class="goal-bar"><i></i></div>' +
      '<div class="goal-meta">' + esc(meta) + '</div>';
    stream.appendChild(card);
    scrollToBottom();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        card.querySelector('.goal-bar i').style.width = '100%';
      });
    });
  }

  function typing(agent) {
    var a = AG[agent];
    var wrap = document.createElement('div');
    wrap.className = 'msg typing-msg';
    wrap.appendChild(avatarEl(a, true));
    var main = document.createElement('div');
    main.className = 'msg-main';
    main.innerHTML = '<span class="msg-name"><b>' + esc(a.name) + '</b></span>' +
      '<span class="typing"><i></i><i></i><i></i></span>';
    wrap.appendChild(main);
    stream.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  // 剧本：引用 DEMO_T 的键，语言切换时整段按新语言重播
  var SCRIPT = [
    { mode: true },
    { ghost: 'ghostAt' },
    { do: function () { sendBtn && sendBtn.classList.add('live'); } },
    { me: 'me1' },
    { wait: 700 },
    { ghost: 'ghostIdle' },
    { do: function () { sendBtn && sendBtn.classList.remove('live'); } },
    { type: 'wb' },
    { agent: 'wb', html: 'wb1' },
    { wait: 500 },
    { type: 'codex' },
    { agent: 'codex', html: 'cx1' },
    { tool: ['codex', 'tool1'] },
    { wait: 600 },
    { type: 'gemini' },
    { agent: 'gemini', html: 'gm1' },
    { wait: 500 },
    { type: 'codex' },
    { agent: 'codex', html: 'cx2' },
    { wait: 400 },
    { goal: true },
    { wait: 4200 },
    { clear: true },
  ];

  var playing = false;
  var visible = true;
  var scriptToken = 0;   // 语言切换重播时作废旧剧本的挂起定时器

  function playScript() {
    var token = ++scriptToken;
    playing = true;
    var i = 0;
    function step() {
      if (token !== scriptToken) return;           // 已被新一轮剧本取代
      if (!visible) { setTimeout(step, 1200); return; }   // 演示滚出视口时暂停
      if (i >= SCRIPT.length) {
        playing = false;
        setTimeout(function () {                   // 停 5 秒后自动重播
          if (token === scriptToken && visible) { stream.innerHTML = ''; playScript(); }
        }, 5000);
        return;
      }
      var s = SCRIPT[i++];
      var t = T();
      if (s.mode) { if (modeChip) modeChip.textContent = t.mode; return step(); }
      if (s.ghost) { if (ghost) ghost.textContent = t[s.ghost]; return step(); }
      if (s.do) { s.do(); return step(); }
      if (s.clear) { stream.innerHTML = ''; return step(); }
      if (s.wait) { setTimeout(step, reduceMotion ? 0 : s.wait); return; }
      if (s.me) { addMsg('me', t[s.me]); return step(); }
      if (s.type) {
        var tp = typing(s.type);
        setTimeout(function () { if (token === scriptToken) { tp.remove(); step(); } }, reduceMotion ? 0 : 950);
        return;
      }
      if (s.agent) { addMsg(s.agent, t[s.html]); return step(); }
      if (s.tool) { addTool(s.tool[0], t[s.tool[1]]); return step(); }
      if (s.goal) { addGoalCard(t.goalTitle, t.goalMeta); return step(); }
      step();
    }
    step();
  }

  // 语言切换：静态位立即对齐，剧本清空重播（滚出视口时暂停到回来再播）+ 版本条/更新日志兜底随语言刷新
  document.addEventListener('opc:langchange', function () {
    scriptToken++;                               // 作废旧剧本的所有挂起回调
    playing = false;
    stream.innerHTML = '';
    if (modeChip) modeChip.textContent = T().mode;
    if (ghost) ghost.textContent = T().ghostIdle;
    applyVersionText();
    if (changelogFailed) changelogFail();
    playScript();
  });

  if (reduceMotion) {
    // 弱动效偏好：一次性铺完整个剧本，不循环
    var t0 = T();
    SCRIPT.forEach(function (s) {
      if (s.me) addMsg('me', t0[s.me]);
      else if (s.agent) addMsg(s.agent, t0[s.html]);
      else if (s.tool) addTool(s.tool[0], t0[s.tool[1]]);
      else if (s.mode && modeChip) modeChip.textContent = t0.mode;
      else if (s.ghost && ghost) ghost.textContent = t0[s.ghost];
      else if (s.goal) addGoalCard(t0.goalTitle, t0.goalMeta);
    });
  } else {
    // 加载即播；IntersectionObserver 只负责「滚出视口就暂停、回来继续」。
    // 先把语言相关的静态位（模式角标、输入占位）对齐当前语言再开播。
    if (modeChip) modeChip.textContent = T().mode;
    if (ghost) ghost.textContent = T().ghostIdle;
    playScript();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }, { threshold: 0.2 }).observe(document.querySelector('.demo'));
    }
  }
})();
