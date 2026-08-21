import argparse,json
p=argparse.ArgumentParser();p.add_argument('--audio',required=True);p.add_argument('--output',required=True);p.add_argument('--model',default='large-v3');p.add_argument('--device',default='cuda');p.add_argument('--compute-type',default='int8_float16');a=p.parse_args()
from faster_whisper import WhisperModel
m=WhisperModel(a.model,device=a.device,compute_type=a.compute_type);ss,info=m.transcribe(a.audio);ss=list(ss);json.dump({'text':' '.join(s.text.strip() for s in ss),'language':info.language,'segments':[{'start':s.start,'end':s.end,'text':s.text.strip()} for s in ss]},open(a.output,'w',encoding='utf8'),ensure_ascii=False,indent=2)
