/**
 * parser.js — MasterAio 更新日志数据解析（纯函数，无 DOM、无副作用）。
 *
 * 词法契约见 SPEC.md §2 / §3：
 *  - 容忍 UTF-8 BOM、CRLF / CR / LF 换行。
 *  - 忽略空行与 `//` 注释行。
 *  - `# <id>` 版本头；可选元信息 `标签/badge`、`版本/version`、`摘要/summary`。
 *  - `## 名称 | English Name` 小节；同名合并到已有小节。
 *  - `-` / `*` / `+` 列表条目，或 `1.` 有序条目。
 *  - 条目 `名称: 描述 | Name: Description`，` | ` 前为中文、后可省略（旧 `[标签]` 前缀会被剥离）。
 *  - 名称长度 ≤ 24 字符才视为名称（加粗），否则整条作为描述。
 *  - 无法识别的行仅记录 warning，绝不抛错。
 *
 * 导出：parseManifest / parseTxt / computeStats / dateParts
 * 可被浏览器 ES module 与 Node.js（含 .js 的类型探测）直接复用。
 */

const META_KEYS = {
  '标签': 'badge',
  'badge': 'badge',
  '版本': 'version',
  'version': 'version',
  '摘要': 'summary',
  'summary': 'summary',
  '模式': 'mode',
  'mode': 'mode',
};

/**
 * 归一化版本模式：峡谷|rift → rift；经典|classic → classic。
 * @param {*} value
 * @returns {'rift'|'classic'|null}
 */
export function normalizeMode(value) {
  const text = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (text === '经典' || text === 'classic') return 'classic';
  if (text === '峡谷' || text === 'rift') return 'rift';
  return null;
}

const NAME_MAX_CHARS = 24;
const SEPARATOR = ' | ';

/** 去掉 BOM（仅在文本最开头）。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 按 CRLF / CR / LF 切行。 */
function splitLines(text) {
  return stripBom(text).split(/\r\n|\r|\n/);
}

/** 空行与 `//` 注释行。 */
function isIgnoredLine(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('//');
}

/** 以 Unicode 码点计长度（中文每字 1）。 */
function charLength(text) {
  return Array.from(text).length;
}

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * 从名称/日期字符串里提取年月日。
 * @returns {{year:string, month:string, day:string}|null}
 */
export function dateParts(value) {
  const match = /(\d{4})\D?(\d{2})\D?(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3] };
}

function deriveDate(value) {
  const parts = dateParts(value);
  return parts ? `${parts.year}.${parts.month}.${parts.day}` : null;
}

/** 剥离条目开头的旧标记 `[新增]` / `[New]`（只保留正文，标记不再展示）。 */
function stripTagPrefix(text) {
  return String(text).replace(/^\[[^\]\n]{1,24}\]\s*/, '');
}

/** 单语言片段：剥离旧标签、按首个中/英冒号切分名称与描述，并应用 24 字符规则。 */
function parseSide(rawText) {
  const text = stripTagPrefix(String(rawText).trim()).trim();
  let name = null;
  let desc = text;
  const colon = text.search(/[:：]/);
  if (colon > 0) {
    const candidate = text.slice(0, colon).trim();
    if (candidate && charLength(candidate) <= NAME_MAX_CHARS) {
      name = candidate;
      desc = text.slice(colon + 1).trim();
    }
  }
  return { name, desc };
}

/** 解析条目正文（中英以第一个 " | " 分隔）。 */
function parseItemBody(body) {
  const raw = String(body).trim();
  const separatorAt = raw.indexOf(SEPARATOR);
  let zhRaw = raw;
  let enRaw = null;
  if (separatorAt >= 0) {
    zhRaw = raw.slice(0, separatorAt);
    enRaw = raw.slice(separatorAt + SEPARATOR.length);
  }
  const zh = parseSide(zhRaw);
  let en = null;
  if (enRaw !== null) {
    const parsedEn = parseSide(enRaw);
    if (parsedEn.name !== null || parsedEn.desc !== '') {
      en = parsedEn;
    }
  }
  return { zh, en };
}

