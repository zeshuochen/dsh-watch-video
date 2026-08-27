# dsh-watch-video

面向 DeepSeek Harness 的字幕优先视频转录插件，使用确定性抽取式 Markdown 总结。它通过 `yt-dlp` 获取媒体；字幕不可用、失败或清洗后为空时，才使用 faster-whisper 的 `large-v3`。不调用外部 LLM。

## 安装

需要 Node.js 20+、Python 3.10+，并确保 `yt-dlp` 与 `ffmpeg` 在 PATH 中。运行 `npm install`，再运行 `python -m pip install -r requirements.txt`。Windows 可使用 `winget install yt-dlp.yt-dlp` 和 `winget install Gyan.FFmpeg`，也可使用系统包管理器。

运行 `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1` 会创建或复用项目 `.venv`、输出实际使用的 Python 可执行文件，并安装 Python 依赖；bootstrap 不会下载 Whisper 模型。运行 `npm run doctor` 可检查 Node.js、Python、`yt-dlp` 和 `ffmpeg`，只输出安装提示，不会泄露环境变量或凭证；`node scripts/doctor.mjs --files-only` 可执行离线的 bootstrap/依赖文件检查。显式配置的 `pythonPath` 始终优先；未配置时，Windows 优先使用 `.venv/Scripts/python.exe`，Unix 优先使用 `.venv/bin/python`，最后回退到 `python`。

## 模型首次下载

第一次真正触发 Whisper 回退时，faster-whisper/CTranslate2 会下载 `large-v3`，需要数 GB 磁盘空间。测试与 `npm run pack:check` 不下载模型，也不访问真实站点。默认优先 CUDA；如果 CUDA 初始化失败，`scripts/transcribe.py` 会自动用 CPU + `int8` 重试同一个 `large-v3` 模型。

## 配置

配置输出目录，并可选设置 `ytDlpPath`、`pythonPath`、`transcribeScript`、前置参数、`device`、`computeType`、`timeoutMs`（默认 15 分钟）和 `outputLimitBytes`（每个输出流默认 1 MiB）。`staleJobAfterMs` 默认 6 小时，范围为 5 分钟至 7 天，仅据明确过期的 heartbeat 恢复遗留任务；`heartbeatIntervalMs` 默认 30 秒，范围为 1 秒至 1 小时。Whisper 回退使用 host 进程内 FIFO 队列，由 `maxConcurrentTranscriptions` 控制；字幕任务不进入该队列，排队等待会使用任务超时并及时失败释放。产物保留配置 `retentionDays` 默认 30 天（1–3650），`maxTotalBytes` 默认 10 GiB（1–100 GiB）；两者都必须是安全正整数。`run()` 保持 `shell: false`；超时或输出超限时会终止整个进程树：Windows 使用受控的 `taskkill.exe /PID /T /F`，Unix 使用 detached 进程组发送 `SIGKILL`，并保留子进程回退。URL 必须是 HTTP(S)，不得含凭据或控制字符。`maxConcurrentTranscriptions` 默认 1，范围 1–4。

## 产物

每个任务写入 UUID 目录，包含 `metadata.json`、`transcript.txt`、`summary.md`；存在有效时间戳时还会生成 `transcript.srt`。该文件是 UTF-8 编码的 SubRip 字幕，时间格式为 `HH:MM:SS,mmm --> HH:MM:SS,mmm`，适合字幕播放器和后续编辑；如果没有有效时间戳，则不会生成 SRT，并会在 `metadata.json` 中记录原因。Whisper 模式还包含 `audio.wav` 与 `transcript.json`。工具只返回产物路径和短摘要，不把完整 transcript 塞进工具返回。不会保留原视频文件。

产物会先在目标目录写入完整 UTF-8 临时文件，再优先使用 `rename` 替换。Unix-like 系统在目标已存在时提供预期的原子替换；Windows 可能因目标已存在而拒绝 `rename`，此时插件使用兼容性的 `copyFile` 回退，但由于 Node 未公开 Windows `ReplaceFileW` 接口，不宣称严格原子覆盖。如果替换失败，插件不会先删除原目标，并会返回原始错误。

