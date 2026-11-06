#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
credential_script="${MCLOUB_SSH_CONFIG_SCRIPT:-/Users/xiesr/Desktop/MacTools 脚本/部署 Motionsits.command}"
for command in expect rsync python3; do
    command -v "$command" >/dev/null 2>&1 || { echo "缺少本地命令：$command" >&2; exit 1; }
done
test -f "$credential_script" || { echo "找不到服务器连接脚本：$credential_script" >&2; exit 1; }
SSH_HOST= SSH_PORT= SSH_USER= SSH_PASSWORD=
while IFS= read -r line; do
    case "$line" in
        SSH_HOST=*|SSH_PORT=*|SSH_USER=*|SSH_PASSWORD=*)
            key="${line%%=*}"
            value="${line#*=}"
            case "$value" in
                \"*\"|\'*\') value="${value:1:${#value}-2}" ;;
            esac
            case "$key" in
                SSH_HOST) SSH_HOST="$value" ;;
                SSH_PORT) SSH_PORT="$value" ;;
                SSH_USER) SSH_USER="$value" ;;
                SSH_PASSWORD) SSH_PASSWORD="$value" ;;
            esac
            ;;
    esac
done < "$credential_script"
: "${SSH_HOST:?}" "${SSH_PORT:?}" "${SSH_USER:?}" "${SSH_PASSWORD:?}"
[[ "$SSH_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$SSH_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || {
    echo 'SSH 主机或用户名格式不正确' >&2; exit 1;
}
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || {
    echo 'SSH 端口格式不正确' >&2; exit 1;
}

ssh_run() {
    MCLOUB_DEPLOY_COMMAND="$1" MCLOUB_DEPLOY_PASSWORD="$SSH_PASSWORD" \
    MCLOUB_DEPLOY_HOST="$SSH_HOST" MCLOUB_DEPLOY_PORT="$SSH_PORT" \
    MCLOUB_DEPLOY_USER="$SSH_USER" expect <<'EOF'
set timeout 3600
spawn ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $env(MCLOUB_DEPLOY_PORT) $env(MCLOUB_DEPLOY_USER)@$env(MCLOUB_DEPLOY_HOST) $env(MCLOUB_DEPLOY_COMMAND)
expect {
    -re {[Pp]assword:} { send -- "$env(MCLOUB_DEPLOY_PASSWORD)\r" }
    timeout { exit 124 }
    eof { exit 1 }
}
expect {
    eof {}
    timeout { exit 124 }
}
catch wait result
exit [lindex $result 3]
EOF
}

rsync_push() {
    MCLOUB_RSYNC_SOURCE="$1" MCLOUB_RSYNC_TARGET="$2" \
    MCLOUB_DEPLOY_PASSWORD="$SSH_PASSWORD" MCLOUB_DEPLOY_HOST="$SSH_HOST" \
    MCLOUB_DEPLOY_PORT="$SSH_PORT" MCLOUB_DEPLOY_USER="$SSH_USER" expect <<'EOF'
set timeout 1800
spawn rsync -az -e "ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $env(MCLOUB_DEPLOY_PORT)" $env(MCLOUB_RSYNC_SOURCE) "$env(MCLOUB_DEPLOY_USER)@$env(MCLOUB_DEPLOY_HOST):$env(MCLOUB_RSYNC_TARGET)"
expect {
    -re {[Pp]assword:} { send -- "$env(MCLOUB_DEPLOY_PASSWORD)\r" }
    timeout { exit 124 }
    eof { exit 1 }
}
expect {
    eof {}
    timeout { exit 124 }
}
catch wait result
exit [lindex $result 3]
EOF
}


npm --prefix "$project_root/assets/app" run build

release_id="$(date +%Y%m%d-%H%M%S)-$$"
remote_release="/opt/region-motion/releases/$release_id"
stage="$(mktemp -d -t region-motion-deploy.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
rsync -a --exclude='/docs/' --exclude='.git' --exclude='.venv' --exclude='node_modules' \
    --exclude='.runtime' --exclude='__pycache__' --exclude='.env*' --exclude='*.log' "$project_root/" "$stage/"
ssh_run "mkdir -p '$remote_release'"
rsync_push "$stage/" "$remote_release/"
ssh_run "python3 '$remote_release/scripts/install-server.py'"
printf 'Region Motion deployed: https://www.jhstore.cn/region-motion/\n'
