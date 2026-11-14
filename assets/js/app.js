/**
 * app.js — MasterAio 更新日志前端：状态、数据加载、渲染、搜索、路由与交互。
 * 契约：SPEC.md §3 / §4.3 / §5；零依赖、原生 ES module、全部相对路径。
 *
 * 安全约定：任何来自 changelog/*.txt 或 index.json 的文本都通过 textContent /
 * createTextNode 插入 DOM，绝不经 innerHTML 拼接；innerHTML 仅用于本文件内的
 * 静态图标常量。
 */

import { CONFIG } from './config.js';
import { parseManifest, parseTxt, computeStats, dateParts, normalizeMode } from './parser.js';
import { t } from './i18n.js';

const STORAGE_THEME = 'mlog.theme';
const STORAGE_LANG = 'mlog.lang';
const FETCH_TIMEOUT = 8000;
const SEARCH_DEBOUNCE = 120;
const TOAST_DURATION = 2600;
const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const params = new URLSearchParams(window.location.search);

const ICONS = {
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  inbox:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>',
};

const els = {};
const state = {
  theme: 'dark',
  lang: 'zh',
  themeOverride: false,
  langOverride: false,
  view: 'champions', // champions | updates
  mode: 'rift', // rift | classic
  updateFilter: 'all', // all | rift | classic
  dataBase: './changelog/',
  manifestStatus: 'loading', // loading | ready | error
  manifest: null,
  manifestError: null,
  records: new Map(), // id -> { meta, status, data, error, promise }
  currentId: null,
  query: '',
  heroQuery: '',
  searchTimer: 0,
  searchFrame: 0,
  pendingScroll: null,
  toastTimer: 0,
  themeAnimTimer: 0,
  scrollFrame: 0,
  flashTimer: 0,
  initialised: false,
  // V2 英雄图鉴
  championsStatus: 'loading', // loading | ready | error
  championsError: null,
  champions: null, // { generatedAt, source, champions }
  championIndex: null, // 归属索引 { map, kwToKeys, descAliases }
  championSearchCache: null,
  onlyUpdated: false,
  dialogKey: null,
  dialogMode: 'rift',
  dialogLastFocus: null,
  allVersionsReady: false,
};

/* ==========================================================================
   小工具
   ========================================================================== */

function byId(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function iconSpan(name, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || '';
  return span;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (error) {
    return false;
  }
}

function isMobileLayout() {
  try {
    return window.matchMedia('(max-width: 820px)').matches;
  } catch (error) {
    return false;
  }
}

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    /* 隐私模式 / 禁用存储：忽略即可 */
  }
}

function clearStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    /* ignore */
  }
}

/* ==========================================================================
   启动
   ========================================================================== */

function boot() {
  cacheElements();
  readPreferences();
  state.dataBase = resolveDataBase();
  setupConfig();
  applyTheme(state.theme, { animate: false, persist: false });
  applyLang(state.lang, { persist: false, render: false });
  applyViewChrome();
  syncUrl();
  renderChampionsSkeleton();
  bindEvents();
  updateFooter();
  renderSidebar();
  renderDetail();
  state.initialised = true;
  document.documentElement.setAttribute('data-app-ready', '1');
  loadChampions();
  loadManifest();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

function cacheElements() {
  const ids = [
    'appWindow',
    'titlebar',
    'searchWrap',
    'searchInput',
    'searchClear',
    'searchToggle',
    'langZh',
    'langEn',
    'themeToggle',
    'githubLink',
    'brandName',
    'brandTag',
    'releaseList',
    'detail',
    'backToTop',
    'footerUpdated',
    'footerGithub',
    'toast',
    'liveRegion',
    'skipLink',
    'metaThemeColor',
    'viewNav',
    'championsView',
    'championCount',
    'onlyUpdated',
    'championGrid',
    'championStatus',
    'modeSwitch',
    'releaseFilter',
    'championDialog',
    'championBanner',
    'championBannerImg',
    'championBannerFallback',
    'championDialogClose',
    'championDialogAvatar',
    'championDialogName',
    'championDialogTitle',
    'championMetrics',
    'dialogModeTabs',
    'championDialogGroups',
  ];
  for (const id of ids) els[id] = byId(id);
}

function readPreferences() {
  const root = document.documentElement;
  state.theme = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const langAttr = (root.getAttribute('data-lang') || root.getAttribute('lang') || 'zh').toLowerCase();
  state.lang = langAttr.startsWith('en') ? 'en' : 'zh';
  const themeParam = params.get('theme');
  const langParam = params.get('lang');
  state.themeOverride = themeParam === 'light' || themeParam === 'dark';
  state.langOverride = langParam === 'zh' || langParam === 'en';

  const viewParam = params.get('view');
  state.view = viewParam === 'updates' ? 'updates' : 'champions';
  const classicAllowed = CONFIG.showClassic === true;
  const modeParam = params.get('mode');
  state.mode = classicAllowed && modeParam === 'classic' ? 'classic' : 'rift';
  // 总更新过滤默认跟随 ?mode=（若显式给出且经典可用），否则“全部”
  state.updateFilter = classicAllowed && (modeParam === 'rift' || modeParam === 'classic') ? modeParam : 'all';
  state.dialogMode = state.mode;
}

function resolveDataBase() {
  const custom = params.get('data');
  let base = custom && custom.trim() ? custom.trim() : CONFIG.dataBase || './changelog/';
  try {
    base = new URL(base, document.baseURI).href;
  } catch (error) {
    base = new URL('./changelog/', document.baseURI).href;
  }
  if (!base.endsWith('/')) base += '/';
  return base;
}

function joinUrl(base, file) {
  const raw = String(file || '').replace(/^\/+/, '');
  try {
    return new URL(raw, base).href;
  } catch (error) {
    return base + raw;
  }
}

function setupConfig() {
  if (els.brandName && CONFIG.brand) els.brandName.textContent = CONFIG.brand;
  const github = typeof CONFIG.github === 'string' ? CONFIG.github.trim() : '';
  if (github && /^https?:\/\//i.test(github)) {
    if (els.githubLink) {
      els.githubLink.href = github;
      els.githubLink.hidden = false;
    }
    if (els.footerGithub) {
      els.footerGithub.href = github;
      els.footerGithub.hidden = false;
    }
  }
}

/* ==========================================================================
   主题 & 语言
   ========================================================================== */

function applyTheme(theme, options = {}) {
  const animate = options.animate !== false;
  const persist = options.persist === true;
  const next = theme === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  const changed = root.getAttribute('data-theme') !== next;
  state.theme = next;

  if (changed && animate && !prefersReducedMotion()) {
    root.classList.add('theme-anim');
    window.clearTimeout(state.themeAnimTimer);
    state.themeAnimTimer = window.setTimeout(() => root.classList.remove('theme-anim'), 320);
  }
  root.setAttribute('data-theme', next);

  if (els.metaThemeColor) els.metaThemeColor.setAttribute('content', next === 'dark' ? '#0a0a0b' : '#f2f4f8');
  if (persist && !state.themeOverride) writeStorage(STORAGE_THEME, next);
  updateThemeButton();
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark', { animate: true, persist: true });
}

function updateThemeButton() {
  if (!els.themeToggle) return;
  const label = t(state.lang, state.theme === 'dark' ? 'switchToLight' : 'switchToDark');
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('title', label);
}

function applyLang(lang, options = {}) {
  const next = lang === 'en' ? 'en' : 'zh';
  const persist = options.persist === true;
  const render = options.render !== false;
  const root = document.documentElement;
  state.lang = next;
  root.setAttribute('data-lang', next);
  root.setAttribute('lang', next === 'zh' ? 'zh-CN' : 'en');
  if (persist && !state.langOverride) writeStorage(STORAGE_LANG, next);

  updateStaticText();
  updateThemeButton();
  updateFooter();
  if (render) {
    renderSidebar();
    renderDetail({ preserveScroll: true });
    renderChampions();
    if (state.dialogKey) renderDialog();
  }
}

function updateStaticText() {
  const lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(lang, key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    const key = node.getAttribute('data-i18n-ph');
    if (key) node.setAttribute('placeholder', t(lang, key));
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
    const key = node.getAttribute('data-i18n-aria');
    if (key) node.setAttribute('aria-label', t(lang, key));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(lang, key));
  });

  if (els.brandTag) {
    const tagline = CONFIG.tagline && CONFIG.tagline[lang];
    els.brandTag.textContent = tagline || t(lang, 'changelog');
  }
  if (els.langZh) els.langZh.setAttribute('aria-pressed', String(lang === 'zh'));
  if (els.langEn) els.langEn.setAttribute('aria-pressed', String(lang === 'en'));
  window.document.title = `${CONFIG.brand || 'MasterAio'} · ${t(lang, 'changelog')}`;
  updateSearchPlaceholder();
}

