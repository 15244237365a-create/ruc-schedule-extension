/**
 * 内容脚本：在 yjs2.ruc.edu.cn 研究生教育信息系统页面上运行。
 * 注入「我的课表 → 学生课程表」iframe，并解析其中的课程列表，
 * 响应 popup 的 RUC_EXTRACT 消息。
 */
'use strict';

const WEEK_RE = /(\d+)\s*-\s*(\d+)\s*周(?:\s*[\[（(]?(单|双)周?[\]）)]?)?/;

function getScheduleDocument() {
  return document;
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

function parseScheduleFromDOM() {
  const doc = getScheduleDocument();
  const table = doc.querySelector('#jsTbl_01') ||
    Array.from(doc.querySelectorAll('table')).find(t => t.querySelector('td[xq][jc] .kb_item'));
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

function normalizeSemester(text) {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/(20\d{2}-20\d{2})学年\s*第([一二])学期/);
  if (!match) return raw;
  return `${match[1]}学年${match[2] === '一' ? '秋季' : '春季'}学期`;
}

function extractCourses() {
  const doc = getScheduleDocument();
  const semesterSelect = doc.querySelector('#query_xnxq');
  const semester = normalizeSemester(
    semesterSelect && semesterSelect.selectedOptions.length
      ? semesterSelect.selectedOptions[0].textContent
      : ''
  );
  return {
    courses: parseScheduleFromDOM(),
    semester,
    url: location.href,
    title: document.title,
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'RUC_EXTRACT') {
      // 只让实际承载课表的 iframe 响应，避免顶层门户页抢先返回空结果。
      if (!location.pathname.includes('/wdkbapp/') || !location.hash.includes('/xskcb')) {
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
  globalThis.RUC_CONTENT = { extractCourses, parseScheduleFromDOM, normalizeSemester };
}
