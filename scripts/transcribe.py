import argparse
import json
import os
import re
import sys
import tempfile

MAX_DIAGNOSTIC_MESSAGE = 240


def is_cuda_initialization_error(error):
    message = str(error).lower()
    backend = ('cuda', 'cublas', 'cudnn', 'ctranslate2', 'gpu', 'compute type')
    failure = ('initializ', 'not available', 'out of memory', 'unsupported', 'driver', 'cannot load', 'failed to load')
    return any(marker in message for marker in backend) and any(marker in message for marker in failure)


def redacted_message(error):
    message = ' '.join(str(error).split())
    message = re.sub(r'https?://\S+', '<redacted-url>', message, flags=re.IGNORECASE)
    message = re.sub(r'[A-Za-z]:[\\/]\S+|(?:\.|/)[^ ]+', '<redacted-path>', message)
    message = re.sub(r'(?i)(token|secret|api[_ -]?key)(\s*[:=]\s*)\S+', r'\1\2<redacted>', message)
    message = re.sub(r'\b[A-Za-z0-9_-]{32,}\b', '<redacted>', message)
    return message[:MAX_DIAGNOSTIC_MESSAGE] or 'unknown error'


def emit_status(code, context, **extra):
    payload = {'event': 'transcription', 'code': code, 'context': context, **extra}
    print(json.dumps(payload, separators=(',', ':'), ensure_ascii=True), file=sys.stderr, flush=True)


def transcribe(args, device, compute_type):
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    segments, info = model.transcribe(args.audio)
    segments = list(segments)
    return {'text': ' '.join(s.text.strip() for s in segments), 'language': info.language,
            'segments': [{'start': s.start, 'end': s.end, 'text': s.text.strip()} for s in segments]}


def write_atomic(result, output_path):
    output_dir = os.path.dirname(os.path.abspath(output_path)) or '.'
    fd, temporary = tempfile.mkstemp(prefix='.transcript.json-', suffix='.tmp', dir=output_dir, text=True)
    os.close(fd)
    try:
        with open(temporary, 'w', encoding='utf8') as output:
            json.dump(result, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default='large-v3')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--compute-type', default='int8_float16')
    args = parser.parse_args()

    fallback = False
    try:
        result = transcribe(args, args.device, args.compute_type)
    except Exception as error:
        if args.device != 'cuda' or not is_cuda_initialization_error(error):
            emit_status('TRANSCRIPTION_FAILED', 'primary', message=redacted_message(error))
            return 1
        fallback = True
        emit_status('CUDA_INIT_FAILED', 'cuda', from_device='cuda', to_device='cpu', compute_type='int8')
        try:
            result = transcribe(args, 'cpu', 'int8')
        except Exception as fallback_error:
            emit_status('TRANSCRIPTION_FAILED', 'cpu_fallback', message=redacted_message(fallback_error))
            return 1

    write_atomic(result, args.output)
    if fallback:
        emit_status('CPU_FALLBACK_SUCCEEDED', 'cpu_fallback', device='cpu', compute_type='int8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