/** 搜索框语义随视图切换（图鉴=搜索英雄；总更新=搜索日志）。 */
function updateSearchPlaceholder() {
  if (!els.searchInput) return;
  const isChampions = state.view === 'champions';
  const phKey = isChampions ? 'searchHeroPlaceholder' : 'searchPlaceholder';
  const labelKey = isChampions ? 'searchHeroLabel' : 'searchLabel';
  els.searchInput.setAttribute('placeholder', t(state.lang, phKey));
  els.searchInput.setAttribute('aria-label', t(state.lang, labelKey));
}

function updateFooter() {
  if (els.footerUpdated) {
    const generatedAt = state.manifest && state.manifest.generatedAt;
    if (generatedAt) {
      els.footerUpdated.textContent = `${t(state.lang, 'updated')} ${formatUpdated(generatedAt)}`;
      els.footerUpdated.setAttribute('datetime', generatedAt);
      els.footerUpdated.hidden = false;
    } else {
      els.footerUpdated.textContent = '';
      els.footerUpdated.hidden = true;
    }
  }
}

function formatUpdated(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch (error) {
    return String(iso);
  }
}

/* ==========================================================================
   数据加载
   ========================================================================== */

async function fetchText(url) {
  if (window.location.protocol === 'file:') {
    const error = new Error('file:// cannot fetch local files');
    error.code = 'file';
    throw error;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.code = 'http';
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeout = new Error('request timeout');
      timeout.code = 'timeout';
      throw timeout;
    }
    if (error && error.code) throw error;
    const network = new Error(error && error.message ? error.message : 'network error');
    network.code = 'network';
    throw network;
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizeError(error) {
  if (!error) return { code: 'unknown', message: '' };
  if (typeof error === 'object') {
    return {
      code: error.code || 'unknown',
      status: error.status,
      message: error.message || String(error),
    };
  }
  return { code: 'unknown', message: String(error) };
}

function formatErrorText(error) {
  if (!error) return t(state.lang, 'loadErrorUnknown');
  if (error.code === 'timeout') return t(state.lang, 'requestTimeout');
  if (error.code === 'http') return t(state.lang, 'httpError', { status: error.status });
  if (error.code === 'file') return t(state.lang, 'fileHint');
  if (error.code === 'parse') return error.message || t(state.lang, 'loadErrorUnknown');
  if (error.code === 'network') return error.message || t(state.lang, 'loadErrorUnknown');
  return error.message || t(state.lang, 'loadErrorUnknown');
}

async function loadManifest() {
  state.manifestStatus = 'loading';
  state.manifest = null;
  state.manifestError = null;
  state.currentId = null;
  state.records.clear();
  state.pendingScroll = null;
  renderSidebar();
  renderDetail();
  updateFooter();

  try {
    const text = await fetchText(joinUrl(state.dataBase, 'index.json'));
    let manifest;
    try {
      manifest = parseManifest(text);
    } catch (parseFailure) {
      const error = new Error(parseFailure && parseFailure.message ? parseFailure.message : 'manifest parse error');
      error.code = 'parse';
      throw error;
    }
    if (manifest.warnings && manifest.warnings.length) {
      manifest.warnings.forEach((message) => console.warn(`[changelog] ${message}`));
    }
    state.manifest = manifest;
    state.manifestStatus = 'ready';
    manifest.versions.forEach((meta) => {
      state.records.set(meta.id, { meta, status: 'idle', data: null, error: null, promise: null });
    });
    updateFooter();
    setupRouting();
    prefetchAll().then(() => {
      state.allVersionsReady = true;
      buildChampionIndex();
      renderChampions();
    });
  } catch (error) {
    state.manifestStatus = 'error';
    state.manifestError = normalizeError(error);
    state.manifest = null;
    state.records.clear();
    renderSidebar();
    renderDetail();
    updateFooter();
  }
}

function ensureVersion(id) {
  const record = state.records.get(id);
  if (!record) return Promise.resolve(null);
  if (record.promise) return record.promise;
  if (record.status === 'ready' && record.data) return Promise.resolve(record);

  record.status = 'loading';
  record.error = null;
  record.promise = (async () => {
    try {
      const url = joinUrl(state.dataBase, record.meta.file || `${record.meta.id}.txt`);
      const text = await fetchText(url);
      record.data = parseTxt(text, { id: record.meta.id, file: record.meta.file });
      record.status = 'ready';
      if (record.data.warnings && record.data.warnings.length) {
        record.data.warnings.forEach((message) => console.warn(`[changelog] ${message}`));
      }
    } catch (error) {
      record.status = 'error';
      record.error = normalizeError(error);
    }
    record.promise = null;
    onVersionLoaded(id);
    return record;
  })();
  return record.promise;
}

function prefetchAll() {
  const tasks = [];
  for (const record of state.records.values()) tasks.push(ensureVersion(record.meta.id));
  return Promise.allSettled(tasks).then(() => {
    if (state.query) scheduleSearchRender();
  });
}

function onVersionLoaded(id) {
  if (!state.initialised) return;
  if (state.query) {
    scheduleSearchRender();
    return;
  }
  if (state.currentId === id) renderDetail({ preserveScroll: false });
}

function retryVersion(id) {
  const record = state.records.get(id);
  if (!record) return;
  record.status = 'idle';
  record.data = null;
  record.error = null;
  record.promise = null;
  renderDetail({ preserveScroll: false });
  ensureVersion(id);
}

function latestVersionId() {
  const versions = baseVersions();
  if (!versions.length) return null;
  const latest = versions.find((item) => item.latest);
  return latest ? latest.id : versions[0].id;
}

/** 界面实际可见的版本（showClassic=false 时剔除经典版本）。 */
function baseVersions() {
  if (!state.manifest) return [];
  const all = state.manifest.versions;
  if (CONFIG.showClassic === true) return all;
  return all.filter((meta) => versionMode(meta) === 'rift');
}

/* ==========================================================================
   路由
   ========================================================================== */

function readHashId() {
  const raw = window.location.hash;
  if (!raw || raw === '#' || raw === '#/') return null;
  let value = raw.slice(1);
  if (value.startsWith('/')) value = value.slice(1);
  try {
    value = decodeURIComponent(value);
  } catch (error) {
    /* 保留原始值 */
  }
  value = value.split('?')[0].split('&')[0].trim();
  return value || null;
}

function setupRouting() {
  if (state.manifestStatus !== 'ready' || !state.manifest) return;
  const versions = baseVersions();
  if (!versions.length) {
    state.currentId = null;
    renderSidebar();
    renderDetail();
    return;
  }
  const allowed = filterVersions().map((item) => item.id);
  const latest = allowed[0] || null;
  const hashId = readHashId();
  let target = latest;
  let invalid = false;
  if (hashId) {
    if (state.records.has(hashId)) {
      target = hashId;
      if (allowed.length && !allowed.includes(hashId)) {
        // 深链版本被当前模式过滤掉：落到该过滤下首个版本
        target = latest;
        invalid = true;
      }
    } else {
      invalid = true;
    }
  }
  state.currentId = target;
  if (target) {
    const desired = `#/${encodeURIComponent(target)}`;
    if (window.location.hash !== desired) {
      try {
        window.history.replaceState({ version: target }, '', desired);
      } catch (error) {
        /* ignore */
      }
    }
    ensureVersion(target);
  }
  renderSidebar();
  renderDetail();
  prefetchAll();
  if (invalid) showToast(t(state.lang, 'invalidLink'));
}

function onRouteChange() {
  if (state.manifestStatus !== 'ready' || !state.manifest) return;
  const versions = baseVersions();
  if (!versions.length) return;
  const latest = latestVersionId();
  const id = readHashId();
  if (!id) {
    if (state.currentId !== latest) navigateTo(latest, { push: false });
    return;
  }
  if (!state.records.has(id)) {
    showToast(t(state.lang, 'invalidLink'));
    try {
      window.history.replaceState({ version: latest }, '', `#/${encodeURIComponent(latest)}`);
    } catch (error) {
      /* ignore */
    }
    if (state.currentId !== latest) navigateTo(latest, { push: false });
    return;
  }
  if (isHiddenVersion(id)) {
    showToast(t(state.lang, 'invalidLink'));
    try {
      window.history.replaceState({ version: latest }, '', `#/${encodeURIComponent(latest)}`);
    } catch (error) {
      /* ignore */
    }
    if (state.currentId !== latest) navigateTo(latest, { push: false });
    return;
  }
  if (id !== state.currentId) navigateTo(id, { push: false });
}

/** 该版本是否因 showClassic=false 而被隐藏。 */
function isHiddenVersion(id) {
  if (CONFIG.showClassic === true) return false;
  const record = state.records.get(id);
  return !!record && versionMode(record.meta) === 'classic';
}

function navigateTo(id, options = {}) {
  if (!state.manifest || state.manifestStatus !== 'ready') return;
  if (!state.records.has(id) || isHiddenVersion(id)) {
    const latest = latestVersionId();
    if (!latest) return;
    showToast(t(state.lang, 'invalidLink'));
    id = latest;
  }
  const push = options.push !== false;
  const itemIndex = typeof options.itemIndex === 'number' ? options.itemIndex : null;
  const sectionIndex = typeof options.sectionIndex === 'number' ? options.sectionIndex : null;
  const scrollTop = options.scrollTop === true;
  const changed = state.currentId !== id;

  if (state.query) {
    window.clearTimeout(state.searchTimer);
    state.query = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.searchClear) els.searchClear.hidden = true;
  }

  if (!changed && itemIndex === null && sectionIndex === null && !scrollTop) {
    els.detail.scrollTop = 0;
    return;
  }

  state.currentId = id;
  if (itemIndex !== null || sectionIndex !== null) {
    state.pendingScroll = { versionId: id, itemIndex, sectionIndex };
  } else {
    state.pendingScroll = null;
  }

  if (push) {
    const targetHash = `#/${encodeURIComponent(id)}`;
    if (window.location.hash !== targetHash) {
      try {
        window.history.pushState({ version: id }, '', targetHash);
      } catch (error) {
        /* ignore */
      }
    }
  }

  if (changed) {
    els.detail.scrollTop = 0;
    renderSidebar();
    ensureVersion(id);
  }
  renderDetail({ preserveScroll: false });
  updateBackToTop();
}

