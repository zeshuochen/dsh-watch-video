# dsh-watch-video

[中文文档](README.md) | [Full Chinese documentation](README.zh.md)

Subtitle-first video transcription for DeepSeek Harness. It uses subtitles when available, falls back to faster-whisper `large-v3`, and writes transcript, SRT, summary, and metadata artifacts without retaining the original video.

## Features

- HTTP(S) video input through `yt-dlp`.
- Subtitle-first processing with Whisper fallback.
- SRT, text, JSON, Markdown summary, and metadata artifacts.
- Cancellable jobs with status and list tools.
- Windows, Linux, and macOS support with process-tree cleanup.
- No external LLM calls and no original-video retention.

## Requirements

Node.js 20+, Python 3.10+, `yt-dlp`, and `ffmpeg`. Install Node and Python dependencies, run `scripts/bootstrap.ps1`, then `npm run doctor`. The first real Whisper fallback downloads the `large-v3` model.

## Tools

- `dsh_watch_video`
- `dsh_watch_video_status`
- `dsh_watch_video_list`
- `dsh_watch_video_cancel`

## Verification

```powershell
npm run verify:pack
```

This clean-package check runs entirely offline: it does not download a Whisper model or access real video sites.

Job status and cancellation are process-local. See [README.zh.md](README.zh.md) for full configuration and platform details.
