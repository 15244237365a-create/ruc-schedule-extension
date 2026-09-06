/**
 * popup 逻辑：
 *   ① 从教务页抓课表 → 生成 ICS 存 chrome.storage.local → 上传到 agenttrust.site
 *      → 得到下载链接 + webcal 订阅链接 → 自动生成两个二维码
 *   「重新上传并刷新二维码」= 用上次抓的课表重新走一遍上传
 */
'use strict';

// ====== 自部署配置 ======
// 你的上传服务地址（部署方法见 README）
const SERVER = 'https://agenttrust.site'; // TODO: 改成你自己的域名
// 与服务端 /etc/schedule-upload/token 一致的共享口令；留空则不发送（服务端需同时关闭校验）
const SHARED_TOKEN = 'ruc_sch3dule_sh4red_tok3n'; // TODO: 改成你自己的随机口令
const UPLOAD_API = SERVER + '/api/schedule/upload';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

// 由学期名推日历名/文件名："2026-2027学年秋季学期" → 2026fall / 人大2026秋课表
function semesterMeta(semester) {
  const m = (semester || '').match(/(20\d{2})-20\d{2}学年(春季|秋季|寒假|夏季)学期/);
  if (!m) return { key: '2026fall', cal: '人大2026秋课表' };
  const year = parseInt(m[1], 10);
  const term = m[2];
  if (term === '秋季') return { key: `${year}fall`, cal: `人大${year}秋课表` };
  if (term === '春季') return { key: `${year + 1}spring`, cal: `人大${year + 1}春课表` };
  if (term === '夏季') return { key: `${year + 1}summer`, cal: `人大${year + 1}夏课表` };
  return { key: `${year + 1}winter`, cal: `人大${year + 1}寒假课表` };
}

// 默认学期开始日期（第1周周一）：秋季 9月第一个周一，春季 2月最后一个周一
function defaultStart(semester) {
  const m = (semester || '').match(/(20\d{2})-20\d{2}学年(春季|秋季)学期/);
  if (!m) return '2026-09-07';
  const year = parseInt(m[1], 10);
  if (m[2] === '秋季') return firstMonday(year, 9);
  return lastMonday(year + 1, 2);
}
function firstMonday(year, month) {
  const d = new Date(year, month - 1, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return fmtDate(d);
}
function lastMonday(year, month) {
  const d = new Date(year, month, 0); // 当月最后一天
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 两个课表来源：本科教务「课表查看」页 + 研究生系统门户（课表在同源 iframe 内）
const JW_COURSE_LIST_SUFFIX = '/student/student-course-list/';
const GRAD_COURSE_PAGE_PATH = '/gsapp/sys/yjsemaphome/portal/index.do';

// 向单个 tab 发消息；内容脚本缺失（装扩展前就开着的旧标签页）时自动注入后重试
async function tryExtractFromTab(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'RUC_EXTRACT' });
    return { resp };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      return { error: msg };
    }
    // 内容脚本没注入：动态注入 ics.js + content.js 后重试一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['ics.js', 'content.js'],
      });
    } catch (e2) {
      return { error: '自动注入失败：' + (e2 && e2.message || e2) };
    }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'RUC_EXTRACT' });
      return { resp };
    } catch (e2) {
      return { error: String(e2 && e2.message || e2) };
    }
  }
}

// 抓取课表：遍历所有课表查看 tab，任何一个成功即用
async function extract() {
  const tabs = await chrome.tabs.query({ url: ['https://jw.ruc.edu.cn/*', 'https://yjs2.ruc.edu.cn/*'] });
  const courseTabs = tabs.filter(t => {
    if ((t.url || '').endsWith(JW_COURSE_LIST_SUFFIX)) return true;
    try { return new URL(t.url || '').pathname === GRAD_COURSE_PAGE_PATH; }
    catch (e) { return false; }
  });
  if (!courseTabs.length) {
    setStatus(
      tabs.length
        ? '当前不在课表页——本科请进入教务系统「课表查看」，研究生请进入「我的课表 → 学生课程表」'
        : '未找到课表页面——请先点上方链接打开教务系统或研究生系统并登录',
      'error'
    );
    return null;
  }
  setStatus('读取课表中…');

  let lastError = '';
  for (const tab of courseTabs) {
    const { resp, error } = await tryExtractFromTab(tab.id);
    if (resp && resp.ok) {
      if (resp.courses.length) return resp;
      lastError = '没有解析到课程——请确认课表已加载';
      continue;
    }
    lastError = (resp && resp.error) || error || lastError || '未知错误';
  }
  setStatus('抓取失败：' + lastError + '（若反复出现，请刷新课表页面后再试）', 'error');
  return null;
}