/* ==========================================================================
   侧栏渲染
   ========================================================================== */

function renderSidebar() {
  const list = els.releaseList;
  if (!list) return;

  if (state.manifestStatus === 'loading') {
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(buildSidebarSkeleton());
    return;
  }

  list.setAttribute('aria-busy', 'false');
  if (state.manifestStatus === 'error') {
    list.replaceChildren(buildSidebarNotice(t(state.lang, 'loadFailed')));
    return;
  }

  if (!state.manifest || !state.manifest.versions.length) {
    list.replaceChildren(buildSidebarNotice(t(state.lang, 'noUpdates')));
    return;
  }

  const versions = filterVersions();
  if (!versions.length) {
    list.replaceChildren(buildSidebarNotice(t(state.lang, 'noModeVersions')));
    return;
  }

  const fragment = document.createDocumentFragment();
  versions.forEach((meta) => fragment.appendChild(buildReleaseItem(meta)));
  list.replaceChildren(fragment);
}

/** 当前版本模式过滤后的版本列表。 */
function filterVersions() {
  if (!state.manifest) return [];
  let versions = baseVersions();
  const filter = state.updateFilter;
  if (filter !== 'rift' && filter !== 'classic') return versions;
  if (filter === 'classic' && CONFIG.showClassic !== true) return [];
  return versions.filter((meta) => versionMode(meta) === filter);
}

/** 版本模式（?index.json 的 mode；缺失时回退 txt 的 mode；再回退 rift）。 */
function versionMode(meta) {
  if (!meta) return 'rift';
  if (meta.mode === 'classic' || meta.mode === 'rift') return meta.mode;
  const record = state.records.get(meta.id);
  if (record && record.data && record.data.mode) return record.data.mode;
  return 'rift';
}

/** 模式 chip（峡谷/经典）。 */
function buildModeChip(mode, extraClass) {
  const kind = mode === 'classic' ? 'classic' : 'rift';
  const label = t(state.lang, kind === 'classic' ? 'modeChipClassic' : 'modeChipRift');
  return el('span', `mode-chip is-${kind}${extraClass ? ' ' + extraClass : ''}`, label);
}

function buildSidebarNotice(text) {
  const box = el('div', 'sidebar-empty');
  box.textContent = text;
  return box;
}

function buildSidebarSkeleton() {
  const wrap = el('div', 'release-skeleton');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i += 1) {
    const row = el('div', 'release-skel-row');
    row.append(el('span', 'skel skel-badge'));
    const lines = el('span', 'skel-lines');
    lines.append(el('span', 'skel skel-line'), el('span', 'skel skel-line skel-line-sm'));
    row.append(lines);
    wrap.append(row);
  }
  return wrap;
}

function buildReleaseItem(meta) {
  const active = meta.id === state.currentId;
  const button = el('button', 'release-item');
  button.type = 'button';
  button.dataset.versionId = meta.id;
  button.setAttribute('aria-current', String(active));

  const badge = el('span', 'release-badge');
  badge.setAttribute('aria-hidden', 'true');
  const parts = dateParts(meta.date || meta.id);
  let monthLabel = '—';
  let dayLabel = '—';
  if (parts) {
    dayLabel = parts.day;
    if (state.lang === 'zh') {
      monthLabel = `${Number(parts.month)}月`;
    } else {
      monthLabel = MONTHS_EN[Number(parts.month) - 1] || parts.month;
    }
  }
  badge.append(el('span', 'release-badge-month', monthLabel), el('span', 'release-badge-day', dayLabel));

  const info = el('span', 'release-info');
  const dateText = meta.date || meta.id;
  info.append(el('span', 'release-date', dateText));
  info.append(buildModeChip(versionMode(meta), 'release-mode-chip'));

  button.append(badge, info);

  const labelParts = [dateText];
  labelParts.push(t(state.lang, versionMode(meta) === 'classic' ? 'modeChipClassic' : 'modeChipRift'));
  if (typeof meta.count === 'number') labelParts.push(t(state.lang, 'updatesCount', { n: meta.count }));
  button.setAttribute('aria-label', labelParts.join(', '));
  button.title = labelParts.join(' · ');
  return button;
}

/* ==========================================================================
   详情渲染
   ========================================================================== */

function renderDetail(options = {}) {
  const detail = els.detail;
  if (!detail) return;
  const preserveScroll = options.preserveScroll === true;
  const previousTop = detail.scrollTop;
  let content;
  let busy = false;

  if (state.manifestStatus === 'loading') {
    content = buildDetailSkeleton();
    busy = true;
  } else if (state.manifestStatus === 'error') {
    content = buildManifestErrorView();
  } else if (state.query) {
    content = buildSearchView();
    busy = searchIsBusy();
  } else if (!state.manifest || !baseVersions().length) {
    content = buildEmptyView();
  } else if (!state.currentId) {
    content = buildStateCardView(t(state.lang, 'noModeVersions'), '');
  } else {
    const record = state.records.get(state.currentId);
    if (!record) {
      content = buildDetailSkeleton();
      busy = true;
    } else if (record.status === 'ready') {
      content = buildVersionView(record);
    } else if (record.status === 'error') {
      content = buildVersionErrorView(record);
    } else {
      content = buildDetailSkeleton();
      busy = true;
    }
  }

  detail.replaceChildren(content);
  detail.setAttribute('aria-busy', String(busy));

  if (preserveScroll) detail.scrollTop = previousTop;
  else if (!state.pendingScroll) detail.scrollTop = 0;

  handlePendingScroll();
  updateBackToTop();
}

function searchIsBusy() {
  for (const record of state.records.values()) {
    if (record.status === 'idle' || record.status === 'loading') return true;
  }
  return false;
}

function buildDetailSkeleton() {
  const wrap = el('div', 'detail-inner detail-skeleton');
  wrap.setAttribute('role', 'status');
  wrap.append(el('span', 'sr-only', t(state.lang, 'loading')));
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) wrap.append(el('div', 'skel skel-gap'));
    wrap.append(el('div', 'skel skel-section-head'));
    wrap.append(el('div', 'skel skel-row'));
    wrap.append(el('div', 'skel skel-row is-85'));
    wrap.append(el('div', 'skel skel-row is-70'));
  }
  return wrap;
}

function buildVersionView(record) {
  const meta = record.meta;
  const data = record.data;

  const inner = el('div', 'detail-inner');
  // 详情不再显示版本头（日期/条数/复制链接），只保留一个无障碍标题，视觉上隐藏。
  inner.append(el('h1', 'sr-only', meta.date || data.date || meta.id));

  let itemIndex = 0;
  let hasItems = false;
  data.sections.forEach((section, sectionIndex) => {
    if (!section.items || !section.items.length) return;
    hasItems = true;
    inner.append(buildSection(section, sectionIndex, meta.id, itemIndex));
    itemIndex += section.items.length;
  });

  if (!hasItems) {
    const card = buildStateCard({ icon: 'inbox', title: t(state.lang, 'noUpdates'), text: t(state.lang, 'emptyVersion') });
    inner.append(card);
  }

  return inner;
}

