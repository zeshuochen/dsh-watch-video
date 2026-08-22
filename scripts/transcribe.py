import argparse
import json

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
except Exception:
    if args.device != 'cuda':
        raise
    result = transcribe('cpu', 'int8')

with open(args.output, 'w', encoding='utf8') as output:
    json.dump(result, output, ensure_ascii=False, indent=2)
