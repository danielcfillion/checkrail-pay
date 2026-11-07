import json,sys,os
mode=sys.argv[1]; d=f'rec/{mode}'
j=json.load(open(f'{d}/frames.json')); fr=sorted(j['frames'],key=lambda x:x['t'])
lines=[]
for i,f in enumerate(fr):
    dur=(fr[i+1]['t']-f['t']) if i+1<len(fr) else 0.5
    lines.append(f"file '{f['file']}'\nduration {max(dur,0.001):.4f}")
lines.append(f"file '{fr[-1]['file']}'")
open(f'{d}/list.txt','w').write('\n'.join(lines))
t0=fr[0]['t']
print({m['name']:round(m['at'],1) for m in j['marks']}, 'span',round(fr[-1]['t']-t0,1))