function buildSection(section, sectionIndex, versionId, startIndex) {
  const sectionEl = el('section', 'release-section');
  sectionEl.id = `section-${versionId}-${sectionIndex}`;
  sectionEl.append(el('h2', 'section-title', sectionTitle(section)));
  const list = el('ul', 'item-list');
  section.items.forEach((item, offset) => {
    list.append(buildItem(item, versionId, startIndex + offset));
  });
  sectionEl.append(list);
  return sectionEl;
}

function sectionTitle(section) {
  return sectionTitleFor(section, state.lang);
}

function sectionTitleFor(section, lang) {
  if (lang === 'en') return section.en || section.zh || '';
  return section.zh || section.en || '';
}

function buildItem(item, versionId, index) {
  const li = el('li', 'item');
  li.id = `item-${versionId}-${index}`;
  const line = el('p', 'item-line');
  if (item.ordered) line.append(el('span', 'item-order', `${item.number || index + 1}.`));
  const side = localizedItemSide(item);
  if (side.name) {
    line.append(el('span', 'item-name', `${side.name}:`));
    if (side.desc) line.append(document.createTextNode(' '));
  }
  if (side.desc) line.append(el('span', 'item-desc', side.desc));
  if (!side.name && !side.desc) line.append(el('span', 'item-desc', ''));
  li.append(line);
  return li;
}

function localizedItemSide(item) {
  if (state.lang === 'en' && item.en && (item.en.name || item.en.desc)) {
    return { name: item.en.name || null, desc: item.en.desc || '' };
  }
  const zh = item.zh || { name: null, desc: '' };
  return { name: zh.name || null, desc: zh.desc || '' };
}

function buildStateCard({ icon, title, text, actions }) {
  const card = el('div', 'state-card');
  card.append(iconSpan(icon || 'inbox', 'state-icon'));
  card.append(el('h2', 'state-title', title));
  if (text) card.append(el('p', 'state-text', text));
  if (actions) card.append(actions);
  return card;
}

function buildEmptyView() {
  const wrap = el('div', 'detail-inner');
  wrap.append(buildStateCard({ icon: 'inbox', title: t(state.lang, 'noUpdates'), text: t(state.lang, 'manifestHint') }));
  return wrap;
}

/** 通用状态卡（包在 detail-inner 内）。 */
function buildStateCardView(title, text, icon) {
  const wrap = el('div', 'detail-inner');
  wrap.append(buildStateCard({ icon: icon || 'inbox', title, text }));
  return wrap;
}

function buildVersionErrorView(record) {
  const wrap = el('div', 'detail-inner');
  const card = el('div', 'state-card');
  card.append(iconSpan('alert', 'state-icon'));
  card.append(el('h2', 'state-title', t(state.lang, 'loadFailed')));
  const description = `${record.meta.date || record.meta.id} · ${formatErrorText(record.error)}`;
  card.append(el('p', 'state-text', description));
  card.append(el('p', 'state-hint', record.meta.file || `${record.meta.id}.txt`));
  if (record.error && record.error.code === 'file') card.append(buildFileHint());

  const actions = el('div', 'state-actions');
  const retry = el('button', 'btn');
  retry.type = 'button';
  retry.append(iconSpan('refresh'));
  retry.append(document.createTextNode(t(state.lang, 'retry')));
  retry.addEventListener('click', () => retryVersion(record.meta.id));
  actions.append(retry);
  card.append(actions);

  wrap.append(card);
  return wrap;
}

function buildManifestErrorView() {
  const wrap = el('div', 'detail-inner');
  const card = el('div', 'state-card');
  card.append(iconSpan('alert', 'state-icon'));
  card.append(el('h2', 'state-title', t(state.lang, 'loadFailed')));
  card.append(el('p', 'state-text', formatErrorText(state.manifestError)));
  card.append(el('p', 'state-hint', t(state.lang, 'manifestHint')));
  if (window.location.protocol === 'file:' && (!state.manifestError || state.manifestError.code !== 'file')) {
    card.append(buildFileHint());
  }

  const actions = el('div', 'state-actions');
  const retry = el('button', 'btn');
  retry.type = 'button';
  retry.append(iconSpan('refresh'));
  retry.append(document.createTextNode(t(state.lang, 'retry')));
  retry.addEventListener('click', () => loadManifest());
  actions.append(retry);
  card.append(actions);

  wrap.append(card);
  return wrap;
}

function buildFileHint() {
  const hint = el('div', 'file-hint');
  hint.append(iconSpan('alert'));
  hint.append(el('span', '', t(state.lang, 'fileHint')));
  return hint;
}

/* ==========================================================================
   搜索结果
   ========================================================================== */

function scheduleSearchRender() {
  if (state.searchFrame) return;
  state.searchFrame = window.requestAnimationFrame(() => {
    state.searchFrame = 0;
    if (state.query) renderDetail({ preserveScroll: false });
  });
}

function buildSearchView() {
  const query = state.query;
  const needle = query.toLocaleLowerCase();
  const groups = [];
  let totalHits = 0;

  for (const record of state.records.values()) {
    const meta = record.meta;
    if (CONFIG.showClassic !== true && versionMode(meta) === 'classic') continue;
    const data = record.status === 'ready' ? record.data : null;
    const hits = [];

    if (data) {
      let itemIndex = 0;
      data.sections.forEach((section, sectionIndex) => {
        const zhMatched = matchesText(section.zh, needle);
        const enMatched = matchesText(section.en, needle);
        if (zhMatched || enMatched) {
          hits.push({ kind: 'section', sectionIndex, sectionName: zhMatched ? section.zh : section.en });
        }
        section.items.forEach((item) => {
          const currentIndex = itemIndex;
          itemIndex += 1;
          if (itemMatchesQuery(item, needle)) {
            hits.push({ kind: 'item', itemIndex: currentIndex, sectionName: sectionTitle(section), item });
          }
        });
      });
    }

    if (matchesMeta(meta, data, needle)) {
      hits.push({ kind: 'meta', text: pickMetaHitText(meta, data, needle) });
    }

    if (hits.length) {
      groups.push({ record, meta, data, hits });
      totalHits += hits.length;
    }
  }

  const wrap = el('div', 'detail-inner search-view');
  wrap.append(el('h1', 'search-title', t(state.lang, 'searchResultsTitle', { n: totalHits })));
  const queryLine = el('p', 'search-query');
  queryLine.textContent = `“${query}”`;
  wrap.append(queryLine);

  if (searchIsBusy()) wrap.append(el('p', 'search-pending', t(state.lang, 'loading')));

  if (!groups.length) {
    const actions = el('div', 'state-actions');
    const clearButton = el('button', 'btn btn-ghost', t(state.lang, 'clearSearch'));
    clearButton.type = 'button';
    clearButton.addEventListener('click', () => clearSearch({ focus: true }));
    actions.append(clearButton);
    const card = buildStateCard({ icon: 'search', title: t(state.lang, 'noResults'), actions });
    wrap.append(card);
    return wrap;
  }

  groups.forEach((group) => wrap.append(buildSearchGroup(group, query)));
  return wrap;
}

function buildSearchGroup(group, query) {
  const { record, meta, data, hits } = group;
  const sectionEl = el('section', 'search-group');

  const head = el('button', 'search-group-head');
  head.type = 'button';
  head.append(el('span', 'search-date', meta.date || meta.id));
  head.append(buildModeChip(versionMode(meta), 'search-mode-chip'));
  const count = data && typeof data.count === 'number' ? data.count : meta.count;
  if (typeof count === 'number') head.append(el('span', 'search-group-meta', t(state.lang, 'updatesCount', { n: count })));
  head.append(el('span', 'search-group-count', t(state.lang, 'resultItems', { n: hits.length })));
  head.addEventListener('click', () => goToVersion(meta.id, { scrollTop: true }));
  sectionEl.append(head);

  const list = el('div', 'search-hits');
  hits.forEach((hit) => list.append(buildSearchHit(hit, meta.id, query)));
  sectionEl.append(list);
  return sectionEl;
}

