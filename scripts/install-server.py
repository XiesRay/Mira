#!/usr/bin/env python3
"""Install the uploaded release on the existing Mirami Docker/Nginx server."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request


def run(*args):
    return subprocess.run(args, check=True)


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:4317/api/health', timeout=5) as response:
        result = json.load(response)
    if result.get('app') != 'region-motion' or not result.get('ffmpeg') or not result.get('opencv'):
        raise RuntimeError('Mira dependencies are not ready')


def main():
    release = Path(__file__).resolve().parents[1]
    root = release.parents[1]
    image = 'region-motion:' + release.name
    run('docker', 'build', '--memory', '512m', '--memory-swap', '768m',
        '--cpu-quota', '100000', '-t', image, str(release))
    runtime = root / 'runtime'
    runtime.mkdir(exist_ok=True)
    os.chown(str(runtime), 1000, 1000)
    site = Path('/www/server/panel/vhost/nginx/www.jhstore.cn.conf')
    original = site.read_text(encoding='utf-8')
    route = '''
    # REGION-MOTION-BEGIN
    location = /mira {
        return 301 https://www.jhstore.cn/mira/$is_args$args;
    }
    location ^~ /mira/ {
        if ($scheme = http) { return 308 https://www.jhstore.cn$request_uri; }
        client_max_body_size 80m;
        proxy_pass http://127.0.0.1:4317/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        add_header Cache-Control "no-store" always;
    }
    location = /region-motion {
        return 301 https://www.jhstore.cn/mira/$is_args$args;
    }
    location ^~ /region-motion/ {
        if ($scheme = http) { return 308 https://www.jhstore.cn$request_uri; }
        client_max_body_size 80m;
        proxy_pass http://127.0.0.1:4317/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        add_header Cache-Control "no-store" always;
    }
    # REGION-MOTION-END
'''
    if '# REGION-MOTION-BEGIN' in original:
        updated, count = re.subn(r'\n    # REGION-MOTION-BEGIN\n.*?    # REGION-MOTION-END\n',
                                 lambda _: route, original, flags=re.S)
        if count != 1:
            raise RuntimeError('Ambiguous Mira Nginx markers')
    else:
        position = original.rfind('}')
        if position < 0:
            raise RuntimeError('Invalid Nginx server block')
        updated = original[:position] + route + original[position:]
    shutil.copy2(str(site), str(release / 'nginx-before.conf'))
    previous = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'region-motion'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
    previous_image = previous.stdout.strip() if previous.returncode == 0 else None

    def start(tag):
        run('docker', 'run', '-d', '--name', 'region-motion', '--restart', 'unless-stopped',
            '--network', 'host', '--cpus', '1', '--memory', '768m', '--memory-swap', '1536m',
            '--pids-limit', '128', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '-e', 'REGION_MOTION_PUBLIC_ORIGIN=https://www.jhstore.cn',
            '-v', str(runtime) + ':/app/assets/app/.runtime', tag)

    # Confirm the dependency probes can start before replacing the running release.
    run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c',
        'node --version && ffmpeg -version >/dev/null && /opt/opencv/bin/python -c "import cv2, numpy"')
    if previous_image:
        run('docker', 'stop', '-t', '30', 'region-motion')
        run('docker', 'rm', 'region-motion')
    try:
        start(image)
        for attempt in range(30):
            try:
                health()
                break
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(1)
        site.write_text(updated, encoding='utf-8')
        run('nginx', '-t')
        run('nginx', '-s', 'reload')
        for attempt in range(10):
            try:
                run('curl', '--fail', '--silent', '--show-error', '--max-time', '20',
                    '--resolve', 'www.jhstore.cn:443:127.0.0.1',
                    'https://www.jhstore.cn/mira/api/health')
                break
            except subprocess.CalledProcessError:
                if attempt == 9:
                    raise
                time.sleep(1)
    except Exception:
        site.write_text(original, encoding='utf-8')
        run('nginx', '-t')
        run('nginx', '-s', 'reload')
        subprocess.run(['docker', 'rm', '-f', 'region-motion'])
        if previous_image:
            start(previous_image)
        raise
    print('\nReady: https://www.jhstore.cn/mira/')


if __name__ == '__main__':
    main()
