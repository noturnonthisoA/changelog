/**
 * config.js — 站点配置（SPEC.md §5）。
 * `dataBase` 可被 URL 参数 `?data=<url>` 覆盖；`github` 为空则隐藏所有仓库入口。
 */
export const CONFIG = {
  brand: 'MasterAio',
  tagline: { zh: '更新日志', en: 'Changelog' },
  dataBase: './changelog/',
  // 英雄图鉴数据固定放在站点根的 data/ 下（与版本日志分离）
  championsUrl: './data/champions.json',
  github: '',
  defaultTheme: 'dark',
  defaultLang: 'zh',
  // 是否在界面展示「经典」模式；false 时只显示峡谷（经典数据与代码仍保留，改回 true 即恢复）
  showClassic: false,
};
