# dsh-video-understand

Subtitle-first video transcription and deterministic extractive summaries for DeepSeek Harness. It uses `yt-dlp` for media access and faster-whisper `large-v3` only when subtitles are unavailable or unusable. No external LLM is called.

## Install

Requirements: Node.js 20+, Python 3.10+, `yt-dlp`, and `ffmpeg` on PATH. Run `npm install`, then `python -m pip install -r requirements.txt`. On Windows, `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg` are convenient, or use your platform package manager.

Run `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1` to create or reuse the project `.venv`, print the Python executable it uses, and install Python requirements. Bootstrap does not download the Whisper model. The configured `pythonPath` always wins; without it, the plugin prefers `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Unix, then falls back to `python`.

## First model download

The first real Whisper fallback downloads `large-v3` through faster-whisper/CTranslate2 and needs several GB of disk space. Tests and `npm run pack:check` never download models or contact a video site. CUDA is preferred by default; if CUDA initialization fails, `scripts/transcribe.py` retries `large-v3` on CPU with `int8`.

## Configuration

Configure the output directory and optionally `ytDlpPath`, `pythonPath`, `transcribeScript`, prefix arguments, `device`, `computeType`, `timeoutMs` (default 15 minutes), and `outputLimitBytes` (default 1 MiB per stream). `run()` keeps `shell: false`; timeout and output-limit cleanup terminate the whole process tree: Windows uses controlled `taskkill.exe /PID /T /F`, while Unix uses a detached process group and group `SIGKILL` with a child fallback. URLs must be HTTP(S) without credentials or control characters.

## Artifacts

Each job is stored under a UUID directory containing `metadata.json`, `transcript.txt`, and `summary.md`; Whisper jobs also contain `audio.wav` and `transcript.json`. The tool returns artifact paths and a short transcript preview, never the complete transcript. Original video files are not retained.

## Copyright and responsible use

You are responsible for permission to access, download, transcribe, and retain material. Respect site terms, access controls, copyright, privacy, and applicable law. This plugin grants no redistribution rights and must not be used to bypass authentication, paywalls, DRM, or platform restrictions.

## Verify

`npm test`, `npm run typecheck`, and `npm run pack:check` run without model downloads or real-site requests.