/** 列表前缀：`-` / `*` / `+`，或 `1.` / `1)` / `1、`。 */
function parseListPrefix(trimmed) {
  let match = /^(\d{1,3})[.)、]\s*(.+)$/.exec(trimmed);
  if (match && match[2].trim() !== '') {
    return { ordered: true, number: match[1], body: match[2] };
  }
  match = /^[-*+]\s+(.+)$/.exec(trimmed);
  if (match) return { ordered: false, number: null, body: match[1] };
  match = /^[-*+](.+)$/.exec(trimmed);
  if (match) return { ordered: false, number: null, body: match[1] };
  return null;
}

/** 元信息行 `key: value`（中英冒号均可）；无法识别返回 null。 */
function parseMetaLine(line) {
  const colon = line.search(/[:：]/);
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  const value = line.slice(colon + 1).trim();
  const kind = META_KEYS[key] || META_KEYS[key.toLowerCase()] || null;
  if (!kind) return null;
  return { kind, value };
}

function sectionKey(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * 解析 txt 文本。
 * @param {string} text
 * @param {{id?:string, file?:string}} [options] 用于版本头缺失时的回退。
 * @returns {{
 *   id:string, date:string, badge:string|null, version:string|null, summary:string|null,
 *   mode:'rift'|'classic'|null,
 *   sections:Array<{zh:string, en:string|null, items:Array<object>}>,
 *   count:number, hasHeader:boolean, warnings:string[]
 * }}
 */
export function parseTxt(text, options = {}) {
  const options_ = options && typeof options === 'object' ? options : {};
  const warnings = [];
  const lines = splitLines(String(text ?? ''));

  let index = 0;
  while (index < lines.length && isIgnoredLine(lines[index])) index += 1;

  let headerId = null;
  let hasHeader = false;
  if (index < lines.length) {
    const header = /^#(?!#)\s*(.*?)\s*$/.exec(lines[index].trim());
    if (header && header[1]) {
      headerId = header[1].trim();
      hasHeader = true;
      index += 1;
    }
  }

  let badge = null;
  let version = null;
  let summary = null;
  let mode = null;

  while (index < lines.length) {
    const line = lines[index];
    if (isIgnoredLine(line)) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) break;
    if (trimmed.startsWith('#')) {
      warnings.push(`忽略无法识别的小节行（第 ${index + 1} 行）: ${trimmed}`);
      index += 1;
      continue;
    }
    const meta = parseMetaLine(trimmed);
    if (meta) {
      if (meta.kind === 'badge') badge = toText(meta.value);
      else if (meta.kind === 'version') version = toText(meta.value);
      else if (meta.kind === 'summary') summary = toText(meta.value);
      else if (meta.kind === 'mode') mode = normalizeMode(meta.value);
    } else {
      warnings.push(`忽略无法解析的元信息行（第 ${index + 1} 行）: ${trimmed}`);
    }
    index += 1;
  }

  const sections = [];
  let current = null;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (isIgnoredLine(line)) continue;
    const trimmed = line.trim();

    if (trimmed.startsWith('##')) {
      const raw = trimmed.replace(/^##\s*/, '');
      if (!raw) {
        warnings.push(`忽略缺少名称的小节（第 ${index + 1} 行）`);
        continue;
      }
      const pipeAt = raw.indexOf('|');
      let zhName = raw;
      let enName = null;
      if (pipeAt >= 0) {
        zhName = raw.slice(0, pipeAt).trim();
        enName = toText(raw.slice(pipeAt + 1));
      }
      zhName = zhName.trim();
      if (!zhName && enName) zhName = enName;
      if (!zhName) {
        warnings.push(`忽略缺少名称的小节（第 ${index + 1} 行）`);
        continue;
      }
      const key = sectionKey(zhName);
      const existing = sections.find((section) => sectionKey(section.zh) === key);
      if (existing) {
        current = existing;
        if (!existing.en && enName) existing.en = enName;
      } else {
        current = { zh: zhName, en: enName, items: [] };
        sections.push(current);
      }
      continue;
    }

    const list = parseListPrefix(trimmed);
    if (list) {
      const parsed = parseItemBody(list.body);
      if (!current) {
        current = { zh: '', en: null, items: [] };
        sections.push(current);
      }
      current.items.push({
        ordered: list.ordered,
        number: list.number,
        zh: parsed.zh,
        en: parsed.en,
      });
      continue;
    }

    warnings.push(`忽略无法解析的行（第 ${index + 1} 行）: ${trimmed}`);
  }

  const fallbackId =
    toText(options_.id) ||
    (toText(options_.file) ? toText(options_.file).replace(/\.txt$/i, '') : null);
  const id = headerId || fallbackId || '';
  let count = 0;
  for (const section of sections) count += section.items.length;

  return {
    id,
    date: deriveDate(id) || id,
    badge,
    version,
    summary,
    mode,
    sections,
    count,
    hasHeader,
    warnings,
  };
}

