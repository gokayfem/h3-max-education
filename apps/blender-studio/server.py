"""Local conversational studio. Run with Python; Codex and Blender stay local."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlparse

from director import DEFAULT, SCHEMA, prompt, validate

HERE=Path(__file__).resolve().parent
ENDPOINT='https://fal.run/minimax/h3-max/reference-to-video'


def atomic(path,value):
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(value),encoding='utf-8');os.replace(temporary,path)


class Studio:
    def __init__(self,runtime,key,codex):
        self.root=runtime;self.key=key;self.codex=codex;self.lock=threading.RLock()
        self.pool=ThreadPoolExecutor(max_workers=2)
        self.state=dict(revision=0,status='ready',message='Describe a change to the hallway.',scene=DEFAULT.copy(),video=None,images=[],timings={})
        self.history=[]

    def latest(self,revision):
        with self.lock:return revision==self.state['revision']

    def update(self,revision,**fields):
        with self.lock:
            if self.latest(revision):self.state.update(fields)

    def submit(self,instruction):
        with self.lock:
            revision=self.state['revision']+1;previous=self.state['scene'].copy()
            self.state.update(revision=revision,status='directing',message='Astra is planning the scene edit.',error=None)
        self.pool.submit(self.work,revision,instruction,previous)
        return revision

    def work(self,revision,instruction,previous):
        job=self.root/str(revision);job.mkdir(exist_ok=True);start=time.perf_counter()
        try:
            schema=job/'schema.json';schema.write_text(json.dumps(SCHEMA))
            result=job/'plan.json'
            # The authenticated local Codex runtime returns bounded JSON, never executable code.
            environment={k:v for k,v in os.environ.items() if k not in {'FAL_KEY','OPENAI_API_KEY'}}
            process=subprocess.Popen([self.codex,'exec','--ignore-user-config','--ephemeral','--skip-git-repo-check',
                '--sandbox','read-only','--model','gpt-6-astra','-c','model_reasoning_effort="low"',
                '--output-schema',str(schema),'--output-last-message',str(result),'-'],
                cwd=job,env=environment,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            process.stdin.write(prompt(instruction,previous).encode());process.stdin.close()
            deadline=time.monotonic()+150
            while process.poll() is None:
                if not self.latest(revision) or time.monotonic()>deadline:
                    process.kill();process.wait()
                    if not self.latest(revision):return
                    raise RuntimeError('Astra timed out. The previous video is still available.')
                time.sleep(.1)
            if process.returncode or not result.exists():raise RuntimeError('Astra could not produce a plan. Check local Codex login and model access.')
            plan=validate(json.loads(result.read_text(encoding='utf-8-sig')))
            if not self.latest(revision):return
            astra_seconds=time.perf_counter()-start
            self.update(revision,status='blender',message=plan['message'],scene=plan['scene'],timings={'astra_seconds':astra_seconds})
            with self.lock:
                if not self.latest(revision):return
                atomic(self.root/'command.json',dict(revision=revision,scene=plan['scene']))
            deadline=time.monotonic()+60
            while not (job/'ready.json').exists():
                if not self.latest(revision):return
                if (job/'error.json').exists():raise RuntimeError('Blender could not apply this scene update.')
                if time.monotonic()>deadline:raise RuntimeError('Blender did not respond. Check the open studio window.')
                time.sleep(.1)
            capture=json.loads((job/'ready.json').read_text())['capture_seconds']
            images=[f'/media/{revision}/{name}.jpg' for name in ['start','middle','end']]
            self.update(revision,status='generating',images=images)
            motion=[]
            for field,label in [('floor_fold','outer floor sections hinge upward'),('ceiling_lift','ceiling panels rise vertically'),('window_float','window frames float inward')]:
                if previous[field]!=plan['scene'][field]:motion.append(f"{label}, from {previous[field]} to {plan['scene'][field]}")
            motion_text='; '.join(motion) or 'The finished architecture holds still; only subtle ambient motion.'
            refs=['data:image/jpeg;base64,'+base64.b64encode((job/f'{n}.jpg').read_bytes()).decode() for n in ['start','middle','end']]
            payload=dict(duration=5,resolution='480P',aspect_ratio='16:9',prompt_expansion_mode='balanced',sync_mode=False,enable_safety_checker=True,
                reference_image_urls=refs,prompt=(
                    'One continuous fixed-camera architectural effects shot. Image 1 defines initial geometry; '
                    'Image 2 defines the midpoint; Image 3 defines final geometry. Follow this ordered geometric animation: '+motion_text+'. '
                    'The camera is completely fixed. Match the hallway perspective, openings and structural component count. '
                    'Interpret the gray guides as finished surfaces in this single consistent style from the first frame: '+plan['scene']['style']+'. '
                    'Only the specified physical geometry moves. No camera movement, style transition, gray reveal, dissolve, editing cut, extra objects or people.'))
            (job/'request-summary.json').write_text(json.dumps({'prompt':payload['prompt'],'model':ENDPOINT,'revision':revision},indent=2))
            if not self.latest(revision):return
            api_start=time.perf_counter()
            request=urllib.request.Request(ENDPOINT,data=json.dumps(payload).encode(),headers={'Authorization':'Key '+self.key,'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=120) as response:generated=json.load(response)
            api_seconds=time.perf_counter()-api_start
            if not self.latest(revision):return
            url=generated['video']['url']
            if not url.startswith('https://'):raise RuntimeError('H3 did not return a valid video.')
            with urllib.request.urlopen(url,timeout=60) as response:(job/'result.mp4').write_bytes(response.read())
            timing=dict(astra_seconds=astra_seconds,capture_seconds=capture,api_seconds=api_seconds,total_seconds=time.perf_counter()-start,provider=generated.get('timings'))
            with self.lock:
                if not self.latest(revision):return
                atomic(self.root/'video.json',dict(path=str(job/'result.mp4')))
                self.state.update(status='ready',video=f'/media/{revision}/result.mp4',timings=timing)
                self.history.append(dict(revision=revision,instruction=instruction,plan=plan,timings=timing))
                atomic(self.root/'history.json',self.history)
        except Exception as exc:
            # Never return provider response bodies, headers, credentials, or CLI stderr.
            detail=str(exc) if isinstance(exc,(RuntimeError,ValueError)) else type(exc).__name__+' during generation; no automatic retry.'
            self.update(revision,status='error',error=detail)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--env',type=Path,required=True)
    parser.add_argument('--blender',required=True)
    parser.add_argument('--port',type=int,default=4318)
    parser.add_argument('--runtime',type=Path,default=HERE/'.runtime')
    args=parser.parse_args();runtime=args.runtime.resolve();runtime.mkdir(parents=True,exist_ok=True)
    if (runtime/'history.json').exists():raise SystemExit('Use a fresh --runtime directory for a new session.')
    key=os.environ.get('FAL_KEY','')
    for line in args.env.read_text(encoding='utf-8-sig').splitlines():
        if line.strip().startswith('FAL_KEY='):key=line.split('=',1)[1].strip().strip('"\'')
    if not key:raise SystemExit('FAL_KEY is missing')
    codex=shutil.which('codex')
    if not codex:raise SystemExit('Install and sign in to Codex first')
    studio=Studio(runtime,key,codex)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def send(self,data,status=200,kind='application/json'):
            if not isinstance(data,bytes):data=json.dumps(data).encode()
            self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)))
            self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if self.headers.get('Host') not in {f'127.0.0.1:{args.port}',f'localhost:{args.port}'}:return self.send({'error':'Invalid host'},403)
            path=urlparse(self.path).path
            if path=='/':return self.send((HERE/'index.html').read_bytes(),kind='text/html; charset=utf-8')
            if path=='/api/state':
                with studio.lock:return self.send(studio.state.copy())
            if path.startswith('/media/'):
                parts=path.split('/')
                if len(parts)!=4 or not parts[2].isdigit() or parts[3] not in {'start.jpg','middle.jpg','end.jpg','result.mp4'}:return self.send({},404)
                target=runtime/parts[2]/parts[3]
                if target.is_file():return self.send(target.read_bytes(),kind=mimetypes.guess_type(target.name)[0])
            self.send({},404)
        def do_POST(self):
            if self.headers.get('Origin') not in {f'http://127.0.0.1:{args.port}',f'http://localhost:{args.port}'}:return self.send({'error':'Same-origin requests only'},403)
            if self.path!='/api/command':return self.send({},404)
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=8192:raise ValueError()
                body=json.loads(self.rfile.read(size));instruction=body['instruction']
                if not isinstance(instruction,str) or not 1<=len(instruction.strip())<=2000:raise ValueError()
                self.send({'revision':studio.submit(instruction.strip())},202)
            except (ValueError,KeyError,TypeError):self.send({'error':'Enter a short scene instruction'},400)

    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    log=open(runtime/'blender.log','w',encoding='utf-8')
    subprocess.Popen([args.blender,'--factory-startup','--window-geometry','0','0','1920','1080','--python',str(HERE/'blender_bridge.py'),'--','--runtime',str(runtime)],stdout=log,stderr=log)
    print(f'Studio ready: http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()


if __name__=='__main__':main()