每次新任务开始前都会执行保留策略。清理会跳过当前任务、`metadata.json` 状态为 `running` 的任务、metadata 缺失或 jobId 不匹配的目录，以及 outputDir 直接子项中的符号链接。先删除超过 `retentionDays` 的已完成/失败任务；如果剩余产物总大小超过 `maxTotalBytes`，再按任务目录修改时间从旧到新删除可清理任务，直到低于上限。清理只处理 `outputDir` 直接下的任务目录，不跟随符号链接，也不会删除 outputDir 外部目标。

## 取消任务

使用 `dsh_watch_video_cancel` 并传入运行中任务的 `jobId`。取消能力只在当前 Node 进程内有效：只能取消当前进程注册的任务，`metadata.json` 不保存进程对象。正在运行的 yt-dlp 或 Whisper 会在 Windows 上通过 `taskkill.exe /PID /T /F` 终止进程树，在 Unix 上终止 detached 进程组；等待转录槽位的任务会从 FIFO 队列移除且不占用槽位。取消工具会等待清理完成，metadata 最终记录 `status: cancelled` 和用户取消原因，并清除媒体、transcript、summary、SRT 半成品及临时文件。已完成或已失败任务不会被后续取消请求再次终止。

## 查询任务

使用 `dsh_watch_video_status` 并传入 UUID `jobId` 查询单个任务，或无参数调用 `dsh_watch_video_list`，列出当前 Node.js 进程中的运行任务和保留的终态任务。状态摘要只包含 `jobId`、`status`、`phase`、`createdAt`、`updatedAt`、`method`、`progress`、`message`、`found`，不会包含 transcript、进程句柄、PID、凭证或绝对路径。除非存在可靠的有限进度值，否则 `progress` 为 `null`。不存在或已淘汰的任务返回 `found: false` 与 `status: not_found`。

支持的阶段为 `queued`、`probing_subtitles`、`downloading_audio`、`transcribing`、`writing_artifacts`、`completed`、`failed` 和 `cancelled`。当前进程按 FIFO 保留最近 1000 个 completed、failed、cancelled 终态摘要；运行任务在清理完成前单独保留。查询只读，不会启动进程或修改任务目录。先用 status/list 找到 `jobId`，再把它传给 `dsh_watch_video_cancel`；查询不会取消或重新激活任务，取消与完成仍遵守现有终态认领逻辑。

## 版权与责任边界

你必须自行确认对内容的访问、下载、转录和保存拥有许可，并遵守网站条款、访问控制、版权、隐私及适用法律。本插件不授予转载或再分发权，不应被用于绕过登录、付费墙、DRM 或平台限制。

## 验证

`npm test`、`npm run typecheck`、`npm run pack:check` 均不下载模型、不请求真实站点。

DSH 重启后，插件会依据 `staleJobAfterMs` 扫描合法任务目录，将心跳明确过期的 `running`/`cancelling` 任务标记为 `interrupted`，写入 `stale_running_job` 原因并清理不完整产物。默认阈值为 6 小时；心跳缺失、非法或未来时间会保守跳过，不会尝试恢复跨进程的实际运行状态。

子进程输出按流分别进行有界保留：`stdout` 保留前缀，`stderr` 保留末尾；限制以 UTF-8 字节为准，同时继续 drain 两个流。超时、用户取消或输出超限会清理整个进程树，并返回有界诊断信息。`maxOutputBytes` 优先于旧配置名 `outputLimitBytes`。

使用 `npm run verify:pack` 验收干净发布包：它会在临时目录中打包、解压并动态加载 tarball，不依赖源码目录或仓库 `node_modules`，不会下载 Whisper 模型，也不会访问真实视频站点。成功和失败后都会清理临时目录。