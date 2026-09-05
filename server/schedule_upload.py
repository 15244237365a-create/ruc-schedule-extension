#!/usr/bin/env python3
"""人大课表 ICS 上传/下载服务（agenttrust.site，东京机）。

POST /api/schedule/upload   body: {"ics": "...", "meta": {...}}，需带 X-Schedule-Token
    -> {"ok": true, "icsUrl": "https://agenttrust.site/api/schedule/<key>.ics"}
    文件名 = secrets.token_hex(8)（不可枚举），落盘 /var/www/schedule-ics/<key>.ics，
    由 Caddy 静态直出。

安全/限额设计：
  - 共享口令校验（X-Schedule-Token，TOKEN 环境变量或 TOKEN_FILE 读取），错口令 401
  - 文件总数上限 MAX_FILES（超出拒绝新上传，防磁盘填满攻击）
  - 清理线程每小时跑一次：只删 OUT_DIR 内 3 天以上的 *.ics（白名单目录+白名单后缀，
    不碰服务器上任何其他文件）
"""
import datetime
import hashlib
import json
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT_DIR = '/var/www/schedule-ics'
MAX_BODY = 2 * 1024 * 1024   # 2MB
MAX_FILES = 5000             # 文件总数上限，超出拒绝新上传
MAX_ICS_CHARS = 1_500_000    # 单文件字符上限（2MB body 解出的 ics 不可能超过它）
FILE_TTL_SEC = 3 * 24 * 3600 # 3 天以上的旧文件由清理线程删除
CLEAN_INTERVAL_SEC = 3600    # 每小时清理一次

# 共享口令：优先 TOKEN_FILE（单行文本），否则 TOKEN 环境变量；都没有则启动报错
TOKEN = ''
if os.path.exists('/etc/schedule-upload/token'):
    with open('/etc/schedule-upload/token', encoding='utf-8') as f:
        TOKEN = f.read().strip()
else:
    TOKEN = os.environ.get('SCHEDULE_TOKEN', '').strip()
if not TOKEN:
    raise SystemExit('no token: create /etc/schedule-upload/token or set SCHEDULE_TOKEN')


def safe_key():
    """密码学随机文件名，不可枚举：ruc-<16hex>。"""
    return 'ruc-' + secrets.token_hex(8)


def cleanup_old_files():
    """只删 OUT_DIR 下 3 天以上的 .ics 文件。目录/后缀双白名单，不碰其他任何路径。"""
    now = time.time()
    try:
        names = os.listdir(OUT_DIR)
    except OSError:
        return
    for name in names:
        if not name.endswith('.ics'):
            continue
        path = os.path.join(OUT_DIR, name)
        # 双保险：确认是 OUT_DIR 下的普通文件（防拼接路径逃逸）
        if os.path.dirname(path) != OUT_DIR or not os.path.isfile(path):
            continue
        try:
            if now - os.path.getmtime(path) > FILE_TTL_SEC:
                os.unlink(path)
        except OSError:
            pass


def cleanup_loop():
    while True:
        try:
            cleanup_old_files()
        except Exception:
            pass
        time.sleep(CLEAN_INTERVAL_SEC)


def count_files():
    try:
        return sum(1 for n in os.listdir(OUT_DIR) if n.endswith('.ics')
                   and os.path.isfile(os.path.join(OUT_DIR, n)))
    except OSError:
        return 0


# ---- 使用统计（仅聚合：总量 + 按日次数，无任何个人数据）----
STATS_FILE = os.path.join(OUT_DIR, 'stats.json')
STATS_DAILY_KEEP = 30          # 每日桶保留 30 天
_stats_lock = threading.Lock()


def _load_stats():
    try:
        with open(STATS_FILE, encoding='utf-8') as f:
            s = json.load(f)
        if not isinstance(s, dict):
            raise ValueError
    except Exception:
        s = {}
    s.setdefault('total', 0)
    s.setdefault('daily', {})
    return s


def fingerprint(ics_text):
    """课表内容指纹：剥掉每次生成都不同的 DTSTAMP/UID 后取哈希。
    同一份课表重复生成 → 同一指纹 → 只算一个人。单向哈希，无法还原课表。"""
    stripped = re.sub(r'^(DTSTAMP|UID):.*$', '', ics_text, flags=re.M)
    return hashlib.sha256(stripped.encode()).hexdigest()[:16]


def record_upload(ics_text):
    fp = fingerprint(ics_text)
    today = datetime.date.today().isoformat()
    with _stats_lock:
        s = _load_stats()
        s.setdefault('people', {})
        if fp not in s['people']:
            s['people'][fp] = today          # 首次出现日期
        s['people'][fp] = s['people'][fp]    # 保留首次日期（可追溯活跃）
        s['total'] += 1
        s['daily'][today] = s['daily'].get(today, 0) + 1
        cutoff = (datetime.date.today() - datetime.timedelta(days=STATS_DAILY_KEEP)).isoformat()
        s['daily'] = {d: n for d, n in s['daily'].items() if d >= cutoff}
        tmp = STATS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(s, f)
        os.replace(tmp, STATS_FILE)


def get_stats(include_people):
    """公开接口只返回人次（总量/今日/近7天）；带有效口令才返回去重人数。"""
    with _stats_lock:
        s = _load_stats()
    today = datetime.date.today().isoformat()
    week_ago = (datetime.date.today() - datetime.timedelta(days=6)).isoformat()
    out = {
        'ok': True,
        'total': s['total'],
        'today': s['daily'].get(today, 0),
        'last7': sum(n for d, n in s['daily'].items() if d >= week_ago),
    }
    if include_people:
        out['people'] = len(s.get('people', {}))
        out['people_first_seen'] = sorted(s.get('people', {}).values()) or None
    return out


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Schedule-Token')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # /api/schedule/stats：公开返回人次；带有效 X-Schedule-Token 才附加去重人数
        if self.path == '/api/schedule/stats':
            token_ok = secrets.compare_digest(self.headers.get('X-Schedule-Token') or '', TOKEN)
            self._json(200, get_stats(include_people=token_ok))
            return
        self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path != '/api/schedule/upload':
            self._json(404, {'ok': False, 'error': 'not found'})
            return
        if not secrets.compare_digest(self.headers.get('X-Schedule-Token') or '', TOKEN):
            self._json(401, {'ok': False, 'error': 'unauthorized'})
            return
        if count_files() >= MAX_FILES:
            self._json(503, {'ok': False, 'error': 'storage full, try later'})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > MAX_BODY:
                self._json(413, {'ok': False, 'error': 'body too large'})
                return
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            ics = data.get('ics') or ''
            if len(ics) > MAX_ICS_CHARS:
                self._json(413, {'ok': False, 'error': 'ics too large'})
                return
            if 'BEGIN:VCALENDAR' not in ics or 'END:VCALENDAR' not in ics:
                self._json(400, {'ok': False, 'error': 'invalid ics'})
                return
            os.makedirs(OUT_DIR, exist_ok=True)
            key = safe_key()
            path = os.path.join(OUT_DIR, f'{key}.ics')
            with open(path + '.tmp', 'w', encoding='utf-8') as f:
                f.write(ics)
            os.replace(path + '.tmp', path)
            record_upload(ics)
            url = f'https://agenttrust.site/api/schedule/{key}.ics'
            self._json(200, {'ok': True, 'icsUrl': url})
        except Exception:
            self._json(500, {'ok': False, 'error': 'internal error'})

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', 8390), Handler).serve_forever()
