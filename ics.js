/**
 * 人大课表 → ICS 生成器（浏览器插件版）
 * 规则与 ruc-course-import skill 的 build_ics.py 保持一致：
 *   - 节次时间映射 SLOT_TIMES
 *   - 2节连上=1.5h，3节连上=2.5h（特例 end_time 覆盖）
 *   - 地点规范化：中国人民大学+楼名全称
 *   - 每节课 15 分钟前提醒（VALARM TRIGGER:-PT15M）
 */
'use strict';

// ---- 节次 → 开始时间（与 build_ics.py 完全一致）----
const SLOT_TIMES = {
  1: '08:00', 2: '08:50',
  3: '10:00', 4: '10:50',
  5: '12:00', 6: '12:50',
  7: '14:00', 8: '14:50',
  9: '16:00', 10: '16:50',
  11: '18:00', 12: '18:50',
  13: '19:40', 14: '20:30',
};

// 默认时长（小时）：按节次数。2节=1.5，3节=2.5，4节=3.5（如 11-14 用 end_time 覆盖）
function defaultDurationHours(nSections) {
  if (nSections === 2) return 1.5;
  if (nSections === 3) return 2.5;
  if (nSections === 4) return 3.5; // 仅当未提供 end_time 时兜底
  return 1.5 * nSections - (nSections > 2 ? 0.5 : 0);
}

// ---- 地点规范化（用户硬性偏好）----
function normalizeLocation(loc) {
  loc = (loc || '').trim();
  if (!loc) return '';
  if (loc.startsWith('中国人民大学')) return loc;
  let m = loc.match(/^立德(\d+)$/);
  if (m) return `中国人民大学立德楼${m[1]}`;
  m = loc.match(/^教([一二三四五六])(\d+)$/);
  if (m) {
    const cn = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6' }[m[1]];
    return `中国人民大学教学${cn}楼 ${m[2]}`;
  }
  if (loc.startsWith('世纪馆')) return '中国人民大学世纪馆';
  if (loc.startsWith('明德')) return '中国人民大学明德楼' + loc.slice(2);
  if (loc.startsWith('明法')) return '中国人民大学明法楼' + loc.slice(2);
  if (loc.startsWith('国学楼')) return '中国人民大学国学楼' + loc.slice(3);
  if (loc.startsWith('游泳池')) return '中国人民大学游泳池';
  return '中国人民大学' + loc;
}

function icalEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// 生成 ICS 文本
// courses: [{name, slots:[{weekday(1-7), startSection, endSection, location, endTime?, oddWeeksOnly?, evenWeeksOnly?}]}]
// opts: {startDate: 'YYYY-MM-DD' (第1周周一), weeks: 16, calname}
function buildICS(courses, opts) {
  const weeks = opts.weeks || 16;
  const calname = opts.calname || '人大课表';
  const [y, mo, d] = opts.startDate.split('-').map(Number);
  // 第1周周一的 Date（本地时区构造，再按本地时间写 ICS，与 python 版一致）
  const week1 = new Date(y, mo - 1, d);
  if (week1.getDay() !== 1) {
    console.warn('[ruc-ics] 警告：起始日期不是周一，继续生成');
  }

  const events = [];
  let uid = 0;
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  for (const course of courses) {
    for (const slot of course.slots) {
      const wd = slot.weekday;
      const sS = slot.startSection;
      const eS = slot.endSection;
      const loc = normalizeLocation(slot.location);
      const n = eS - sS + 1;
      const endT = slot.endTime || null; // 'HH:MM' 特例覆盖
      const durH = endT ? null : defaultDurationHours(n);

      for (let week = 1; week <= weeks; week++) {
        if (slot.oddWeeksOnly && week % 2 === 0) continue;
        if (slot.evenWeeksOnly && week % 2 === 1) continue;
        // 第1周周一 + (wd-1)天 + (week-1)周
        const day = new Date(week1);
        day.setDate(day.getDate() + (wd - 1) + (week - 1) * 7);
        const [sh, sm] = SLOT_TIMES[sS].split(':').map(Number);
        const startDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
        let endDt;
        if (endT) {
          const [eh, em] = endT.split(':').map(Number);
          endDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
        } else {
          endDt = new Date(startDt.getTime() + durH * 3600 * 1000);
        }
        const fmt = (dt) =>
          `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;
        uid++;
        events.push({
          uid: `${String(uid).padStart(4, '0')}@agenttrust.site`,
          summary: course.name,
          location: loc,
          start: fmt(startDt),
          end: fmt(endDt),
          desc: course.name, // 无逐周内容时描述=课程名
          sortKey: startDt.getTime(),
        });
      }
    }
  }

  events.sort((a, b) => a.sortKey - b.sortKey);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//agenttrust.site//RUC Schedule Extension//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${calname}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Asia/Shanghai:${e.start}`,
      `DTEND;TZID=Asia/Shanghai:${e.end}`,
      `SUMMARY:${icalEscape(e.summary)}`,
      `LOCATION:${icalEscape(e.location)}`,
      `DESCRIPTION:${icalEscape(e.desc)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:课程提醒',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// 导出到全局（content.js / 测试共用）
if (typeof globalThis !== 'undefined') {
  globalThis.RUC_ICS = { SLOT_TIMES, normalizeLocation, buildICS, defaultDurationHours };
}
