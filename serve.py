# -*- coding: utf-8 -*-
"""
serve.py — 本地服务：静态托管 + 一键数据刷新接口

用法：
  python serve.py            # 默认 http://127.0.0.1:8300
  python serve.py --port 9000

接口：
  GET  /            静态页面（index.html 等）
  POST /api/refresh 触发 refresh_data.py 重新拉取真实数据，完成后返回 {ok, log}
  GET  /api/status  返回最近一次刷新时间
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
REFRESH_LOCK = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # data.json / data.js 禁止缓存，保证刷新后拿到新数据
        if self.path.split("?")[0].endswith(("data.json", "data.js")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            refreshed_at = ""
            try:
                with open(os.path.join(BASE, "data.json"), "r", encoding="utf-8") as f:
                    refreshed_at = json.load(f).get("refreshed_at", "")
            except (OSError, ValueError):
                pass
            return self._json(200, {"ok": True, "refreshed_at": refreshed_at})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/refresh":
            return self._json(404, {"ok": False, "error": "not found"})
        if not REFRESH_LOCK.acquire(blocking=False):
            return self._json(409, {"ok": False, "error": "已有刷新任务进行中，请稍候"})
        try:
            proc = subprocess.run(
                [sys.executable, os.path.join(BASE, "refresh_data.py")],
                capture_output=True, timeout=900, cwd=BASE,
            )
            log = (proc.stdout or b"").decode("utf-8", "replace")[-2000:]
            if proc.returncode != 0:
                err = (proc.stderr or b"").decode("utf-8", "replace")[-800:]
                return self._json(500, {"ok": False, "error": err or "刷新脚本执行失败", "log": log})
            return self._json(200, {"ok": True, "log": log})
        except subprocess.TimeoutExpired:
            return self._json(500, {"ok": False, "error": "刷新超时（>15分钟）"})
        finally:
            REFRESH_LOCK.release()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] %s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8300)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"服务已启动: {url}  （Ctrl+C 停止）")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
