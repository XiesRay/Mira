#!/usr/bin/env python3
"""Stop only the verified local workbench started from this skill."""
import json
import os
from pathlib import Path
import signal
import sys
from start import APP_DIR, INSTANCE, health


def main():
    state_file = APP_DIR / ".runtime" / "server.json"
    if not state_file.exists():
        print("没有本 skill 启动的工作台记录。")
        return
    state = json.loads(state_file.read_text(encoding="utf-8"))
    current = health(state["port"])
    if not current:
        print("工作台已停止。")
        state_file.unlink(missing_ok=True)
        return
    if current.get("instance") != INSTANCE or current.get("pid") != state.get("pid"):
        raise RuntimeError("端口或进程已变更，不停止其他实例")
    os.kill(state["pid"], signal.SIGTERM)
    state_file.unlink(missing_ok=True)
    print("已停止本地图片框选工作台。")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"停止失败：{error}", file=sys.stderr)
        sys.exit(1)
