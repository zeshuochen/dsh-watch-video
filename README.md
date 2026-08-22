# dsh-video-understand

Subtitle-first video transcription and deterministic extractive summaries for DeepSeek Harness. It uses `yt-dlp` for media access and faster-whisper `large-v3` only when subtitles are unavailable or unusable. No external LLM is called.

## Install

Requirements: Node.js 20+, Python 3.10+, `yt-dlp`, and `ffmpeg` on PATH. Run `npm install`, then `python -m pip install -r requirements.txt`. On Windows, `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg` are convenient, or use your platform package manager.

Run `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1` to create or reuse the project `.venv`, print the Python executable it uses, and install Python requirements. Bootstrap does not download the Whisper model. Run `npm run doctor` to check Node.js, Python, `yt-dlp`, and `ffmpeg`; it prints installation hints without exposing environment variables or credentials. Use `node scripts/doctor.mjs --files-only` for an offline bootstrap/dependency file check. The configured `pythonPath` always wins; without it, the plugin prefers `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Unix, then falls back to `python`.

## First model download

The first real Whisper fallback downloads `large-v3` through faster-whisper/CTranslate2 and needs several GB of disk space. Tests and `npm run pack:check` never download models or contact a video site. CUDA is preferred by default; if CUDA initialization fails, `scripts/transcribe.py` retries `large-v3` on CPU with `int8`.

## Configuration

Configure the output directory and optionally `ytDlpPath`, `pythonPath`, `transcribeScript`, prefix arguments, `device`, `computeType`, `timeoutMs` (default 15 minutes), and `outputLimitBytes` (default 1 MiB per stream). Whisper fallback uses the host-process FIFO queue controlled by `maxConcurrentTranscriptions`; subtitle jobs do not enter this queue, and queue waits time out with the job timeout. `run()` keeps `shell: false`; timeout and output-limit cleanup terminate the whole process tree: Windows uses controlled `taskkill.exe /PID /T /F`, while Unix uses a detached process group and group `SIGKILL` with a child fallback. URLs must be HTTP(S) without credentials or control characters.

| Setting | Default | Valid range |
| --- | ---: | --- |
| `timeoutMs` | 900000 | 1 to 86400000, safe integer |
| `outputLimitBytes` | 1048576 | 1 to 67108864, safe integer |
| `maxDurationSeconds` | 3600 | 1 to 86400, safe integer |
| `maxFileBytes` | 524288000 | 1 to 10737418240, safe integer |
| `maxOutputBytes` | 1048576 | 1 to 67108864, safe integer |
| `retentionDays` | 30 | 1 to 3650, safe integer |
| `maxTotalBytes` | 10737418240 | 1 to 107374182400, safe integer |
| `maxConcurrentTranscriptions` | 1 | 1 to 4, safe integer |

Invalid resource values fail before a job directory or external process is started. Whisper requires `transcript.json` to be an object with non-empty string `text`; when present, `segments` must be an array whose entries contain numeric `start`/`end` and string `text`.

## Artifacts

Each job is stored under a UUID directory containing `metadata.json`, `transcript.txt`, and `summary.md`; Whisper jobs also contain `audio.wav` and `transcript.json`. The tool returns artifact paths and a short transcript preview, never the complete transcript. Original video files are not retained.

Before each new job, the plugin applies the retention policy. It skips the current job, jobs whose `metadata.json` status is `running`, directories with invalid or mismatched metadata, and top-level symbolic links. Completed or failed jobs older than `retentionDays` are removed first; if the remaining artifacts exceed `maxTotalBytes`, eligible jobs are then removed from oldest to newest until under the limit. Cleanup only removes job directories directly inside `outputDir` and never follows symbolic links, so paths outside `outputDir` are protected.

## Copyright and responsible use

You are responsible for permission to access, download, transcribe, and retain material. Respect site terms, access controls, copyright, privacy, and applicable law. This plugin grants no redistribution rights and must not be used to bypass authentication, paywalls, DRM, or platform restrictions.

## Verify

`npm test`, `npm run typecheck`, and `npm run pack:check` run without model downloads or real-site requests.