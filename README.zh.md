# dsh-video-understand

面向 DeepSeek Harness 的字幕优先视频转录插件，使用确定性抽取式 Markdown 总结。它通过 `yt-dlp` 获取媒体；字幕不可用、失败或清洗后为空时，才使用 faster-whisper 的 `large-v3`。不调用外部 LLM。

## 安装

需要 Node.js 20+、Python 3.10+，并确保 `yt-dlp` 与 `ffmpeg` 在 PATH 中。运行 `npm install`，再运行 `python -m pip install -r requirements.txt`。Windows 可使用 `winget install yt-dlp.yt-dlp` 和 `winget install Gyan.FFmpeg`，也可使用系统包管理器。

运行 `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1` 可检查依赖并安装 Python 依赖；bootstrap 不会下载 Whisper 模型。

## 模型首次下载

第一次真正触发 Whisper 回退时，faster-whisper/CTranslate2 会下载 `large-v3`，需要数 GB 磁盘空间。测试与 `npm run pack:check` 不下载模型，也不访问真实站点。默认优先 CUDA；如果 CUDA 初始化失败，`scripts/transcribe.py` 会自动用 CPU + `int8` 重试同一个 `large-v3` 模型。

## 配置

配置输出目录，并可选设置 `ytDlpPath`、`pythonPath`、`transcribeScript`、前置参数、`device`、`computeType`、`timeoutMs`（默认 15 分钟）和 `outputLimitBytes`（每个输出流默认 1 MiB）。URL 必须是 HTTP(S)，不得含凭据或控制字符。

## 产物

每个任务写入 UUID 目录，包含 `metadata.json`、`transcript.txt`、`summary.md`；Whisper 模式还包含 `audio.wav` 与 `transcript.json`。工具只返回产物路径和短摘要，不把完整 transcript 塞进工具返回。不会保留原视频文件。

## 版权与责任边界

你必须自行确认对内容的访问、下载、转录和保存拥有许可，并遵守网站条款、访问控制、版权、隐私及适用法律。本插件不授予转载或再分发权，不应被用于绕过登录、付费墙、DRM 或平台限制。

## 验证

`npm test`、`npm run typecheck`、`npm run pack:check` 均不下载模型、不请求真实站点。