// 生成 ICS 并存本地
async function generateICS(resp) {
  const semester = resp.semester || '';
  const meta = semesterMeta(semester);
  const start = $('startDate').value || defaultStart(semester);
  const weeks = parseInt($('weeks').value, 10) || 16;

  const icsText = RUC_ICS.buildICS(resp.courses, {
    startDate: start,
    weeks,
    calname: meta.cal,
  });

  const record = {
    ics: icsText,
    meta: {
      semester,
      key: meta.key,
      calname: meta.cal,
      start,
      weeks,
      courseCount: resp.courses.length,
      eventCount: (icsText.match(/BEGIN:VEVENT/g) || []).length,
      generatedAt: Date.now(),
    },
  };
  await chrome.storage.local.set({ schedule: record });
  return record;
}

// 上传 → 二维码
// 共享口令（混淆存放，配合服务端总额限/3天清理挡滥用脚本；非机密数据，ics 本身无个人信息）
async function uploadAndQR(prefix) {
  const { schedule } = await chrome.storage.local.get('schedule');
  if (!schedule) { setStatus('请先读取课表', 'error'); return; }
  setStatus((prefix || '') + '上传中…');
  try {
    const res = await fetch(UPLOAD_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Schedule-Token': SHARED_TOKEN,
      },
      body: JSON.stringify(schedule),
    });
    if (res.status === 401) throw new Error('口令失效，请更新插件');
    if (res.status === 503) throw new Error('服务端存储已满，请联系维护者');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '上传失败');
    renderQR(data.icsUrl);
    setStatus((prefix || '') + '已上线，扫码即可导入（链接 3 天后失效，重新读取可刷新）', 'ok');
  } catch (e) {
    setStatus('上传失败：' + (e.message || e), 'error');
  }
}

function renderQR(icsUrl) {
  const webcal = icsUrl.replace(/^https:/, 'webcal:');
  // 安卓：扫 https 链接 → 浏览器下载 ics
  $('qrAndroid').src = makeQRDataURL(icsUrl);
  // 苹果：扫 webcal → 提示在日历 App 订阅
  $('qrIOS').src = makeQRDataURL(webcal);
  $('linkAndroid').href = icsUrl;
  $('linkAndroid').textContent = icsUrl.replace(SERVER, '');
  $('linkIOS').href = webcal;
  $('linkIOS').textContent = webcal.replace(SERVER, '');
  $('qrSection').style.display = 'block';
}

// 用 davidshimjs/qrcodejs 生成 data URL
function makeQRDataURL(text) {
  const div = document.createElement('div');
  new QRCode(div, {
    text,
    width: 160,
    height: 160,
    colorDark: '#3a3835',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
  const canvas = div.querySelector('canvas');
  if (canvas) return canvas.toDataURL('image/png');
  const img = div.querySelector('img');
  return img ? img.src : '';
}

// 页面加载：恢复上次状态
(async function init() {
  const { schedule } = await chrome.storage.local.get('schedule');
  if (schedule) {
    setStatus(`上次生成：${schedule.meta.calname}，${schedule.meta.eventCount} 节课（${new Date(schedule.meta.generatedAt).toLocaleString()}）`, 'ok');
  }
  // 全校使用人数（聚合统计，无个人数据）
  try {
    const res = await fetch(SERVER + '/api/schedule/stats');
    const s = await res.json();
    if (s && s.ok && s.total > 0) {
      const line = $('usageLine');
      line.innerHTML = `累计已生成 <strong>${Number(s.total).toLocaleString()}</strong> 份课表`;
      line.hidden = false;
    }
  } catch (e) { /* 静默 */ }
  // ①：抓取 → 生成 → 自动上传并出二维码，一步到位
  $('btnExtract').addEventListener('click', async () => {
    const resp = await extract();
    if (!resp) return;
    const rec = await generateICS(resp);
    await uploadAndQR(`✓ ${rec.meta.courseCount} 门课 / ${rec.meta.eventCount} 节课，第1周 ${rec.meta.start}，共 ${rec.meta.weeks} 周 · `);
  });
  $('btnUpload').addEventListener('click', () => uploadAndQR());
})();
