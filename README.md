# RUC Schedule to Calendar（人大课表 → 日历）

一款同时支持人大本科生与研究生教务系统的浏览器扩展：一键把课表转成 ICS 日历，并生成两个二维码——**Android 扫码下载 .ics**、**iPhone/iPad 扫码订阅日历**。教室自动写全称（如「中国人民大学立德楼407」），每节课课前 15 分钟提醒。

> 本项目面向中国人民大学在校学生，与学校无隶属关系。服务端可完全自部署。

## 安装（开发者模式）

1. Chrome 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 打开「开发者模式」
3. 「加载解压缩的扩展」→ 选择本目录

## 使用

1. 打开并登录对应系统，等课表表格显示出来：
   - 本科生：本科教学管理一体化信息服务平台（`jw.ruc.edu.cn/Njw2017/index.html#/student/student-course-list/`）的「课表查看」页
   - 研究生：研究生教育信息系统（`yjs2.ruc.edu.cn/gsapp/sys/yjsemaphome/portal/index.do`）的「我的课表 → 学生课程表」页
2. 点插件图标 → 点「读取课表并生成二维码」
3. 手机：Android 扫码下载 ics 用日历 App 打开；iPhone 扫码点「订阅」

## 生成规则

- 节次时间：1-2节 08:00–09:30 · 3-4节 10:00–11:30 · 5-6节 12:00–13:30 · 7-8节 14:00–15:30 · 9-10节 16:00–17:30 · 11-12节 18:00–19:30 · 13-14节 19:40–21:10
- 时长：2 节连上 = 1.5h，3 节连上 = 2.5h
- 单双周（如「1-16周单周」）自动只生成对应周
- 每节课内置 15 分钟前提醒（VALARM）
- 地点规范化：立德407→中国人民大学立德楼407 · 教一1406→中国人民大学教学1楼 1406 · 明德地下F→中国人民大学明德楼地下F · 明法0402→中国人民大学明法楼0402 · 世纪馆主馆→中国人民大学世纪馆 等
- 日历名按学期自动生成（如「人大2026秋课表」）

## 自部署服务端（可选）

插件会把生成的 ICS POST 到 `popup.js` 顶部配置的 `SERVER`，生成手机可扫的链接。你可以：

**A. 不部署，纯本地用**：注释掉 popup.js 里 `init()` 中的 `await uploadAndQR(...)` 一行即可，插件退化为"仅抓取生成"，可配合其他方式传 ics（此时二维码功能不可用）。

**B. 部署自己的上传服务**（`server/` 目录）：

```bash
# server/schedule_upload.py：纯 Python 标准库，无第三方依赖
# 监听 127.0.0.1:8390，POST /api/schedule/upload（需 X-Schedule-Token 头）
# 文件落盘 OUT_DIR（默认 /var/www/schedule-ics），由你的 Web 服务器静态下发
python3 schedule_upload.py
```

内置防滥用设计（开放给多人使用前建议保留）：

1. 共享口令：`/etc/schedule-upload/token` 文件（单行文本）或环境变量 `SCHEDULE_TOKEN`；客户端在 `popup.js` 顶部 `SHARED_TOKEN` 填同一值
2. 文件总数上限 5000，满则 503
3. 清理线程每小时删 OUT_DIR 内 3 天以上的 `.ics`（目录+后缀双白名单）
4. 文件名 = `ruc-` + `secrets.token_hex(8)`，不可枚举

Web 服务器（nginx/Caddy 任一）把 `https://你的域名/api/schedule/` 指到 OUT_DIR 静态下发（Content-Type `text/calendar`），把 `/api/schedule/upload` 反代到 8390。最后改 `popup.js` 顶部 `SERVER` 与 `SHARED_TOKEN`。

## 隐私

- 课表在用户自己的浏览器里、用用户本人的登录态解析；服务器不接触教务系统、不存任何凭据
- 上传内容只有课程名/时间/教室，不含姓名、学号、密码
- 生成的链接为 16 位密码学随机字符，且 3 天后自动删除

## 目录结构

```
manifest.json   MV3 配置（storage + tabs；host: 本科/研究生教务系统 + 你的上传域名）
content.js      本科课表与研究生课表 iframe 的 DOM 解析
ics.js          ICS 生成（节次映射/时长/地点规范/VALARM）
popup.html/js   弹窗 UI：读取 → 生成 → 上传 → 双二维码
qrcode.min.js   二维码库（davidshimjs/qrcodejs，MIT）
icons/          图标
server/         可选上传服务（纯标准库 Python）
```

## License

MIT