/**
 * 解析更新记录清单（对象或 JSON 字符串）。
 * 容忍字段缺失；第一项自动成为 latest。
 * @returns {{generatedAt:string|null, count:number, versions:Array<object>, warnings:string[]}}
 */
export function parseManifest(input) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new Error(`manifest JSON 解析失败: ${error.message}`);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('manifest 不是对象');
  }
  if (!Array.isArray(raw.versions)) {
    throw new Error('manifest 缺少 versions 数组');
  }

  const warnings = [];
  const seen = new Set();
  const versions = [];

  raw.versions.forEach((item, rawIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`忽略无效的版本条目（索引 ${rawIndex}）`);
      return;
    }
    let id = toText(item.id) || toText(item.date);
    if (!id && toText(item.file)) id = toText(item.file).replace(/\.txt$/i, '');
    if (!id) {
      warnings.push(`忽略缺少 id 的版本条目（索引 ${rawIndex}）`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`忽略重复的版本 id: ${id}`);
      return;
    }
    seen.add(id);
    const file = toText(item.file) || `${id}.txt`;
    const countValue = Number(item.count);
    versions.push({
      id,
      file,
      date: toText(item.date) || deriveDate(id) || id,
      latest: item.latest === true,
      badge: toText(item.badge),
      version: toText(item.version),
      summary: toText(item.summary),
      mode: normalizeMode(item.mode) || 'rift',
      count: Number.isFinite(countValue) ? Math.max(0, Math.trunc(countValue)) : null,
      index: rawIndex,
    });
  });

  if (versions.length) {
    let latestIndex = versions.findIndex((item) => item.latest);
    if (latestIndex === -1) latestIndex = 0;
    versions.forEach((item, i) => {
      item.latest = i === latestIndex;
    });
  }

  const total = Number(raw.count);
  return {
    generatedAt: toText(raw.generatedAt),
    count: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : versions.length,
    versions,
    warnings,
  };
}

/**
 * 统计一个已解析版本（或条目数组）的数量信息。
 * @param {object|Array} input parseTxt 的结果，或条目数组
 * @returns {{count:number, sections:number, named:number, ordered:number, englishItems:number, hasEnglish:boolean}}
 */
export function computeStats(input) {
  const sections = Array.isArray(input)
    ? [{ items: input }]
    : Array.isArray(input && input.sections)
      ? input.sections
      : [];
  let count = 0;
  let named = 0;
  let ordered = 0;
  let englishItems = 0;
  let nonEmptySections = 0;

  for (const section of sections) {
    const items = Array.isArray(section && section.items) ? section.items : [];
    if (items.length) nonEmptySections += 1;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      count += 1;
      const zhName = item.zh && item.zh.name;
      const enName = item.en && item.en.name;
      if (zhName || enName) named += 1;
      if (item.ordered) ordered += 1;
      if (item.en && (item.en.name || item.en.desc)) englishItems += 1;
    }
  }

  return {
    count,
    sections: nonEmptySections,
    named,
    ordered,
    englishItems,
    hasEnglish: englishItems > 0,
  };
}
