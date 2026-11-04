"""Inspect a real Icecast-client capture without external Python packages.
Reports per-second RMS above 700 Hz: speech has energy here, the original sine bed does not.
This is signal evidence, not speech recognition or a substitute for a human listening check.
"""
import subprocess,sys,array,math,json
path=sys.argv[1]
raw=subprocess.check_output(['ffmpeg','-v','error','-i',path,'-af','highpass=f=700,highpass=f=700','-ac','1','-ar','8000','-f','s16le','-'])
samples=array.array('h',raw)
levels=[]
for pos in range(0,len(samples)-8000,8000):
 block=samples[pos:pos+8000];rms=math.sqrt(sum(s*s for s in block)/len(block))/32768
 levels.append(round(20*math.log10(max(rms,1e-10)),1))
print(json.dumps({'file':path,'seconds':len(samples)/8000,'highpassRmsDbPerSecond':levels,'speechBandPresent':any(x>-38 for x in levels),'quietMusicBandAtEnd':bool(levels) and all(x<-44 for x in levels[-5:])}))
