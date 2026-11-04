"""Original synthesized PackProof demo bed. No samples, recordings, or third-party music.
Composition and synthesis created for this repository; dedicated to the public domain (CC0).
"""
import math, struct, wave, sys
from pathlib import Path
out=Path(sys.argv[1] if len(sys.argv)>1 else '.runtime/radio/media/background.wav')
out.parent.mkdir(parents=True,exist_ok=True)
sr=44100; duration=24
chords=[(130.8128,164.8138,195.9977),(110,130.8128,164.8138),(87.3071,110,130.8128),(97.9989,123.4708,146.8324)]
with wave.open(str(out),'wb') as w:
 w.setparams((2,2,sr,0,'NONE','not compressed'))
 for i in range(sr*duration):
  t=i/sr; phase=t%6; chord=chords[int(t//6)]
  envelope=min(1,phase/.8,(6-phase)/.8)*min(1,t/.8,(duration-t)/.8)
  s=sum(math.sin(2*math.pi*f*t)*.055 for f in chord)*envelope
  b=struct.pack('<hh',int(s*32767),int(s*32767));w.writeframesraw(b)
print(f'Original CC0 background bed: {out} ({duration}s, stereo PCM16, {sr} Hz)')