function buildSearchHit(hit, versionId, query) {
  const button = el('button', 'search-hit');
  button.type = 'button';

  if (hit.kind === 'item') {
    const needle = query.toLocaleLowerCase();
    const matchedLang = itemMatchLang(hit.item, needle);
    let side = localizedItemSide(hit.item);
    if (matchedLang && matchedLang !== state.lang) {
      const alternate = matchedLang === 'en' ? hit.item.en : hit.item.zh;
      if (alternate && (alternate.name || alternate.desc)) {
        side = { name: alternate.name || null, desc: alternate.desc || '' };
      }
    }
    button.append(el('span', 'hit-section', hit.sectionName || ''));
    const text = el('span', 'hit-text');
    if (side.name) {
      const nameSpan = el('span', 'hit-name');
      appendHighlighted(nameSpan, side.name, query);
      text.append(nameSpan);
      if (side.desc) text.append(document.createTextNode(': '));
    }
    appendHighlighted(text, side.desc || '', query);
    button.append(text);
    if (matchedLang && matchedLang !== state.lang) {
      button.append(el('span', 'hit-kind', matchedLang === 'en' ? 'EN' : '中'));
    }
    button.addEventListener('click', () => goToVersion(versionId, { itemIndex: hit.itemIndex }));
    return button;
  }

  if (hit.kind === 'section') {
    button.append(el('span', 'hit-section', ''));
    const text = el('span', 'hit-text');
    appendHighlighted(text, hit.sectionName || '', query);
    button.append(text);
    button.append(el('span', 'hit-kind', t(state.lang, 'section')));
    button.addEventListener('click', () => goToVersion(versionId, { sectionIndex: hit.sectionIndex }));
    return button;
  }

  button.append(el('span', 'hit-section', t(state.lang, 'version')));
  const text = el('span', 'hit-text');
  appendHighlighted(text, hit.text || '', query);
  button.append(text);
  button.addEventListener('click', () => goToVersion(versionId, { scrollTop: true }));
  return button;
}

function appendHighlighted(parent, text, query) {
  const source = String(text || '');
  if (!source) return;
  const needle = String(query || '').toLocaleLowerCase();
  if (!needle) {
    parent.append(document.createTextNode(source));
    return;
  }
  const haystack = source.toLocaleLowerCase();
  let start = 0;
  let found = haystack.indexOf(needle, start);
  while (found !== -1) {
    if (found > start) parent.append(document.createTextNode(source.slice(start, found)));
    const mark = document.createElement('mark');
    mark.textContent = source.slice(found, found + needle.length);
    parent.append(mark);
    start = found + needle.length;
    found = haystack.indexOf(needle, start);
  }
  if (start < source.length) parent.append(document.createTextNode(source.slice(start)));
}

function matchesText(value, needle) {
  return typeof value === 'string' && value.toLocaleLowerCase().includes(needle);
}

function itemMatchesQuery(item, needle) {
  return (
    matchesText(item.zh && item.zh.name, needle) ||
    matchesText(item.zh && item.zh.desc, needle) ||
    matchesText(item.en && item.en.name, needle) ||
    matchesText(item.en && item.en.desc, needle)
  );
}

function itemMatchLang(item, needle) {
  if (matchesText(item.zh && item.zh.name, needle) || matchesText(item.zh && item.zh.desc, needle)) return 'zh';
  if (matchesText(item.en && item.en.name, needle) || matchesText(item.en && item.en.desc, needle)) return 'en';
  return null;
}

function matchesMeta(meta, data, needle) {
  const values = [
    meta.id,
    meta.date,
    meta.version,
    meta.summary,
    data && data.version,
    data && data.summary,
    data && data.badge,
  ];
  return values.some((value) => matchesText(value, needle));
}

function pickMetaHitText(meta, data, needle) {
  const candidates = [data && data.summary, meta.summary, data && data.version, meta.version, meta.date, meta.id];
  for (const candidate of candidates) {
    if (matchesText(candidate, needle)) return candidate;
  }
  return meta.date || meta.id;
}

function goToVersion(id, options = {}) {
  if (state.query) {
    window.clearTimeout(state.searchTimer);
    state.query = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.searchClear) els.searchClear.hidden = true;
  }
  navigateTo(id, {
    push: true,
    itemIndex: typeof options.itemIndex === 'number' ? options.itemIndex : null,
    sectionIndex: typeof options.sectionIndex === 'number' ? options.sectionIndex : null,
    scrollTop: options.scrollTop === true,
  });
}

function handlePendingScroll() {
  const pending = state.pendingScroll;
  if (!pending) return;
  if (pending.versionId !== state.currentId || state.query) return;
  const record = state.records.get(state.currentId);
  if (!record || record.status !== 'ready') return;

  window.requestAnimationFrame(() => {
    let target = null;
    if (pending.itemIndex !== null && pending.itemIndex !== undefined) {
      target = document.getElementById(`item-${pending.versionId}-${pending.itemIndex}`);
    } else if (pending.sectionIndex !== null && pending.sectionIndex !== undefined) {
      target = document.getElementById(`section-${pending.versionId}-${pending.sectionIndex}`);
    }
    if (!target || !target.isConnected) return;
    try {
      target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    } catch (error) {
      target.scrollIntoView();
    }
    if (pending.itemIndex !== null && pending.itemIndex !== undefined) flashItem(target);
    state.pendingScroll = null;
  });
}

function flashItem(node) {
  node.classList.remove('is-flash');
  void node.offsetWidth;
  node.classList.add('is-flash');
  window.clearTimeout(state.flashTimer);
  state.flashTimer = window.setTimeout(() => {
    if (node.isConnected) node.classList.remove('is-flash');
  }, 1700);
}

/* ==========================================================================
   搜索交互
   ========================================================================== */

function onSearchInput() {
  const value = els.searchInput.value;
  if (els.searchClear) els.searchClear.hidden = value.length === 0;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    const query = els.searchInput.value.trim();
    if (state.view === 'champions') {
      if (query === state.heroQuery) return;
      state.heroQuery = query;
      renderChampions();
      return;
    }
    if (query === state.query) return;
    state.query = query;
    renderDetail({ preserveScroll: false });
  }, SEARCH_DEBOUNCE);
}

function clearSearch(options = {}) {
  window.clearTimeout(state.searchTimer);
  state.query = '';
  state.heroQuery = '';
  if (els.searchInput) els.searchInput.value = '';
  if (els.searchClear) els.searchClear.hidden = true;
  if (state.view === 'champions') renderChampions();
  else renderDetail({ preserveScroll: false });
  if (options.focus === true) focusSearch();
}

function focusSearch() {
  if (isMobileLayout() && els.titlebar) {
    els.titlebar.classList.add('search-open');
    if (els.searchToggle) els.searchToggle.setAttribute('aria-expanded', 'true');
  }
  if (els.searchInput) {
    els.searchInput.focus();
    try {
      els.searchInput.select();
    } catch (error) {
      /* ignore */
    }
  }
}

function closeMobileSearch() {
  if (!els.titlebar) return;
  els.titlebar.classList.remove('search-open');
  if (els.searchToggle) els.searchToggle.setAttribute('aria-expanded', 'false');
}

/* ==========================================================================
   回到顶部 / Toast
   ========================================================================== */

function activeScrollTop() {
  if (isMobileLayout()) return window.scrollY;
  if (state.view === 'champions' && els.championsView) return els.championsView.scrollTop;
  return els.detail ? els.detail.scrollTop : 0;
}

function updateBackToTop() {
  if (!els.backToTop) return;
  const top = activeScrollTop();
  const visible = top > 120;
  els.backToTop.classList.toggle('is-visible', visible);
  els.backToTop.setAttribute('aria-hidden', String(!visible));
}

function onScroll() {
  if (state.scrollFrame) return;
  state.scrollFrame = window.requestAnimationFrame(() => {
    state.scrollFrame = 0;
    updateBackToTop();
  });
}

function scrollToTop() {
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
  if (isMobileLayout()) {
    window.scrollTo({ top: 0, behavior });
  } else if (state.view === 'champions' && els.championsView) {
    els.championsView.scrollTo({ top: 0, behavior });
  } else if (els.detail) {
    els.detail.scrollTo({ top: 0, behavior });
  }
}

function showToast(message, kind) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', kind === 'error');
  els.toast.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), TOAST_DURATION);
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

