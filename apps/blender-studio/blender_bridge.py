"""Main-thread Blender mailbox: render key images and keep a real gray scene live."""
import argparse
import json
import math
from pathlib import Path
import sys
import time
import bpy
from mathutils import Vector

p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True)
args=p.parse_args(sys.argv[sys.argv.index('--')+1:]);root=args.runtime.resolve()
sys.path.insert(0,str(Path(__file__).parent))
from director import DEFAULT, validate
scene=bpy.context.scene
scene.name='CONVERSATIONAL EFFECTS / ASTRA + H3 MAX'
seen=0;clip=None;clip_start=0;clip_area=None;source=None;window=bpy.context.window


def box(name, location, size):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location)
    o=bpy.context.object;o.name=name;o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bevel=o.modifiers.new('Rounded edges','BEVEL');bevel.width=.04;bevel.segments=2
    o.color=(.58,.58,.58,1)
    return o


def build(settings, old):
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    length,width,height=settings['length'],settings['width'],settings['height']
    # Each floor half has its own outer hinge; animation is driven by actual geometry.
    for side in [-1,1]:
        bpy.ops.object.empty_add(location=(side*width/2,0,0))
        hinge=bpy.context.object;hinge.name='Floor hinge'
        for i in range(12):
            tile=box('Hinged floor panel',(side*width/4,(i+.5)*length/12,.0),(width/2-.02,length/12-.03,.16))
            tile.parent=hinge;tile.matrix_parent_inverse=hinge.matrix_world.inverted()
        for frame,amount in [(1,old['floor_fold']),(120,settings['floor_fold'])]:
            hinge.rotation_euler.y=side*math.radians(amount);hinge.keyframe_insert(data_path='rotation_euler',frame=frame)
    for side in [-1,1]:
        for i in range(9):
            y=(i+.5)*length/9
            box('Masonry pier',(side*width/2,y,height/2),(.28,.32,height))
            box('Wall sill',(side*width/2,y,.5),(.2,length/9-.3,.9))
            bpy.ops.object.empty_add(location=(0,0,0));frame_root=bpy.context.object;frame_root.name='Floating window frame'
            for z in [1,height-.5]:
                o=box('Window horizontal',(side*width/2,y,z),(.18,length/9-.4,.13));o.parent=frame_root
            for dy in [-(length/9-.4)/2,0,(length/9-.4)/2]:
                o=box('Window mullion',(side*width/2,y+dy,height/2+.25),(.18,.09,height-1.5));o.parent=frame_root
            for frame,value in [(1,old['window_float']),(120,settings['window_float'])]:
                frame_root.location.x=-side*value;frame_root.keyframe_insert(data_path='location',frame=frame)
    for i in range(12):
        o=box('Lifting ceiling panel',(0,(i+.5)*length/12,height),(width+.3,length/12-.1,.16))
        for frame,value in [(1,old['ceiling_lift']),(120,settings['ceiling_lift'])]:
            o.location.z=height+value;o.keyframe_insert(data_path='location',frame=frame)
    box('Rear wall',(0,length+.15,height/2),(width+.4,.3,height))
    for x in [-.9,.9]:box('Door frame',(x,length-.08,1.3),(.14,.15,2.6))
    box('Door lintel',(0,length-.08,2.65),(1.94,.15,.14))
    bpy.ops.object.camera_add(location=(.15,-3,2.3))
    camera=bpy.context.object;camera.rotation_euler=(Vector((0,length*.58,2.2))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.lens=22;camera.data.show_passepartout=True;camera.data.passepartout_alpha=1;scene.camera=camera
    scene.render.engine='BLENDER_WORKBENCH';scene.render.resolution_x=960;scene.render.resolution_y=540;scene.render.resolution_percentage=100
    shade=scene.display.shading;shade.light='STUDIO';shade.color_type='SINGLE';shade.single_color=(.58,.58,.58)
    shade.show_shadows=True;shade.show_cavity=True;shade.cavity_type='BOTH';shade.background_type='WORLD'
    scene.world.color=(.07,.07,.07);scene.view_settings.view_transform='Standard'
    scene.render.image_settings.file_format='JPEG';scene.render.image_settings.quality=90
    scene.frame_start=1;scene.frame_end=120;scene.render.fps=24
    scene.frame_set(1)
    if source:
        space=source.spaces.active;space.region_3d.view_perspective='CAMERA';space.region_3d.view_camera_zoom=0
        space.overlay.show_overlays=False;space.shading.type='SOLID';space.shading.color_type='SINGLE';space.shading.single_color=(.58,.58,.58)
    return settings


current=build(DEFAULT,DEFAULT)
animation_start=time.perf_counter()


def tick():
    global seen,current,clip,clip_start,animation_start
    try:
        mailbox=root/'command.json'
        if mailbox.exists():
            command=json.loads(mailbox.read_text())
            if command['revision']>seen:
                seen=command['revision'];job=root/str(seen);job.mkdir(exist_ok=True)
                try:
                    plan=validate(dict(message='Scene update',scene=command['scene']))
                    before=current;current=build(plan['scene'],before);start=time.perf_counter()
                    for frame,name in [(1,'start'),(60,'middle'),(120,'end')]:
                        scene.frame_set(frame);scene.render.filepath=str(job/f'{name}.jpg');bpy.ops.render.render(write_still=True)
                    bpy.ops.wm.save_as_mainfile(filepath=str(job/'scene.blend'))
                    (job/'ready.json').write_text(json.dumps(dict(revision=seen,capture_seconds=time.perf_counter()-start)))
                    animation_start=time.perf_counter()
                except Exception as exc:
                    (job/'error.json').write_text(json.dumps({'error':type(exc).__name__}))
        scene.frame_set(1+int((time.perf_counter()-animation_start)*24)%120)
        video=root/'video.json'
        if video.exists() and clip_area:
            v=json.loads(video.read_text())
            if not clip or clip.filepath!=v['path']:
                clip=bpy.data.movieclips.load(v['path'],check_existing=True);clip_area.spaces.active.clip=clip;clip_start=time.perf_counter()
                region=next(r for r in clip_area.regions if r.type=='WINDOW')
                with bpy.context.temp_override(window=window,area=clip_area,region=region):bpy.ops.clip.view_all(fit_view=True)
            clip_area.spaces.active.clip_user.frame_current=1+int((time.perf_counter()-clip_start)*clip.fps)%max(1,clip.frame_duration)
            clip_area.tag_redraw()
        if source:source.tag_redraw()
    except Exception as exc:
        (root/'bridge-error.txt').write_text(type(exc).__name__)
    return 1/24


def configure():
    global source,clip_area
    views=sorted([a for a in window.screen.areas if a.type=='VIEW_3D'],key=lambda a:a.x)
    if len(views)==1:
        with bpy.context.temp_override(window=window,area=views[0]):bpy.ops.screen.area_split(direction='VERTICAL',factor=.5)
        return .3
    source=views[0];clip_area=views[1];clip_area.type='CLIP_EDITOR'
    clip_area.spaces.active.show_region_ui=False;clip_area.spaces.active.show_region_toolbar=False
    space=source.spaces.active;space.region_3d.view_perspective='CAMERA';space.overlay.show_overlays=False
    space.shading.color_type='SINGLE';space.shading.single_color=(.58,.58,.58)
    (root/'blender-ready.json').write_text(json.dumps({'ready':True}))
    bpy.app.timers.register(tick,first_interval=.1)
    return None

bpy.app.timers.register(configure,first_interval=.4)
