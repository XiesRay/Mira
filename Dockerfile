FROM node:22-bookworm-slim

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.cloud.aliyuncs.com/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3-venv ffmpeg fonts-noto-cjk libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/opencv \
    && /opt/opencv/bin/pip install --no-cache-dir --index-url https://mirrors.aliyun.com/pypi/simple/ -r /tmp/requirements.txt

WORKDIR /app/assets/app
COPY assets/app/package.json assets/app/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com
COPY assets/app/ ./
COPY scripts/opencv_object_boxer.py /app/scripts/opencv_object_boxer.py
RUN test -f dist/index.html && mkdir -p .runtime && chown -R node:node .runtime
ENV NODE_ENV=production OPENCV_PYTHON_BIN=/opt/opencv/bin/python REGION_MOTION_PORT=4317
USER node
CMD ["node", "--import", "tsx", "server/index.ts"]
