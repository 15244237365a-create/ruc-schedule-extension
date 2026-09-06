/**
 * 内容脚本：同时支持两个课表来源，按所在页面自动分流：
 *   1. 本科教务系统 jw.ruc.edu.cn「课表查看」页（顶层页面解析）
 *   2. 研究生教育信息系统 yjs2.ruc.edu.cn「我的课表 → 学生课程表」iframe
 *
 * 本科解析规则（2026-09-05 在真实页面验证，叶子 div 级解析）：
 *   - 课表 = 含 "x-y节/" 文本的 <table>；每行 8 个 td，td[1..7] 对应周一~周日
 *   - 蓝色 div（rgb(0,192,239)）= 课程名；slot div 形如 "教二2221/1-3节/1-16周[单周|双周]"
 *   - 跨大节的课渲染成多个相同格，按 key = weekday + 归一化文本 去重
 *
 * 研究生解析规则（PR#1，2026-09-06 合并）：
 *   - 课表 iframe 内 #jsTbl_01（或含 td[xq][jc] .kb_item 的表格）
 *   - td 的 xq/jc 属性 = 星期/起始节次，rowspan = 连堂节数
 *   - 课程卡片 .arrage.kb_item 里含 "课程代码-课名"、"周次"、教室
 *   - 课程代码 → 课程名映射来自「课程代码/课程名称」汇总表
 *   - 只让承载课表的 iframe 响应消息，避免门户顶层页抢答空结果
 */
'use strict';

// ============================================================
// 本科（jw.ruc.edu.cn）解析
// ============================================================

// "教一1406/1-2节/1-16周单周" → 结构化 slot（教室部分不含 / 和空白）
const SLOT_RE = /^([^/\s]+)\/(\d+)-(\d+)节\/(\d+)-(\d+)周(单周|双周)?$/;
function parseScheduleCell(text) {
  const m = text.match(SLOT_RE);
  if (!m) return null;
  const slot = {
    location: m[1].trim(),
    startSection: parseInt(m[2], 10),
    endSection: parseInt(m[3], 10),
    startWeek: parseInt(m[4], 10),
    endWeek: parseInt(m[5], 10),
    weekFlag: m[6] || '',
  };
  if (slot.weekFlag === '单周') slot.oddWeeksOnly = true;
  if (slot.weekFlag === '双周') slot.evenWeeksOnly = true;
  return slot;
}

// 解析单个课程格 → [{name, location, startSection, ...}]（不含 weekday）
function parseCell(cell) {
  const out = [];
  let curName = null;
  for (const dv of cell.querySelectorAll('div')) {
    if (dv.children.length !== 0) continue; // 只看叶子 div
    const dt = (dv.textContent || '').trim();
    if (!dt) continue;
    const st = dv.getAttribute('style') || '';
    if (st.includes('rgb(0, 192, 239)') || st.includes('rgb(0,192,239)')) {
      curName = dt;
      continue;
    }
    const slot = parseScheduleCell(dt);
    if (slot) {
      if (!curName) continue;
      out.push({ name: curName, ...slot });
    }
  }
  return out;
}

function parseUndergradFromDOM() {
  const tables = Array.from(document.querySelectorAll('table'));
  let target = null;
  for (const t of tables) {
    if (/\d+-\d+节\//.test(t.textContent)) { target = t; break; }
  }
  if (!target) return [];

  const rows = Array.from(target.querySelectorAll('tr'));
  const courseMap = new Map();
  const seen = new Set();

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td, th'));
    for (let i = 1; i < cells.length; i++) {
      const weekday = i; // 1=周一 … 7=周日
      const cell = cells[i];
      const raw = (cell.textContent || '').trim();
      if (!raw) continue;
      const key = weekday + '|' + raw.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);

      for (const item of parseCell(cell)) {
        if (!courseMap.has(item.name)) courseMap.set(item.name, []);
        const { name, ...slot } = item;
        slot.weekday = weekday;
        courseMap.get(item.name).push(slot);
      }
    }
  }

  const courses = [];
  for (const [name, slots] of courseMap) courses.push({ name, slots });
  return courses;
}

function extractUndergradSemester() {
  for (const inp of document.querySelectorAll('input')) {
    if ((inp.value || '').includes('学年')) return inp.value.trim();
  }
  return '';
}

// ============================================================
// 研究生（yjs2.ruc.edu.cn）解析
// ============================================================

const WEEK_RE = /(\d+)\s*-\s*(\d+)\s*周(?:\s*[\[（(]?(单|双)周?[\]）)]?)?/;

function findGradTimetable(doc) {
  return doc.querySelector('#jsTbl_01') ||
    Array.from(doc.querySelectorAll('table')).find(t => t.querySelector('td[xq][jc] .kb_item'));
}

function courseNamesByCode(doc) {
  const names = new Map();
  const tables = Array.from(doc.querySelectorAll('table'));
  const table = tables.find(t => {
    const text = t.textContent || '';
    return text.includes('课程代码') && text.includes('课程名称');
  });
  if (!table) return names;

  const rows = Array.from(table.rows || []);
  const header = rows.find(row => (row.textContent || '').includes('课程代码'));
  if (!header) return names;
  const labels = Array.from(header.cells).map(cell => (cell.textContent || '').trim());
  const codeIndex = labels.indexOf('课程代码');
  const nameIndex = labels.indexOf('课程名称');
  if (codeIndex < 0 || nameIndex < 0) return names;

  for (const row of rows) {
    const cells = Array.from(row.cells || []);
    if (cells.length <= Math.max(codeIndex, nameIndex)) continue;
    const code = (cells[codeIndex].textContent || '').trim();
    const name = (cells[nameIndex].textContent || '').trim();
    if (code && code !== '课程代码' && name) names.set(code, name);
  }
  return names;
}

