import argparse
import json
import os
import tempfile

def is_cuda_initialization_error(error):
    message = str(error).lower()
    backend = ('cuda', 'cublas', 'cudnn', 'ctranslate2', 'gpu', 'compute type')
    failure = ('initializ', 'not available', 'out of memory', 'unsupported', 'driver', 'cannot load', 'failed to load')
    return any(marker in message for marker in backend) and any(marker in message for marker in failure)

parser = argparse.ArgumentParser()
parser.add_argument('--audio', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--model', default='large-v3')
parser.add_argument('--device', default='cuda')
parser.add_argument('--compute-type', default='int8_float16')
args = parser.parse_args()

from faster_whisper import WhisperModel

def transcribe(device, compute_type):
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    segments, info = model.transcribe(args.audio)
    segments = list(segments)
    return {'text': ' '.join(s.text.strip() for s in segments), 'language': info.language,
            'segments': [{'start': s.start, 'end': s.end, 'text': s.text.strip()} for s in segments]}

try:
    result = transcribe(args.device, args.compute_type)
except Exception as error:
    if args.device != 'cuda' or not is_cuda_initialization_error(error):
        raise
    result = transcribe('cpu', 'int8')

output_dir = os.path.dirname(os.path.abspath(args.output)) or '.'
fd, temporary = tempfile.mkstemp(prefix='.transcript.json-', suffix='.tmp', dir=output_dir, text=True)
os.close(fd)
try:
    with open(temporary, 'w', encoding='utf8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, args.output)
finally:
    if os.path.exists(temporary):
        try:
            os.unlink(temporary)
        except OSError:
            pass
