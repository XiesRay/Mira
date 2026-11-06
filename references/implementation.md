# 实现范围

从用户自己的 Mcloub 项目提取以下能力，业务项目源文件未被修改：

- `src/features/illustration-editor/regionGeometry.ts`：自由选区几何、轮廓清理和圆角曲线。
- `regionAnimation.ts`、`regionTiming.ts`、`sceneMotion.ts`：区域动画公式、顺序排时、场景镜头和转场。
- `scripts/image/opencv_object_boxer.py`：原样复制到 skill 的 `scripts/opencv_object_boxer.py`；保留原自动框选的完整 OpenCV 算法。
- `regionDetect.ts`：恢复原项目请求参数和响应清理，只把接口路径改为本机 `/api/detect-regions`；原图字节直接交给同一 OpenCV 脚本，默认阈值 2，超时 120 秒。OpenCV 4.13.0.92、NumPy 2.3.0 与提取时的原项目环境对齐。
- `editorProject.ts`：提取自动末位区域、手动区域插入和自动排时规则，保留整图补齐区域在最后的行为。原项目的目标区域数来自分镜计划，独立工具改为用户可填写。
- `PlaybackPreview.tsx`：独立播放时间存储、区域遮罩及副本合成、场景镜头与转场。
- 手动边界调整沿用原项目的 `translatePolygonEdge`、`getPointsBounds`、`normalizeRect`：自由轮廓同时移动相邻两个端点，矩形最小边长为画幅的 2%；控制点数量、按下后持续捕获指针的方式与原项目对齐。页面用 ResizeObserver 同时按容器宽高适配画布，控制栏独立占位。
- `src/server-renderer/`：逐帧 Canvas 绘制、区域遮罩、独立渲染进程和 FFmpeg 管道。独立版移除音频、字幕和远程音效，使用 libx264 输出 H.264 MP4。
- 导出时先在浏览器中按原始尺寸生成标准 PNG 副本，使用与预览相同的像素，不修改项目原图和选区。服务端优先由 Canvas 解码；遇到 `Invalid SVG image` 等格式不兼容错误时，用本机 FFmpeg 将位图转换成标准 RGBA PNG 后继续。转换文件在读取后清理。

新增的页面负责本地图片导入、手动编辑、项目 JSON 保存和导出进度。新增的本机服务提供健康检查、OpenCV 自动框选、导出提交、查询、取消和下载接口，不使用原项目的用户、积分、支付或云存储。

导出请求包含 `format: mp4 | gif`，省略时兼容默认 MP4。GIF 复用本机逐帧渲染的 MP4，通过 FFmpeg 分两次生成调色板和循环 GIF，结束后只保留用户选择的结果；取消会中止正在运行的格式转换。区域排序在整行上使用 Pointer Events 与指针捕获，支持鼠标或触摸拖动；移动超过 5 px 后才进入拖动，在松开时更新顺序和排时，上下箭头按钮不触发拖动。

导出按钮显示服务端进度；前端用任务 ID 去重，只在任务首次进入 `done` 时创建同源下载链接并触发一次下载，避免轮询或 React StrictMode 导致重复下载。两张演示图原样保存在 `assets/app/public/examples/`，案例复用普通上传、框选与项目追加链路。页面“使用说明”与根目录 README 说明相同步骤。

图片在浏览器内以 Data URL 保存。框选时发送到 `127.0.0.1`，临时图片在 OpenCV 返回后删除；导出时将当前项目发送到同一本机服务，图片临时写入 `.runtime/exports/<任务编号>/`，渲染结束清理临时图片，仅保留完成的视频。服务不接受远程素材 URL，也不监听局域网地址。

`assets/app/tests/` 保留提取模块已有的纯函数测试源码。它们的存在不代表已经执行；实际验证范围以当次交付说明为准。