function bindEvents() {
  if (els.searchInput) {
    els.searchInput.addEventListener('input', onSearchInput);
  }
  if (els.searchClear) {
    els.searchClear.addEventListener('click', () => clearSearch({ focus: true }));
  }
  if (els.searchToggle) {
    els.searchToggle.addEventListener('click', () => {
      const open = els.titlebar.classList.toggle('search-open');
      els.searchToggle.setAttribute('aria-expanded', String(open));
      if (open) els.searchInput.focus();
    });
  }
  if (els.langZh) els.langZh.addEventListener('click', () => applyLang('zh', { persist: true }));
  if (els.langEn) els.langEn.addEventListener('click', () => applyLang('en', { persist: true }));
  if (els.themeToggle) els.themeToggle.addEventListener('click', toggleTheme);

  // V2：视图切换
  if (els.viewNav) {
    els.viewNav.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('[data-view-btn]') : null;
      if (!btn) return;
      const next = btn.getAttribute('data-view-btn');
      if (next === 'champions' || next === 'updates') setView(next);
    });
  }
  // V2：模式切换
  if (els.modeSwitch) {
    els.modeSwitch.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('[data-mode-btn]') : null;
      if (!btn) return;
      setMode(btn.getAttribute('data-mode-btn'));
    });
  }
  // V2：英雄网格点击
  if (els.championGrid) {
    els.championGrid.addEventListener('click', onChampionGridClick);
    els.championGrid.addEventListener('keydown', onChampionGridKeydown);
  }
  if (els.onlyUpdated) {
    els.onlyUpdated.addEventListener('change', () => {
      state.onlyUpdated = els.onlyUpdated.checked === true;
      renderChampions();
    });
  }
  // V2：总更新模式过滤 chips
  if (els.releaseFilter) {
    els.releaseFilter.addEventListener('click', (event) => {
      const chip = event.target && event.target.closest ? event.target.closest('[data-version-filter]') : null;
      if (!chip) return;
      setUpdateFilter(chip.getAttribute('data-version-filter'));
    });
  }
  // V2：英雄弹窗
  if (els.championDialog) {
    els.championDialog.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('[data-dialog-close]')) closeChampionDialog();
    });
  }
  if (els.championDialogClose) {
    els.championDialogClose.addEventListener('click', closeChampionDialog);
  }
  if (els.dialogModeTabs) {
    els.dialogModeTabs.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('[data-dialog-mode]') : null;
      if (!btn) return;
      setDialogMode(btn.getAttribute('data-dialog-mode'));
    });
  }
  if (els.championsView) els.championsView.addEventListener('scroll', onScroll, { passive: true });

  if (els.releaseList) {
    els.releaseList.addEventListener('click', onReleaseListClick);
    els.releaseList.addEventListener('keydown', onReleaseListKeydown);
  }
  if (els.backToTop) els.backToTop.addEventListener('click', scrollToTop);
  if (els.detail) els.detail.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  document.addEventListener('keydown', onDocumentKeydown);
  if (els.skipLink) {
    els.skipLink.addEventListener('click', (event) => {
      event.preventDefault();
      if (els.detail) els.detail.focus({ preventScroll: true });
    });
  }
}

function onReleaseListClick(event) {
  const button = event.target && event.target.closest ? event.target.closest('.release-item') : null;
  if (!button || !els.releaseList.contains(button)) return;
  const id = button.dataset.versionId;
  if (id) navigateTo(id, { push: true });
}

function onReleaseListKeydown(event) {
  if (event.defaultPrevented) return;
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const items = Array.from(els.releaseList.querySelectorAll('.release-item'));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(items.length - 1, current + 1);
  else next = current < 0 ? 0 : Math.max(0, current - 1);
  event.preventDefault();
  items[next].focus();
  try {
    items[next].scrollIntoView({ block: 'nearest' });
  } catch (error) {
    /* ignore */
  }
}

function onDocumentKeydown(event) {
  if (event.defaultPrevented) return;

  if (event.key === 'Escape' && state.dialogKey) {
    event.preventDefault();
    closeChampionDialog();
    return;
  }

  if (event.key === 'Escape') {
    if (state.view === 'champions' && state.heroQuery) {
      event.preventDefault();
      clearSearch({ focus: false });
      return;
    }
    if (state.query) {
      event.preventDefault();
      clearSearch({ focus: false });
      return;
    }
    if (document.activeElement === els.searchInput) {
      if (els.searchInput.value) {
        els.searchInput.value = '';
        els.searchClear.hidden = true;
      }
      els.searchInput.blur();
      return;
    }
    if (els.titlebar && els.titlebar.classList.contains('search-open')) closeMobileSearch();
    return;
  }

  if (
    event.key === '/' &&
    !isTypingTarget(event.target) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    focusSearch();
  }
}

/* ==========================================================================
   V2：英雄图鉴（数据加载 / 归属算法 / 渲染 / 弹窗 / 视图切换 / 过滤）
   ========================================================================== */

const CJK_RE = /[\u4e00-\u9fff]/;
const NAME_SPLIT_RE = /[/、&,，]/;

/**
 * 腾讯英雄表暂未提供皮肤大图（splash 404）的新英雄 heroId。
 * 为避免弹窗 banner 触发 404 网络请求（控制台 error），这些英雄回退到渐变+首字。
 */
const SPLASH_UNSUPPORTED_IDS = new Set(['799', '800', '804', '805', '893', '901', '904']);

function championSplash(c) {
  if (!c || !c.splash) return null;
  if (c.heroId && SPLASH_UNSUPPORTED_IDS.has(String(c.heroId))) return null;
  return c.splash;
}

function applyViewChrome() {
  const root = document.documentElement;
  root.setAttribute('data-view', state.view);
  root.setAttribute('data-mode', state.mode);
  root.setAttribute('data-show-classic', CONFIG.showClassic === true ? 'true' : 'false');
  if (els.viewNav) {
    els.viewNav.querySelectorAll('[data-view-btn]').forEach((btn) => {
      const active = btn.getAttribute('data-view-btn') === state.view;
      btn.setAttribute('aria-selected', String(active));
      btn.classList.toggle('is-active', active);
    });
  }
  if (els.modeSwitch) {
    els.modeSwitch.querySelectorAll('[data-mode-btn]').forEach((btn) => {
      const active = btn.getAttribute('data-mode-btn') === state.mode;
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('is-active', active);
    });
  }
  updateReleaseFilterChips();
  updateSearchPlaceholder();
}

function updateReleaseFilterChips() {
  if (!els.releaseFilter) return;
  els.releaseFilter.querySelectorAll('[data-version-filter]').forEach((chip) => {
    const active = chip.getAttribute('data-version-filter') === state.updateFilter;
    chip.setAttribute('aria-pressed', String(active));
    chip.classList.toggle('is-active', active);
  });
}

/* ---------- URL 同步 ---------- */

function syncUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('view', state.view);
    if (CONFIG.showClassic !== true) {
      url.searchParams.delete('mode');
    } else if (state.view === 'champions') {
      url.searchParams.set('mode', state.mode);
    } else if (state.updateFilter === 'all') {
      url.searchParams.delete('mode');
    } else {
      url.searchParams.set('mode', state.updateFilter);
    }
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch (error) {
    /* ignore */
  }
}

function setView(next) {
  if (next !== 'champions' && next !== 'updates') return;
  if (state.view === next) return;
  state.view = next;
  if (next === 'updates') state.updateFilter = 'all';
  applyViewChrome();
  syncUrl();
  if (els.searchInput) {
    els.searchInput.value = next === 'champions' ? state.heroQuery : state.query;
    if (els.searchClear) els.searchClear.hidden = els.searchInput.value.length === 0;
  }
  if (next === 'updates') {
    if (state.manifestStatus === 'ready' && state.manifest && !state.currentId) setupRouting();
    renderSidebar();
    renderDetail({ preserveScroll: false });
  } else {
    renderChampions();
  }
  updateBackToTop();
  if (els.championsView) els.championsView.scrollTop = 0;
}

function setMode(next) {
  if (next !== 'rift' && next !== 'classic') return;
  if (next === 'classic' && CONFIG.showClassic !== true) return;
  if (state.mode === next) return;
  state.mode = next;
  applyViewChrome();
  syncUrl();
  renderChampions();
}

function setUpdateFilter(next) {
  if (!['all', 'rift', 'classic'].includes(next)) return;
  if (next === 'classic' && CONFIG.showClassic !== true) return;
  state.updateFilter = next;
  if (next === 'rift' || next === 'classic') state.mode = next;
  applyViewChrome();
  syncUrl();
  const allowed = filterVersions();
  if (!allowed.some((meta) => meta.id === state.currentId)) {
    const target = allowed.length ? allowed[0].id : null;
    if (target) navigateTo(target, { push: false });
    else {
      state.currentId = null;
      renderSidebar();
      renderDetail({ preserveScroll: false });
    }
  } else {
    renderSidebar();
    renderDetail({ preserveScroll: false });
  }
}

/* ---------- 数据加载 ---------- */

async function loadChampions() {
  state.championsStatus = 'loading';
  state.championsError = null;
  renderChampions();
  try {
    const text = await fetchText(CONFIG.championsUrl || './data/champions.json');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const err = new Error('champions.json parse error');
      err.code = 'parse';
      throw err;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.champions) {
      const err = new Error('champions.json 结构无效');
      err.code = 'parse';
      throw err;
    }
    state.champions = parsed;
    state.championsStatus = 'ready';
    if (state.allVersionsReady) buildChampionIndex();
    renderChampions();
  } catch (error) {
    state.championsStatus = 'error';
    state.championsError = normalizeError(error);
    renderChampions();
  }
}

