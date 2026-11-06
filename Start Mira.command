#!/usr/bin/env bash
set -u

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
python_bin=""
for candidate in python3.12 python3.11 python3.13 python3.14 python3 \
    /opt/homebrew/opt/python@3.12/libexec/bin/python3 \
    /usr/local/opt/python@3.12/libexec/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 \
        && "$candidate" -c 'import sys; assert sys.version_info >= (3,11)' >/dev/null 2>&1; then
        python_bin="$candidate"
        break
    fi
done

if [ -z "$python_bin" ]; then
    printf '本地版需要 Python 3.11 或更新版本。\n'
    printf '如果只想直接用，双击同目录的 Open Mira.html，不需要安装环境。\n'
    if [ -t 0 ]; then read -r -p '按回车关闭窗口。' _; fi
    exit 1
fi

printf '正在打开 Mira。第一次运行会下载本地版所需文件，请稍等。\n'
"$python_bin" "$project_root/scripts/start.py" "$@"
result=$?
if [ "$result" -ne 0 ]; then
    printf '\n如果暂时不想配置本地环境，双击 Open Mira.html 即可使用在线版。\n'
    if [ -t 0 ]; then read -r -p '按回车关闭窗口。' _; fi
fi
exit "$result"
