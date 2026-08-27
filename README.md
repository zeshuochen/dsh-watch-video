# dsh-watch-video

[English](README.en.md) | [完整中文文档](README.zh.md)

面向 DeepSeek Harness 的字幕优先视频转录插件。优先读取字幕；字幕不可用时使用 faster-whisper `large-v3`，并生成摘要与 SRT。插件不调用外部 LLM，也不保留原视频。

## 核心能力

- 支持 HTTP(S) 视频地址，使用 `yt-dlp` 获取媒体。
- 字幕优先；必要时下载音频并用 Whisper 转录。
- 输出 `transcript.txt`、`transcript.json`、`transcript.srt`、`summary.md` 和 `metadata.json`。
- 支持任务取消、状态查询、任务列表和转录并发限制。
- 支持 Windows、Linux、macOS；任务超时会清理整个进程树。
- 只保留转录所需音频与派生产物，不保留原视频。

## 安装依赖

需要 Node.js 20+、Python 3.10+、`yt-dlp` 和 `ffmpeg`。在项目目录运行：

```powershell
npm install
python -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
npm run doctor
```

首次真正使用 Whisper fallback 时，faster-whisper 会下载 `large-v3` 模型，需要数 GB 磁盘空间。测试和打包检查不会下载模型或访问真实站点。

## DSH 工具

- `dsh_watch_video`：提交视频转录任务。
- `dsh_watch_video_status`：查询单个任务状态。
- `dsh_watch_video_list`：列出当前进程中的任务。
- `dsh_watch_video_cancel`：取消运行中的任务。

任务查询和取消是当前 Node 进程内能力；DSH 重启后，旧 `jobId` 不再可查询。

## 安全边界

只接受不含凭证和控制字符的 HTTP(S) 地址；不绕过登录、付费墙、DRM 或平台限制。外部进程使用参数数组和 `shell: false`。请确认你对内容拥有访问、下载、转录和保存权限。

## 验证

```powershell
npm test
npm run typecheck
npm run pack:check
node scripts/doctor.mjs --files-only
```

完整配置、产物协议、取消语义和平台边界见 [README.zh.md](README.zh.md)。