/* ---------- 归属算法（SPEC-V2 §3.2） ---------- */

function buildChampionIndex() {
  if (!state.champions || !state.champions.champions) {
    state.championIndex = null;
    return;
  }
  const champions = state.champions.champions;
  const kwToKeys = new Map();
  const enToKeys = new Map();
  const descAliases = [];
  for (const key of Object.keys(champions)) {
    const c = champions[key] || {};
    for (const alias of [key, c.alias, c.en]) {
      const norm = normalizeEnName(alias);
      if (norm && !enToKeys.has(norm)) enToKeys.set(norm, key);
    }
    const kws = new Set();
    kws.add(String(key).toLowerCase());
    if (c.alias) kws.add(String(c.alias).toLowerCase());
    (c.keywords || []).forEach((kw) => {
      if (kw) kws.add(String(kw).toLowerCase());
    });
    for (const kw of kws) {
      if (!kwToKeys.has(kw)) kwToKeys.set(kw, new Set());
      kwToKeys.get(kw).add(key);
    }
    const cjk = [];
    const ascii = [];
    for (const kw of kws) {
      if (Array.from(kw).length < 2) continue;
      if (CJK_RE.test(kw)) cjk.push(kw);
      else if (kw.length >= 4 && /^[a-z0-9' ]+$/.test(kw)) ascii.push(kw);
    }
    descAliases.push({ key, cjk, ascii });
  }

  const map = new Map();
  const index = { kwToKeys, enToKeys, descAliases };
  const ensure = (key) => {
    let rec = map.get(key);
    if (!rec) {
      rec = { last: null, versions: [] };
      map.set(key, rec);
    }
    return rec;
  };

  for (const record of state.records.values()) {
    if (!record.data || record.status !== 'ready') continue;
    const meta = record.meta;
    const versionId = meta.id;
    const date = meta.date || record.data.date || versionId;
    const groups = new Map();
    for (const section of record.data.sections) {
      // 活化剂相关的更新属于全体，不计入单个英雄的更新列表
      if (isActivatorSection(section)) continue;
      for (const item of section.items || []) {
        const keys = attributeItem(item, index);
        if (!keys.size) continue;
        for (const key of keys) {
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ section, item });
        }
      }
    }
    for (const [key, items] of groups) {
      const rec = ensure(key);
      rec.versions.push({ id: versionId, date, items });
      if (!rec.last || compareDate(date, rec.last) > 0) rec.last = date;
    }
  }
  for (const rec of map.values()) {
    rec.versions.sort((a, b) => compareDate(b.date, a.date));
  }
  state.championIndex = { map, kwToKeys, descAliases };
}

function compareDate(a, b) {
  const na = Number(String(a || '').replace(/\D/g, ''));
  const nb = Number(String(b || '').replace(/\D/g, ''));
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return String(a).localeCompare(String(b));
  return na - nb;
}

/** 活化剂分区：属于全体功能，不计入单个英雄的更新归属。 */
function isActivatorSection(section) {
  if (!section) return false;
  const zh = String(section.zh || '');
  const en = String(section.en || '');
  return zh.includes('活化剂') || /activator/i.test(en);
}