function sectionEndTimes(table) {
  const endTimes = new Map();
  for (const row of Array.from(table.rows || [])) {
    const cells = Array.from(row.cells || []);
    if (cells.length < 2) continue;
    const sectionMatch = (cells[0].textContent || '').match(/第\s*(\d+)\s*节/);
    const timeMatch = (cells[1].textContent || '').match(/\d{2}:\d{2}\s*[~～-]\s*(\d{2}:\d{2})/);
    if (sectionMatch && timeMatch) {
      endTimes.set(Number(sectionMatch[1]), timeMatch[1]);
    }
  }
  return endTimes;
}

function fallbackCourseName(courseLine) {
  const rest = courseLine.replace(/^[^-]+-/, '').trim();
  return rest.replace(/[（(][^（）()]*[）)]\s*$/, '').trim() || rest;
}

function parseGradFromDOM(gradTable) {
  const doc = document;
  const table = gradTable || findGradTimetable(doc);
  if (!table) return [];

  const nameMap = courseNamesByCode(doc);
  const endTimes = sectionEndTimes(table);
  const courseMap = new Map();
  const seen = new Set();

  for (const cell of table.querySelectorAll('td[xq][jc]')) {
    if (cell.style.display === 'none') continue;
    const weekday = Number(cell.getAttribute('xq'));
    const startSection = Number(cell.getAttribute('jc'));
    const span = Number(cell.getAttribute('rowspan') || '1');
    const endSection = startSection + Math.max(span, 1) - 1;
    if (!weekday || !startSection) continue;

    for (const card of cell.querySelectorAll('.arrage.kb_item')) {
      const lines = Array.from(card.children)
        .map(item => (item.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const fullText = lines.join(' ');
      const weekMatch = fullText.match(WEEK_RE);
      const courseLineIndex = lines.findIndex(line => /^[A-Za-z0-9]+-/.test(line));
      if (!weekMatch || courseLineIndex < 0) continue;

      const courseLine = lines[courseLineIndex];
      const codeMatch = courseLine.match(/^([A-Za-z0-9]+)-/);
      const code = codeMatch ? codeMatch[1] : '';
      const name = nameMap.get(code) || fallbackCourseName(courseLine);
      const location = lines[courseLineIndex + 2] || '';
      const startWeek = Number(weekMatch[1]);
      const endWeek = Number(weekMatch[2]);
      const weekFlag = weekMatch[3] ? weekMatch[3] + '周' : '';
      const key = [name, weekday, startSection, endSection, startWeek, endWeek, weekFlag, location].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const slot = {
        weekday,
        startSection,
        endSection,
        startWeek,
        endWeek,
        weekFlag,
        location,
      };
      const endTime = endTimes.get(endSection);
      if (endTime) slot.endTime = endTime;
      if (weekFlag === '单周') slot.oddWeeksOnly = true;
      if (weekFlag === '双周') slot.evenWeeksOnly = true;
      if (!courseMap.has(name)) courseMap.set(name, []);
      const slots = courseMap.get(name);
      const adjacent = slots.find(existing =>
        existing.weekday === slot.weekday &&
        existing.startWeek === slot.startWeek &&
        existing.endWeek === slot.endWeek &&
        existing.weekFlag === slot.weekFlag &&
        existing.location === slot.location &&
        slot.startSection <= existing.endSection + 1 &&
        slot.endSection >= existing.startSection - 1
      );
      if (adjacent) {
        adjacent.startSection = Math.min(adjacent.startSection, slot.startSection);
        adjacent.endSection = Math.max(adjacent.endSection, slot.endSection);
        const mergedEndTime = endTimes.get(adjacent.endSection);
        if (mergedEndTime) adjacent.endTime = mergedEndTime;
      } else {
        slots.push(slot);
      }
    }
  }

  return Array.from(courseMap, ([name, slots]) => ({ name, slots }));
}

function normalizeGradSemester(text) {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/(20\d{2}-20\d{2})学年\s*第([一二])学期/);
  if (!match) return raw;
  return `${match[1]}学年${match[2] === '一' ? '秋季' : '春季'}学期`;
}

function extractGradCourses() {
  const semesterSelect = document.querySelector('#query_xnxq');
  const semester = normalizeGradSemester(
    semesterSelect && semesterSelect.selectedOptions.length
      ? semesterSelect.selectedOptions[0].textContent
      : ''
  );
  return {
    courses: parseGradFromDOM(null),
    semester,
    url: location.href,
    title: document.title,
  };
}

// ============================================================
// 分发：按所在页面/页面特征选择解析器
// ============================================================

function isGradPage() {
  try { return location.hostname === 'yjs2.ruc.edu.cn'; } catch (e) { return false; }
}

function parseScheduleFromDOM() {
  // 研究生课表 iframe：存在特征表格即走研究生解析
  if (findGradTimetable(document)) return parseGradFromDOM(null);
  // 其余（本科教务页）走本科解析
  return parseUndergradFromDOM();
}

function extractCourses() {
  if (isGradPage()) return extractGradCourses();
  return {
    courses: parseScheduleFromDOM(),
    semester: extractUndergradSemester(),
    url: location.href,
    title: document.title,
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'RUC_EXTRACT') {
      // 研究生系统：只让实际承载课表的 iframe 响应，避免顶层门户页抢先返回空结果。
      if (isGradPage() &&
          !(location.pathname.includes('/wdkbapp/') && location.hash.includes('/xskcb'))) {
        return false;
      }
      try {
        const result = extractCourses();
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    }
    return false;
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.RUC_CONTENT = {
    extractCourses,
    parseScheduleFromDOM,
    parseUndergradFromDOM,
    parseGradFromDOM,
    parseScheduleCell,
    normalizeGradSemester,
  };
}
