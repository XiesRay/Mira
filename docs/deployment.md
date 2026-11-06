# 部署维护

这是给维护服务器的人看的。只想用 Mira，直接打开 [在线版](https://www.jhstore.cn/mira/) 即可。

线上使用 Docker 运行应用，Nginx 将 `/mira/` 的请求转发到 `127.0.0.1:4317`。原来的 `/region-motion/` 地址继续可用；容器名称和健康检查标识保留，不迁移运行数据。

在已有部署环境的这台 Mac 上运行：

```sh
scripts/deploy.sh
```

脚本先构建前端，再上传服务器代码和构建结果。它读取本机已有的服务器连接配置，不把凭据写进仓库。`MCLOUB_SSH_CONFIG_SCRIPT` 可以指定连接配置脚本的位置。安装脚本会检查依赖与 HTTP 服务，失败时恢复上一版本。

开发时，在 `assets/app` 下运行 `npm run typecheck` 或 `npm run build`。修改前端后重新构建；修改本机服务后停止并重新启动。

本地运行文件在 `assets/app/.runtime/`，Python 环境在 `.venv/`，都不应提交。旧项目使用 `region-motion` 格式标识，新版仍能读取；新保存的项目使用 `mira`。