function attributeItem(item, index) {
  const found = new Set();
  if (!item) return found;

  // 1) 英文名优先：英文 alias 唯一、无昵称歧义（Kai'Sa / Lee Sin 等会被归一化）
  const enName = item.en && item.en.name ? String(item.en.name) : '';
  if (enName) {
    for (const seg of nameSegments(enName)) {
      const key = index.enToKeys ? index.enToKeys.get(normalizeEnName(seg)) : null;
      if (key) found.add(key);
    }
    if (found.size) return found;
  }

  // 2) 回退：旧数据没有英文名时，再用中文名/昵称匹配
  if (!item.zh) return found;
  const namePart = item.zh.name ? String(item.zh.name) : '';
  const descPart = item.zh.desc ? String(item.zh.desc) : '';
  if (namePart) {
    for (const seg of nameSegments(namePart)) {
      const keys = index.kwToKeys.get(seg.toLowerCase());
      if (keys) keys.forEach((k) => found.add(k));
    }
  }
  if (descPart) {
    const low = descPart.toLowerCase();
    for (const entry of index.descAliases) {
      let hit = false;
      for (const kw of entry.cjk) {
        if (low.includes(kw)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const kw of entry.ascii) {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(low)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) found.add(entry.key);
    }
  }
  return found;
}

/** 拆分多英雄名称（`狼母/卢锡安/小炮`、`A / B` 等）。 */
function nameSegments(text) {
  const raw = String(text || '');
  const segments = raw
    .split(NAME_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  const full = raw.trim();
  if (full && !segments.includes(full)) segments.push(full);
  return segments;
}

/** 英文名归一化：忽略大小写、空格、撇号、点（Kai'Sa → kaisa，Lee Sin → leesin）。 */
function normalizeEnName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/* ---------- 英雄元信息 ---------- */

function championMeta(key) {
  return state.champions && state.champions.champions ? state.champions.champions[key] || null : null;
}

function championName(key) {
  const c = championMeta(key);
  if (!c) return key;
  if (state.lang === 'en') return c.en || c.name || key;
  return c.name || c.en || key;
}

function championTitle(key) {
  const c = championMeta(key);
  if (!c) return '';
  return c.title || '';
}

function championKeys() {
  if (!state.champions || !state.champions.champions) return [];
  return Object.keys(state.champions.champions);
}

/* ---------- 渲染英雄网格 ---------- */

function renderChampionsSkeleton() {
  const grid = els.championGrid;
  if (!grid) return;
  grid.setAttribute('aria-busy', 'true');
  const wrap = el('div', 'champion-grid-skeleton');
  for (let i = 0; i < 12; i += 1) wrap.append(el('span', 'champ-skel'));
  grid.replaceChildren(wrap);
  if (els.championStatus) {
    els.championStatus.hidden = true;
    els.championStatus.replaceChildren();
  }
}

function setChampionStatus(kind, title, text, withRetry) {
  if (!els.championStatus) return;
  if (!kind) {
    els.championStatus.hidden = true;
    els.championStatus.replaceChildren();
    return;
  }
  els.championStatus.hidden = false;
  const card = el('div', 'champion-state');
  card.append(el('h2', 'champion-state-title', title));
  if (text) card.append(el('p', 'champion-state-text', text));
  if (withRetry) {
    const btn = el('button', 'btn', t(state.lang, 'retryLoad'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      loadChampions();
    });
    card.append(btn);
  }
  els.championStatus.replaceChildren(card);
}

function renderChampions() {
  if (!els.championGrid) return;
  const grid = els.championGrid;

  if (state.championsStatus === 'loading') {
    if (!state.champions) renderChampionsSkeleton();
    updateChampionHeader(0, true);
    return;
  }
  if (state.championsStatus === 'error') {
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    updateChampionHeader(0, false);
    setChampionStatus('error', t(state.lang, 'championsLoadFailed'), formatErrorText(state.championsError), true);
    return;
  }
  if (!state.champions) {
    renderChampionsSkeleton();
    return;
  }

  const keys = championKeys();
  const index = state.championIndex ? state.championIndex.map : new Map();
  const needle = state.heroQuery ? state.heroQuery.toLocaleLowerCase() : '';

  const items = [];
  for (const key of keys) {
    const rec = index.get(key);
    const last = rec && rec.last ? rec.last : null;
    if (state.onlyUpdated && !last) continue;
    if (needle && !championMatches(key, needle)) continue;
    items.push({ key, last });
  }

  items.sort((a, b) => {
    if (a.last && b.last) {
      const cmp = compareDate(b.last, a.last);
      if (cmp !== 0) return cmp;
    } else if (a.last && !b.last) return -1;
    else if (!a.last && b.last) return 1;
    return championName(a.key).localeCompare(championName(b.key), state.lang === 'zh' ? 'zh-Hans-CN' : 'en');
  });

  updateChampionHeader(keys.length, false);

  if (!items.length) {
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    setChampionStatus('empty', t(state.lang, 'noChampions'), t(state.lang, 'noChampionsHint'), false);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of items) fragment.appendChild(buildChampionCard(entry.key, entry.last));
  grid.replaceChildren(fragment);
  grid.setAttribute('aria-busy', 'false');
  setChampionStatus(null);
}

function updateChampionHeader(total, loading) {
  if (els.championCount) els.championCount.textContent = loading ? '' : t(state.lang, 'championCount', { n: total });
}

function buildChampionCard(key, last) {
  const c = championMeta(key);
  const button = el('button', 'champion-card');
  button.type = 'button';
  button.dataset.championKey = key;
  const name = championName(key);

  const avatar = el('span', 'champion-avatar');
  avatar.append(el('span', 'champion-avatar-fallback', Array.from(name)[0] || '?'));
  if (c && c.portrait) {
    const img = document.createElement('img');
    img.className = 'champion-portrait';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.alt = '';
    img.src = c.portrait;
    img.addEventListener('load', () => avatar.classList.add('has-image'));
    img.addEventListener('error', () => img.remove());
    avatar.append(img);
  }
  button.append(avatar);
  button.append(el('span', 'champion-name', name));

  const dateLine = el('span', last ? 'champ-date is-updated' : 'champ-date is-empty', last || '—');
  button.append(dateLine);

  const title = championTitle(key);
  const ariaParts = [name];
  if (title) ariaParts.push(title);
  ariaParts.push(last || '—');
  button.setAttribute('aria-label', ariaParts.join(' · '));
  button.title = `${name}${last ? ' · ' + last : ''}`;
  return button;
}

function championMatches(key, needle) {
  const c = championMeta(key);
  const hay = new Set();
  hay.add(key);
  if (c) {
    if (c.name) hay.add(c.name);
    if (c.en) hay.add(c.en);
    if (c.title) hay.add(c.title);
    if (c.alias) hay.add(c.alias);
    (c.keywords || []).forEach((kw) => hay.add(kw));
  }
  for (const value of hay) {
    if (String(value).toLocaleLowerCase().includes(needle)) return true;
  }
  return false;
}

function onChampionGridClick(event) {
  const card = event.target && event.target.closest ? event.target.closest('[data-champion-key]') : null;
  if (!card) return;
  openChampionDialog(card.getAttribute('data-champion-key'));
}

function onChampionGridKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target && event.target.closest ? event.target.closest('[data-champion-key]') : null;
  if (!card) return;
  event.preventDefault();
  openChampionDialog(card.getAttribute('data-champion-key'));
}

/* ---------- 英雄弹窗 ---------- */

function openChampionDialog(key) {
  if (!key) return;
  state.dialogKey = key;
  state.dialogMode = CONFIG.showClassic === true ? state.mode : 'rift';
  state.dialogLastFocus = document.activeElement;
  renderDialog();
  if (els.championDialog) {
    els.championDialog.hidden = false;
    els.championDialog.setAttribute('aria-hidden', 'false');
    els.championDialog.classList.add('is-open');
  }
  document.body.classList.add('dialog-open');
  window.requestAnimationFrame(() => {
    if (els.championDialogClose) els.championDialogClose.focus();
  });
}

function closeChampionDialog() {
  if (!state.dialogKey) return;
  state.dialogKey = null;
  if (els.championDialog) {
    els.championDialog.hidden = true;
    els.championDialog.setAttribute('aria-hidden', 'true');
    els.championDialog.classList.remove('is-open');
  }
  document.body.classList.remove('dialog-open');
  const last = state.dialogLastFocus;
  state.dialogLastFocus = null;
  if (last && last.focus) {
    try {
      last.focus();
    } catch (error) {
      /* ignore */
    }
  }
}

function setDialogMode(mode) {
  if (mode !== 'rift' && mode !== 'classic') return;
  if (mode === 'classic' && CONFIG.showClassic !== true) return;
  state.dialogMode = mode;
  renderDialog();
}

function renderDialog() {
  const key = state.dialogKey;
  if (!key || !els.championDialog) return;
  const c = championMeta(key);
  const name = championName(key);

  if (els.championDialogName) els.championDialogName.textContent = name;
  if (els.championDialogTitle) {
    let titleText = '';
    if (c) {
      if (state.lang === 'en') titleText = c.title || c.en || '';
      else titleText = c.title || '';
    }
    els.championDialogTitle.textContent = titleText;
  }
  if (els.championBannerImg) {
    const splash = championSplash(c);
    if (splash) {
      els.championBannerImg.src = splash;
      els.championBannerImg.hidden = false;
    } else {
      els.championBannerImg.hidden = true;
      els.championBannerImg.removeAttribute('src');
    }
  }
  if (els.championBannerFallback) els.championBannerFallback.textContent = Array.from(name)[0] || '?';

  if (els.championDialogAvatar) {
    els.championDialogAvatar.replaceChildren();
    els.championDialogAvatar.append(el('span', 'champion-dialog-avatar-fallback', Array.from(name)[0] || '?'));
    if (c && c.portrait) {
      const img = document.createElement('img');
      img.className = 'champion-dialog-portrait';
      img.alt = '';
      img.crossOrigin = 'anonymous';
      img.src = c.portrait;
      img.addEventListener('load', () => els.championDialogAvatar.classList.add('has-image'));
      img.addEventListener('error', () => img.remove());
      els.championDialogAvatar.append(img);
    }
  }

  renderDialogMetrics(key);

  if (els.dialogModeTabs) {
    els.dialogModeTabs.querySelectorAll('[data-dialog-mode]').forEach((btn) => {
      const active = btn.getAttribute('data-dialog-mode') === state.dialogMode;
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('is-active', active);
    });
  }
  renderDialogGroups(key);
}

function renderDialogMetrics(key) {
  if (!els.championMetrics) return;
  const rec = state.championIndex ? state.championIndex.map.get(key) : null;
  const last = rec && rec.last ? rec.last : '—';
  let total = 0;
  if (rec) for (const v of rec.versions) total += v.items.length;

  els.championMetrics.replaceChildren();
  const cells = [
    { label: t(state.lang, 'metricLast'), value: last },
    { label: t(state.lang, 'metricCount'), value: String(total) },
  ];
  for (const cell of cells) {
    const box = el('div', 'champion-metric');
    box.append(el('span', 'champion-metric-value', cell.value));
    box.append(el('span', 'champion-metric-label', cell.label));
    els.championMetrics.append(box);
  }
}

function renderDialogGroups(key) {
  if (!els.championDialogGroups) return;
  els.championDialogGroups.replaceChildren();
  const rec = state.championIndex ? state.championIndex.map.get(key) : null;

  if (!rec || !rec.versions.length) {
    const empty = el('div', 'champion-dialog-empty');
    empty.append(el('p', 'champion-dialog-empty-title', t(state.lang, 'championNoUpdates')));
    empty.append(el('p', 'champion-dialog-empty-text', t(state.lang, 'championNoUpdatesHint')));
    const btn = el('button', 'btn', t(state.lang, 'viewAllUpdates'));
    btn.type = 'button';
    btn.addEventListener('click', () => viewAllUpdatesFor(key));
    empty.append(btn);
    els.championDialogGroups.append(empty);
    return;
  }

  const list = el('div', 'champion-update-lines');
  for (const version of rec.versions) {
    for (const entry of version.items) {
      const side = localizedItemSide(entry.item);
      const text = side.desc || side.name || '';
      if (!text) continue;
      const row = el('div', 'champion-update-line');
      row.append(el('span', 'update-line-date', version.date));
      row.append(el('span', 'update-line-sep', ': '));
      row.append(el('span', 'update-line-text', text));
      list.append(row);
    }
  }
  els.championDialogGroups.append(list);
}

function viewAllUpdatesFor(key) {
  closeChampionDialog();
  setView('updates');
  const q = championName(key);
  state.query = q;
  state.heroQuery = '';
  if (els.searchInput) els.searchInput.value = q;
  if (els.searchClear) els.searchClear.hidden = false;
  renderDetail({ preserveScroll: false });
}

function buildChampionUpdateItem(entry) {
  const { section, item } = entry;
  const wrap = el('div', 'champion-update-item');
  const top = el('div', 'champion-update-top');
  const side = localizedItemSide(item);
  if (side.name) top.append(el('span', 'champion-update-name', `${side.name}:`));
  wrap.append(top);
  if (side.desc) wrap.append(el('p', 'champion-update-desc', side.desc));
  const sectionName = sectionTitleFor(section, state.lang);
  if (sectionName) wrap.append(el('span', 'champion-update-section', sectionName));
  return wrap;
}

/* 供调试/测试观察（只读快照，不影响渲染） */
if (typeof window !== 'undefined') {
  window.__MLOG__ = {
    state,
    stats(versionId) {
      const record = state.records.get(versionId || state.currentId);
      return record && record.data ? computeStats(record.data) : null;
    },
    championIndex() {
      return state.championIndex;
    },
    latestMap() {
      const out = {};
      const idx = state.championIndex && state.championIndex.map;
      if (idx) for (const [key, rec] of idx) if (rec.last) out[key] = rec.last;
      return out;
    },
  };
}
