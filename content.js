/**
 * 内容脚本：在 jw.ruc.edu.cn 页面上运行。
 * 从「课表查看」页 DOM 解析课程列表，响应 popup 的 RUC_EXTRACT 消息。
 *
 * 解析规则（2026-09-05 在真实页面验证，叶子 div 级解析）：
 *   - 课表 = 页面上含 "x-y节/" 文本的 <table>
 *   - 每行 8 个 td：td[0] 是"第X大节"，td[1..7] 对应周一~周日
 *   - 课程格内的信息在叶子 div（无子元素）里，每行一个 div：
 *       蓝色 div（rgb(0,192,239)）= 课程名，随后依次是教师/校区/班级(hidden)/教室节次周次
 *       slot div 文本形如 "教二2221/1-3节/1-16周[单周|双周]"
 *   - 蓝色名后出现的 slot 归属该课名（一格多课时按顺序归属）
 *   - 跨大节的课渲染成多个相同格，按 key = weekday + 归一化文本 去重
 */
'use strict';

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

function parseScheduleFromDOM() {
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

function extractCourses() {
  const courses = parseScheduleFromDOM();
  // 学期名（用于默认日历名/文件名），如 "2026-2027学年秋季学期"
  let semester = '';
  for (const inp of document.querySelectorAll('input')) {
    if ((inp.value || '').includes('学年')) { semester = inp.value.trim(); break; }
  }
  return { courses, semester, url: location.href, title: document.title };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'RUC_EXTRACT') {
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
  globalThis.RUC_CONTENT = { extractCourses, parseScheduleCell, parseScheduleFromDOM };
}
