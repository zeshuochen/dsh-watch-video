# dsh-watch-video

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

Each job is stored under a UUID directory containing `metadata.json`, `transcript.txt`, `summary.md`, and, when valid timestamps exist, `transcript.srt`. `transcript.srt` is a UTF-8 SubRip subtitle file using `HH:MM:SS,mmm --> HH:MM:SS,mmm` timestamps, suitable for subtitle players and downstream editing. Whisper jobs also contain `audio.wav` and `transcript.json`. When no valid timestamps are available, no SRT file is generated and `metadata.json` records the reason. The tool returns artifact paths and a short transcript preview, never the complete transcript. Original video files are not retained.

Artifact replacement writes a complete UTF-8 temporary file in the target directory and uses `rename` first. Unix-like systems provide the intended atomic replacement when the target exists. Windows may reject `rename` when the target exists; in that case the plugin uses a compatibility `copyFile` fallback and does not claim strict atomic replacement because Node does not expose the Windows `ReplaceFileW` API. If replacement fails, the existing target is not deleted by the plugin and the original error is returned.

Before each new job, the plugin applies the retention policy. It skips the current job, jobs whose `metadata.json` status is `running`, directories with invalid or mismatched metadata, and top-level symbolic links. Completed or failed jobs older than `retentionDays` are removed first; if the remaining artifacts exceed `maxTotalBytes`, eligible jobs are then removed from oldest to newest until under the limit. Cleanup only removes job directories directly inside `outputDir` and never follows symbolic links, so paths outside `outputDir` are protected.

## Cancelling jobs

Use `dsh_watch_video_cancel` with the running job's `jobId`. Cancellation is process-local: only jobs registered in the current Node process can be cancelled, and no process handles are stored in `metadata.json`. Active yt-dlp or Whisper process trees are terminated using `taskkill.exe /PID /T /F` on Windows or the detached process group on Unix. A job waiting for a transcription slot is removed from the FIFO queue without consuming a slot. Cancelled jobs finish cleanup before the tool returns, record `status: cancelled` and a user cancellation reason, and remove partial media, transcript, summary, SRT, and temporary files. Completed and failed jobs are not terminated by later cancellation requests.

## Querying jobs

Use `dsh_watch_video_status` with a UUID `jobId` to read one task, or call `dsh_watch_video_list` with no parameters to list running tasks and retained terminal tasks in the current Node.js process. Status summaries contain only `jobId`, `status`, `phase`, `createdAt`, `updatedAt`, `method`, `progress`, `message`, and `found`; they never include transcripts, process handles, PIDs, credentials, or absolute paths. `progress` is `null` unless a reliable bounded value is available. Unknown or evicted jobs return `found: false` and `status: not_found`.

The supported phases are `queued`, `probing_subtitles`, `downloading_audio`, `transcribing`, `writing_artifacts`, `completed`, `failed`, and `cancelled`. The process keeps the latest 1000 completed, failed, or cancelled summaries in FIFO order; active tasks are kept separately until cleanup finishes. Querying is read-only and does not start a process or touch the job directory. Call `dsh_watch_video_status` or `dsh_watch_video_list` first to find a `jobId`, then pass that ID to `dsh_watch_video_cancel`. Cancellation and completion use the existing terminal-state claim logic, so querying cannot cancel or revive a task.

## Copyright and responsible use

You are responsible for permission to access, download, transcribe, and retain material. Respect site terms, access controls, copyright, privacy, and applicable law. This plugin grants no redistribution rights and must not be used to bypass authentication, paywalls, DRM, or platform restrictions.

## Verify

`npm test`, `npm run typecheck`, and `npm run pack:check` run without model downloads or real-site requests.