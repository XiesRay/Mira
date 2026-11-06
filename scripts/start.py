#!/usr/bin/env python3
"""Prepare and start only this skill's loopback image workbench."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

SKILL_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SKILL_DIR / "assets" / "app"
INSTANCE = hashlib.sha256(str(APP_DIR).encode()).hexdigest()[:12]


def opencv_python():
    """Reuse compatible installed dependencies, otherwise prepare a skill-only venv."""
    configured = os.environ.get("OPENCV_PYTHON_BIN")
    environment = SKILL_DIR / ".venv"
    candidates = [configured, str(environment / "bin" / "python"),
                  "/usr/local/opt/python@3.12/libexec/bin/python3",
                  "/opt/homebrew/opt/python@3.12/libexec/bin/python3", sys.executable,
                  shutil.which("python3.12"), shutil.which("python3.11"), shutil.which("python3.13")]
    check = "import cv2,numpy; assert cv2.__version__ == '4.13.0' and numpy.__version__ == '2.3.0'"
    for candidate in dict.fromkeys(value for value in candidates if value):
        try:
            subprocess.run([candidate, "-c", check], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            return candidate
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if configured == candidate:
                raise RuntimeError("OPENCV_PYTHON_BIN 需要安装 scripts/requirements.txt 中的 OpenCV 和 NumPy 版本")
    interpreter = None
    for candidate in dict.fromkeys(value for value in candidates if value):
        try:
            subprocess.run([candidate, "-c", "import sys; assert sys.version_info >= (3,11)"], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            interpreter = candidate
            break
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
    if not interpreter:
        raise RuntimeError("OpenCV 自动框选需要 Python 3.11 或更新版本，请安装后再启动")
    print("准备 skill 独立的 OpenCV 环境…", flush=True)
    if not (environment / "bin" / "python").exists():
        subprocess.run([interpreter, "-m", "venv", str(environment)], check=True)
    python = str(environment / "bin" / "python")
    subprocess.run([python, "-m", "pip", "install", "--disable-pip-version-check", "-r", str(SKILL_DIR / "scripts" / "requirements.txt")], check=True)
    return python


def health(port):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
            result = json.load(response)
        return result if result.get("app") == "region-motion" else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def main():
    parser = argparse.ArgumentParser(description="打开本地图片框选与动画工作台")
    parser.add_argument("--port", type=int, default=4317)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise RuntimeError("端口必须在 1024 到 65535 之间")
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise RuntimeError("需要 Node.js 22 或更新版本及 npm")
    major = int(subprocess.check_output([node, "--version"], text=True).strip().lstrip("v").split(".")[0])
    if major < 22:
        raise RuntimeError("需要 Node.js 22 或更新版本")
    runtime = APP_DIR / ".runtime"
    runtime.mkdir(exist_ok=True)
    url = f"http://127.0.0.1:{args.port}"
    existing = health(args.port)
    if existing and existing.get("instance") != INSTANCE:
        raise RuntimeError("该端口运行着另一个副本，请使用 --port 指定其他端口")
    python = opencv_python()
    lockfile = APP_DIR / "package-lock.json"
    installed_lock = APP_DIR / "node_modules" / ".package-lock.json"
    if not installed_lock.exists() or (lockfile.exists() and lockfile.stat().st_mtime > installed_lock.stat().st_mtime + 1):
        print("准备本地依赖…", flush=True)
        subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=APP_DIR, check=True)
    sources = [APP_DIR / "package.json", APP_DIR / "tsconfig.json", APP_DIR / "vite.config.ts", APP_DIR / "index.html"]
    for folder in ("src", "server", "tests"):
        sources.extend(path for path in (APP_DIR / folder).rglob("*") if path.is_file())
    built = APP_DIR / "dist" / "index.html"
    if not built.exists() or any(path.stat().st_mtime > built.stat().st_mtime for path in sources):
        print("构建本地页面…", flush=True)
        subprocess.run([npm, "run", "build"], cwd=APP_DIR, check=True)
    if not existing:
        env = dict(os.environ, REGION_MOTION_PORT=str(args.port), OPENCV_PYTHON_BIN=python)
        with (runtime / "server.log").open("a", encoding="utf-8") as log:
            child = subprocess.Popen([node, "--import", "tsx", "server/index.ts"], cwd=APP_DIR, env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        for _ in range(100):
            existing = health(args.port)
            if existing:
                break
            if child.poll() is not None:
                raise RuntimeError(f"本地服务未能启动，请查看 {runtime / 'server.log'}；端口占用时可使用 --port 4318")
            time.sleep(0.2)
        if not existing:
            child.terminate()
            raise RuntimeError(f"本地服务启动超时，请查看 {runtime / 'server.log'}")
    if existing.get("instance") != INSTANCE:
        raise RuntimeError("端口实例不匹配，请使用其他端口")
    state = {"pid": existing["pid"], "port": args.port, "instance": INSTANCE}
    (runtime / "server.json").write_text(json.dumps(state), encoding="utf-8")
    print(f"工作台已就绪：{url}")
    if not existing.get("ffmpeg"):
        print("提示：未找到 FFmpeg；当前可框选和预览，安装 FFmpeg 并重启后可导出 MP4。")
    if not args.no_open:
        webbrowser.open(url)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"启动失败：{error}", file=sys.stderr)
        sys.exit(1)
