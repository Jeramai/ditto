#!/usr/bin/env python3
"""Re-apply the Ditto edits to the pristine files in original/.

Every tunable number lives in the blocks below. Edit one, re-run, reload.
"""
import base64
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "original"


def n(v):
    return f"{v:.6g}"


def stamp(name):
    import hashlib
    return f"{name}?v={hashlib.sha256((ROOT / 'assets' / name).read_bytes()).hexdigest()[:8]}"

# --- the body: the real X/Y model baked by make_model.py (body+eye+mouth) -----
MODEL = json.loads((ROOT / "ditto-model.json").read_text())
BODY_HALF_W = MODEL["extents"]["half_width"]
BODY_H = MODEL["extents"]["height"]
CAGE_Y0 = MODEL["extents"]["y0"]
MODEL_BIN = "ditto-model.bin"
SETTLE_STEPS = 900

# --- the face ----------------------------------------------------------------
# Two dot eyes and one thin line mouth, the way the official art draws them.
# X ratios are of the body half width, Y ratios of the body height.
# The face DRAPES onto the front surface, so the eyes and mouth must sit on the
# front bulge, which runs cleanly to 0.61 of the height before breaking into
# the gap under Ditto's top bumps. The model's own decal meshes sit at 0.767
# (eyes) and 0.690 (mouth) -- up in that gap, where a draped detail lands on
# his back instead. So place them by eye on the front bulge, eyes above mouth,
# both well inside the clean zone. X spacing and feature sizes stay hand-set.
EYE_AT_X, EYE_AT_Y, EYE_R_AT, EYE_FLAT = 0.191, 0.60, 0.024, 0.364
MOUTH_AT_W, MOUTH_AT_Y = 0.33, 0.49
# Ditto's mouth is very nearly straight. A bigger lift reads as a grin.
MOUTH_LIFT_AT, MOUTH_THICK_AT = 0.02, 0.04
EYE_SOB_AT, EYE_LAUGH_AT = 2.0, 0.6364

EYE_X = BODY_HALF_W * EYE_AT_X
EYE_Y = CAGE_Y0 + BODY_H * EYE_AT_Y
EYE_RX = EYE_RY = BODY_HALF_W * EYE_R_AT
EYE_RZ = EYE_RX * EYE_FLAT
EYE_SOB_SHIFT, EYE_LAUGH_LIFT = EYE_RX * EYE_SOB_AT, EYE_RX * EYE_LAUGH_AT

MOUTH_W = BODY_HALF_W * MOUTH_AT_W
MOUTH_Y = CAGE_Y0 + BODY_H * MOUTH_AT_Y
MOUTH_LIFT, MOUTH_THICK = MOUTH_W * MOUTH_LIFT_AT, MOUTH_W * MOUTH_THICK_AT

# The mouth interior only exists while Ditto laughs. It sits under the line.

# The engine only spatial-hashes face triangles inside a fixed window, sized
# for the original 7.5 cm jelly. A smaller Ditto needs it lower, or a wide
# expression samples outside the index and throws.
FACE_WINDOW_X, FACE_WINDOW_Y = 0.03, (0.008, 0.058)

EYE_COLOR = "#2a2430"
MOUTH_COLOR = "#3b3140"
FACE_ROUGHNESS = 0.52

# --- the body ----------------------------------------------------------------
FORMS = {
    "ditto": ("#c99ae2", (7.4, 15.8, 4.2)),
    "shiny": ("#79c2ec", (19.5, 8.0, 2.2)),
}
DEFAULT_FORM = "ditto"
# Matte, near-opaque goo. A low env intensity keeps the room out of the skin.
ROUGHNESS, THICKNESS, DISPERSION = 0.55, 0.035, 0.0
TRANSMISSION, CLEARCOAT, ENV_INTENSITY = 0.0, 0.0, 0.55

# --- the ground --------------------------------------------------------------
# One 16 px tile of the sheet covers this much world, so a 128 px sheet
# (8 tiles) repeats every 8 * TILE_UNITS. Ditto is about one tile wide.
TILE_UNITS = 0.04
GRASS_TILES = 64       # sheet is GRASS_TILES x GRASS_TILES tiles
GRASS_ROUGHNESS = 0.62
# Octopath-style upright sprites: one tile-sized sprite per tuft cell of the
# floor's noise pattern, each turning to face the camera.
BLADE_R, BLADE_TALL, BLADE_NEAR = 0.8, 0.030, 0.012
# Sprites under Ditto squash while he rests on them, and stay squashed for a
# while after he moves on, so you can see where he has been.
TRAMPLE_IN, TRAMPLE_OUT, TRAMPLE_LOW = 0.030, 0.078, 0.14
TRAIL_LIFE, TRAIL_STEP, TRAIL_MAX = 7.0, 0.009, 260
GRASS_LAYOUT = json.loads((ROOT / "grass_layout.json").read_text())
HAZE = "#c8d6b0"
LOAD_BG, LOAD_INK = "#c7e3d1", "#5c6f63"

# --- the light ---------------------------------------------------------------
# The engine normalises whatever HDR it is given onto one canonical key-light
# direction, so the sun's height is this constant, not the sky map. 20 degrees
# reads as early morning and throws a long shadow.
SUN_ELEV, SUN_BEARING = 20.0, -57.5
SUN_VEC = (-0.7925, 0.3420, 0.5049)
# The shipped scene is lit entirely by a nursery-room HDR, which is why an
# outdoor field came out flat and indoor-looking. Keep a little of it for fill,
# and add a sun plus a sky/ground hemisphere. The sun points along c.incoming,
# the same direction the shadow renderer already projects along, so the lit
# side and the shadow agree.
ENV_FILL = 0.26
SUN_COLOR, SUN_INTENSITY = "#ffd8b4", 2.5
SKY_COLOR, GROUND_COLOR, SKY_INTENSITY = "#cdd6f2", "#6a6350", 0.95
NEAREST, NEAREST_MIPMAP_NEAREST, NEAREST_MIPMAP_LINEAR = 1003, 1004, 1005

# --- the easter egg ----------------------------------------------------------
# Type CONGA_WORD and Ditto does the conga, after matias.me/nsfw. The tempo and
# the first downbeat were measured off the track by onset autocorrelation, and
# the hops read the audio clock so they stay on the beat if a frame drops.
# He breathes: a slow vertical push on the cage, weighted so his top rises and
# his base stays planted. It is a force on the cage, never an edit to the
# surface, so the grab bindings stay exact. Keep the acceleration well under
# gravity (2.4) and apply it once per frame: injecting per substep excited the
# body's own modes and read as a vibration, not a breath.
BREATH_HZ, BREATH_ACCEL = 0.22, 1.6
BREATH_SWAY, BREATH_WANDER = 0.16, 0.021
SHINY_ODDS = 4096         # the real odds, rolled once per visit
INTRO_DWELL_MS = 620      # the box stays readable after the entrance lands
INTRO_MIN_MS = 1900      # the loading screen never flashes past faster than this
INTRO_CAP_MS = 3200     # a backgrounded tab has no frames, so never gate on them forever
CONGA_WORD = "conga"
NAME_EN, NAME_JA = "Ditto", "メタモン"
CREDITS = [
    ("Ditto", "Pok&eacute;mon / Game Freak", ""),
    ("The conga, and the dancing sprite", "matias.me/nsfw", "https://matias.me/nsfw/"),
    ("Music", "&ldquo;Conga&rdquo; &mdash; Gloria Estefan and Miami Sound Machine",
     "https://www.youtube.com/watch?v=54ItEmCnP80"),
    ("Built by", "Jeramai Faber", "https://jeramai.github.io"),
]
CREDIT_ROWS = "".join(
    f'<li><span>{role}</span><a href="{url}" target="_blank" rel="noreferrer">{who}</a></li>'
    if url else f"<li><span>{role}</span><em>{who}</em></li>"
    for role, who, url in CREDITS
)
EYEBROW_EN, EYEBROW_JA = "the transform pokémon", "へんしんポケモン"
CONGA_BEAT, CONGA_OFFSET = 0.4902, 0.0   # the file now starts on the downbeat
CONGA_HOP_BEATS = 2
CONGA_DRIFT, CONGA_STRIDE, CONGA_VOLUME = 0.35, 0.62, 0.5
# One favicon frame per quarter beat, so the tab sways with the track.
FAVICON_MS = round(CONGA_BEAT / 4 * 1000)

# --- the interface -----------------------------------------------------------
HUE = {
    "394028": "453449", "414b34": "4b3750", "4e573b": "57405c",
    "54682d": "8d4b84", "526632": "8d4b84", "6d725f": "6d5f72",
    "799342": "a4569b", "7d9b42": "b06fa8", "82a347": "b0679f",
    "a6c966": "e0a6d6", "e6f4b5": "fbe0f6", "b8cf8d": "dfaed6",
    "57752f": "9b5a92", "68823c": "a4569b", "7c9638": "a4569b",
    "e8d9c3": "a9d9bd",
}
NAME_CSS = (
    "#name{all:unset;pointer-events:auto;cursor:pointer;font:inherit;color:inherit;display:inline}"
    "#name:hover{opacity:.72}"
    "#name span{color:var(--ditto,#c99ae2)}"
    # 9px at the shipped opacity is 3.3:1 on the field; 4.5:1 is the floor
    ".eyebrow{color:#3f4a44;opacity:1}"
    # The touch controls carried a fixed pink from the hue map. Point them at
    # the same --ditto property the masthead dot uses, so they follow the form.
    ".joystick-knob{background:color-mix(in srgb,var(--ditto,#c99ae2) 78%,transparent)}"
    ".touch-controls button.held{background:color-mix(in srgb,var(--ditto,#c99ae2) 70%,transparent)}"
)

_sprite = base64.b64encode((ROOT / "assets/favicon-0.png").read_bytes()).decode()
_star = base64.b64encode((ROOT / "assets/star.png").read_bytes()).decode()

LOADING_CSS = (
    # A Gen-3 battle intro: two flashes, blinds close and open, the arena and
    # the foe slide in, then the text box rises and holds the load status.
    f"#loading{{background:{LOAD_BG};overflow:hidden}}"
    ".intro{position:absolute;inset:0;animation:.14s steps(1) 2 flash;"
    "animation-play-state:paused}"
    "@keyframes flash{0%,49%{filter:none}50%,99%{filter:invert(1) hue-rotate(180deg)}}"
    ".blinds{position:absolute;inset:0;display:grid;pointer-events:none}"
    ".blinds i{background:#2f3a34;transform:scaleX(0);transform-origin:left;"
    "animation:.52s cubic-bezier(.4,0,.2,1) both blind;animation-play-state:paused}"
    ".blinds i:nth-child(2n){transform-origin:right}"
    + "".join(
        f".blinds i:nth-child({k + 1}){{animation-delay:{0.22 + k * 0.022:.3f}s}}"
        for k in range(8)
    )
    + "@keyframes blind{0%{transform:scaleX(0)}45%{transform:scaleX(1)}"
    "55%{transform:scaleX(1)}100%{transform:scaleX(0)}}"
    # the arena: a shadowed pad with the pixel Ditto bobbing on it
    # justify-items, or the 96px sprite sits at the left edge of the 132px pad
    # track and reads as off-centre
    ".arena{position:absolute;inset:0;display:grid;place-content:center;"
    "justify-items:center;gap:0;opacity:0;animation:.34s ease-out .46s both fadein;"
    "animation-play-state:paused}"
    "@keyframes fadein{from{opacity:0}to{opacity:1}}"
    ".pad{width:132px;height:34px;border-radius:50%;"
    f"background:radial-gradient(closest-side,#8fc7a4 0,#7bb994 68%,{LOAD_BG} 100%);"
    "box-shadow:0 6px 14px #4b755f22;transform:scale(.6);"
    "animation:.34s cubic-bezier(.2,1.5,.4,1) .48s both padin;animation-play-state:paused}"
    "@keyframes padin{from{transform:scale(.6)}to{transform:scale(1)}}"
    ".foe{width:96px;height:96px;margin:-96px 0 0;"
    f"background:url(data:image/png;base64,{_sprite}) center/contain no-repeat;"
    "image-rendering:pixelated;"
    "animation:.72s cubic-bezier(.2,.8,.25,1) .46s both foein,"
    "1.3s ease-in-out 1.18s infinite bob;animation-play-state:paused}"
    "@keyframes foein{"
    "0%{transform:translateX(150%) translateY(-9%) scale(.94,1.05)}"
    "62%{transform:translateX(-4%) translateY(0) scale(1.03,.96)}"
    "82%{transform:translateX(1.5%) scale(.98,1.03)}"
    "100%{transform:translateX(0) scale(1,1)}}"
    "@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}"
    # the text box
    ".box{position:absolute;left:50%;bottom:clamp(18px,5vh,46px);"
    "translate:-50% 0;width:min(430px,88vw);text-align:left;"
    "background:#fbf8f2;border:3px solid #2f3a34;border-radius:7px;"
    "box-shadow:0 0 0 3px #fbf8f2,0 10px 20px #2f3a3420;"
    "padding:13px 16px 14px;"
    "animation:.32s cubic-bezier(.2,1.4,.4,1) .92s both boxin;animation-play-state:paused}"
    "@keyframes boxin{from{translate:-50% 130%}to{translate:-50% 0}}"
    ".box h2{margin:0;font:600 15px/1.25 ui-sans-serif,-apple-system,sans-serif;"
    "letter-spacing:.02em;color:#2f3a34;text-transform:none}"
    f"#load-message{{margin:7px 0 0;color:{LOAD_INK};font-size:11px;"
    "letter-spacing:.04em}"
    "#load-message::after{content:\"\\25bc\";margin-left:7px;color:#2f3a34;"
    "animation:.8s steps(1) infinite blink;animation-play-state:paused}"
    "@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}"
    ".failed .blinds,.failed .arena{display:none}"
    ".failed .intro{animation:none}"
    "@media (prefers-reduced-motion:reduce){"
    ".intro,.blinds i,.arena,.pad,.foe,.box,#load-message::after{animation:none}"
    ".blinds i{transform:scaleX(0)}.arena{opacity:1}.pad{transform:scale(1)}}"
    # Startup blocks the main thread for ~1.5s, and CSS animations are
    # time-based: the entrance ran to completion inside that freeze with no
    # frames drawn, so it was never seen. Start paused, release on a class.
    ".intro.go,.intro.go .blinds i,.intro.go .arena,.intro.go .pad,"
    ".intro.go .foe,.intro.go .box{animation-play-state:running}"
    ".intro.go #load-message::after{animation-play-state:running}"
    # a 1-in-4096 roll deserves to be noticed. Chunky pixel stars that pop and
    # fade, the way the games do it, and the sprite takes the shiny hue.
    ".foe{position:relative}"
    ".intro.shiny .foe{filter:hue-rotate(-84deg) saturate(1.08)}"
    ".stars{position:absolute;left:50%;top:50%;width:150px;height:150px;"
    "translate:-50% -58%;pointer-events:none;display:none}"
    ".intro.shiny .stars{display:block}"
    f".stars i{{position:absolute;background:url(data:image/png;base64,{_star}) "
    "center/contain no-repeat;image-rendering:pixelated;opacity:0;"
    "animation:.62s steps(4,end) 2 both pop;animation-play-state:paused}"
    ".intro.go.shiny .stars i{animation-play-state:running}"
    ".stars i:nth-child(1){left:4%;top:22%;width:26px;height:26px;animation-delay:.50s}"
    ".stars i:nth-child(2){right:8%;top:8%;width:18px;height:18px;animation-delay:.66s}"
    ".stars i:nth-child(3){right:2%;top:46%;width:22px;height:22px;animation-delay:.82s}"
    ".stars i:nth-child(4){left:16%;top:62%;width:15px;height:15px;animation-delay:.96s}"
    "@keyframes pop{0%{opacity:0;transform:scale(.35)}"
    "40%{opacity:1;transform:scale(1)}70%{opacity:1;transform:scale(.85)}"
    "100%{opacity:0;transform:scale(.4)}}"
)

CREDITS_CSS = (
    "#credits{position:relative;border:0;border-radius:14px;padding:0;max-width:min(430px,90vw);"
    "background:#fbf8f2;color:#2f3a34;box-shadow:0 18px 44px #2f3a3433}"
    "#credits::backdrop{background:#2f3a3459;backdrop-filter:blur(2px)}"
    "#credits>*{margin:0}"
    ".credits-title{padding:17px 20px 0;font:600 15px/1 ui-sans-serif,-apple-system,sans-serif;"
    "letter-spacing:.02em}"
    "#credits ul{list-style:none;padding:14px 20px 4px;display:grid;gap:11px}"
    "#credits li{display:grid;gap:2px;font-size:12px}"
    "#credits li span{font-size:9px;text-transform:uppercase;letter-spacing:.14em;"
    "color:#6b7a70}"
    "#credits a{color:#8d4b84;text-decoration-thickness:.5px;text-underline-offset:2px}"
    "#credits em{font-style:normal}"
    ".credits-note{padding:8px 20px 18px;font-size:10px;line-height:1.5;color:#6b7a70}"
    "#credits-close{position:absolute;top:9px;right:9px;width:28px;height:28px;padding:0;"
    "display:grid;place-items:center;border:0;border-radius:8px;background:transparent;"
    "color:#6b7a70;cursor:pointer}"
    "#credits-close:hover{background:#2f3a3414;color:#2f3a34}"
    "#credits-close svg{width:15px;height:15px}"
    ".credits-title{padding-right:44px}"
)



HEIGHT_CM = round(BODY_H * 100)


def apply(text, pairs, label):
    for old, new in pairs:
        found = text.count(old)
        if found != 1:
            sys.exit(f"{label}: expected 1 match, found {found} for {old[:70]!r}")
        text = text.replace(old, new)
    return text


forms = ",".join(
    f"{k}:{{surface:`{c}`,absorption:[{a[0]},{a[1]},{a[2]}]}}" for k, (c, a) in FORMS.items()
)

# The mouth is a stroke of constant thickness whose tips lift very slightly.
_T, _L, _W = MOUTH_THICK / 2, MOUTH_LIFT, MOUTH_W
face = (
    f"for(let e of[-1,1])o(s({n(EYE_RX)},{n(EYE_RY)},{n(EYE_RZ)}),n,"
    f"e*{n(EYE_X)},{n(EYE_Y)},1e-4,`eye`);"
    f"let c=new Ma;c.moveTo({n(-_W)},{n(_L + _T)}),"
    f"c.bezierCurveTo({n(-_W * .38)},{n(-_L / 3 + _T)},"
    f"{n(_W * .38)},{n(-_L / 3 + _T)},{n(_W)},{n(_L + _T)}),"
    f"c.lineTo({n(_W)},{n(_L - _T)}),"
    f"c.bezierCurveTo({n(_W * .38)},{n(-_L / 3 - _T)},"
    f"{n(-_W * .38)},{n(-_L / 3 - _T)},{n(-_W)},{n(_L - _T)}),"
    f"o(QF(new So(c,28)),r,0,{n(MOUTH_Y)},18e-5,`mouth`)"

)

# Only the cage moves. Tet rest volumes rescale by their own Jacobian ratio,
# so the solver keeps the same material and the same mass distribution.
cageviz = (
    "function dittoCage(r,b){"
    "if(!/[?&]cage/.test(location.search))return;"
    "let tets=globalThis.__dittoTets;if(!tets)return;"
    "let live=b.x||(b.kernel&&b.kernel.x);if(!live)return;"
    "let m=new Map(),add=(a,c,d)=>{let k=[a,c,d].sort((x,y)=>x-y).join(`_`),e=m.get(k);"
    "e?e.n++:m.set(k,{n:1,f:[a,c,d]})};"
    "for(let i=0;i<tets.length;i+=4){let a=tets[i],c=tets[i+1],d=tets[i+2],e=tets[i+3];"
    "add(a,c,d),add(a,c,e),add(a,d,e),add(c,d,e)}"
    "let idx=[];for(let v of m.values())if(v.n===1)idx.push(v.f[0],v.f[1],v.f[2]);"
    "let pos=new Float32Array(live.length),g=new oi;"
    "g.setAttribute(`position`,new Wr(pos,3).setUsage(ut)),"
    "g.setIndex(new Wr(new Uint32Array(idx),1));"
    "let mat=new xi({color:`#ff2ea8`,wireframe:!0,transparent:!0,opacity:.6,depthTest:!1}),"
    "mesh=new Ni(g,mat);"
    "mesh.frustumCulled=!1,mesh.renderOrder=999,r.group.add(mesh);"
    "r.cageOverlay={refresh(){for(let i=0;i<live.length;i++)pos[i]=live[i];"
    "g.attributes.position.needsUpdate=!0}},r.cageOverlay.refresh()}"
)

_bits = "".join("1" if c == "g" else "0" for row in GRASS_LAYOUT["rows"] for c in row)
_ltiles = GRASS_LAYOUT["tiles"]

grassviz = (
    "function dittoGrass(parent,loader){"
    "let tex=loader.load(new URL(`/assets/grass_tuft.webp`,``+import.meta.url).href);"
    f"tex.colorSpace=Qe,tex.magFilter={NEAREST},tex.minFilter={NEAREST_MIPMAP_LINEAR},"
    "tex.generateMipmaps=!0,tex.needsUpdate=!0;"
    f"let T={n(TILE_UNITS)},R={n(BLADE_R)},NT={_ltiles},BITS=`{_bits}`,"
    f"half=T/2,tall={n(BLADE_TALL)},near={n(BLADE_NEAR)},"
    "c=Math.ceil(R/T),cap=(2*c+1)*(2*c+1),"
    "pos=new Float32Array(cap*12),uvs=new Float32Array(cap*8),"
    "idx=new Uint32Array(cap*6);"
    "for(let i=0;i<cap;i++){"
    "uvs.set([0,0,1,0,1,1,0,1],i*8);"
    "idx.set([i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3],i*6)}"
    "let g=new oi;"
    "g.setAttribute(`position`,new Wr(pos,3).setUsage(ut)),"
    "g.setAttribute(`uv`,new Wr(uvs,2)),"
    "g.setIndex(new Wr(idx,1));"
    "let t=FF(tex,RF()),"
    f"m=new $x({{roughness:{n(GRASS_ROUGHNESS)},metalness:0,clearcoat:0,transparent:!0,side:2}});"
    "m.colorNode=t.rgb,m.opacityNode=t.a,m.alphaTestNode=xF(.5);"
    "let mesh=new Ni(g,m);mesh.frustumCulled=!1;"
    # The floor plane is snapped to Ditto's centre every frame, so a sprite
    # parented to it lags a frame behind during a drag and the whole field
    # appears to slide. Live in the scene instead and write world coordinates:
    # nothing to cancel, nothing to lag.
    "let tmp=new N,trail=new Map,marks=0,lastMark=0,here=null,"
    f"R0={n(TRAMPLE_IN)},R1={n(TRAMPLE_OUT)},LOW={n(TRAMPLE_LOW)},"
    f"LIFE={n(TRAIL_LIFE)},STEP={n(TRAIL_STEP)},MAX={TRAIL_MAX};"
    "let face=()=>{"
    "let cam=globalThis.__dittoCam;if(!cam)return;"
    "if(mesh.parent!==parent.parent&&parent.parent)parent.parent.add(mesh);"
    "parent.getWorldPosition(tmp);"
    "let px=tmp.x,pz=tmp.z,cwe=cam.matrixWorld.elements,cwx=cwe[12],cwz=cwe[14],"
    "bd=globalThis.__dittoBody,"
    "tx=bd?bd.center.x:px,tz=bd?bd.center.z:pz,down=bd?bd.grounded:!1,"
    "now=performance.now()/1000;"
    # Keep his current patch fresh while he stands still, or the one mark
    # ages out and the grass grows back under him. Only a real step adds
    # a new mark, so the buffer stays short.
    "if(down&&now-lastMark>.05){lastMark=now;"
    # refresh the time only: moving the mark with him meant walking dragged
    # one dent along instead of leaving a trail, because the distance from
    # the mark never accumulated past STEP
    "if(here&&Math.hypot(tx-here[0],tz-here[1])<=STEP)here[2]=now;"
    "else{let key=((tx/R1|0)+`,`)+(tz/R1|0),b=trail.get(key);"
    "b||trail.set(key,b=[]),here=[tx,tz,now],b.push(here),marks++;"
    "if(marks>MAX){for(let[kk,bb]of trail){"
    "let f=bb.filter(e=>now-e[2]<LIFE);f.length?trail.set(kk,f):trail.delete(kk)}"
    "marks=0}}}let "
    "i0=Math.round(px/T),j0=Math.round(pz/T),k=0;"
    "for(let dj=-c;dj<=c;dj++)for(let di=-c;di<=c;di++){"
    "let i=i0+di,j=j0+dj,"
    "row=((j%NT)+NT)%NT,col=((i%NT)+NT)%NT;"
    "if(BITS.charCodeAt(row*NT+col)!==49)continue;"
    "let wx=(i+.5)*T,wz=(j+.5)*T;"
    "if(Math.hypot(wx-px,wz-pz)>R)continue;"
    "let dx=cwx-wx,dz=cwz-wz,l=Math.hypot(dx,dz)||1;"
    "if(l<near)continue;"
    "dx/=l,dz/=l;"
    "let sq=1,cell=trail.get(((wx/R1|0)+`,`)+(wz/R1|0));"
    "for(let dj=-1;dj<2;dj++)for(let di=-1;di<2;di++){"
    "let b=trail.get(((wx/R1+di|0)+`,`)+(wz/R1+dj|0));if(!b)continue;"
    "for(let q=0;q<b.length;q++){let e=b[q],age=(now-e[2])/LIFE;"
    "if(age>=1)continue;"
    "let td=Math.hypot(wx-e[0],wz-e[1]);if(td>=R1)continue;"
    "let t=td<=R0?0:(td-R0)/(R1-R0),base=LOW+(1-LOW)*(t*t*(3-2*t)),"
    "back=age*age*(3-2*age),f=base+(1-base)*back;"
    "if(f<sq)sq=f}}"
    "let ax=-dz*half,az=dx*half,th=tall*sq,o=k*12;"
    "pos[o]=wx-ax,pos[o+1]=0,pos[o+2]=wz-az,"
    "pos[o+3]=wx+ax,pos[o+4]=0,pos[o+5]=wz+az,"
    "pos[o+6]=wx+ax,pos[o+7]=th,pos[o+8]=wz+az,"
    "pos[o+9]=wx-ax,pos[o+10]=th,pos[o+11]=wz-az,k++}"
    "g.setDrawRange(0,k*6),g.attributes.position.needsUpdate=!0};"
    "face();"
    "let tick=()=>{face(),requestAnimationFrame(tick)};requestAnimationFrame(tick);"
    "return mesh}"
)

breath = (
    "function dittoBreath(body){"
    "let x=body.x,v=body.velocity,n=x.length/3,w=new Float64Array(n),"
    "y0=Infinity,y1=-Infinity;"
    "for(let i=1;i<x.length;i+=3){if(x[i]<y0)y0=x[i];if(x[i]>y1)y1=x[i]}"
    "let h=y1-y0||1;"
    "for(let i=0;i<n;i++){let f=(x[i*3+1]-y0)/h;w[i]=f*f}"
    f"let t=Math.random()*6.283,HZ={n(BREATH_HZ)},A={n(BREATH_ACCEL)},"
    f"S={n(BREATH_SWAY)},WD={n(BREATH_WANDER)};"
    "let acc=0;"
    "return{step(dt){"
    "t+=dt;acc+=dt;if(acc<1/60)return;let sdt=acc;acc=0;"
    "let a=Math.sin(t*HZ*6.283)*A,"
    # a second, slower and off-phase sway keeps it from looking metronomic
    "b=Math.sin(t*HZ*2.1+1.7)*S,c=Math.cos(t*HZ*1.3+.4)*S;"
    "for(let i=0;i<n;i++){let k=w[i]*sdt;"
    "v[i*3+1]+=a*k,v[i*3]+=b*k*WD,v[i*3+2]+=c*k*WD}"
    "}}}"
)

conga = (
    "function dittoConga(rig,body){"
    "let audio=new Audio(new URL(`/assets/konga.mp3`,``+import.meta.url).href),"
    "knob=document.querySelector(`#sound`),"
    "muted=()=>knob?.getAttribute(`aria-pressed`)===`true`,"
    "self={on:!1,clock:0,beat:-1,"
    "step(dt){"
    "if(!self.on)return;"
    "self.clock+=dt;"
    f"let at=audio.paused?self.clock:audio.currentTime-{n(CONGA_OFFSET)},"
    f"b=Math.floor(at/{n(CONGA_BEAT)}),"
    f"th=b*Math.PI/2+at*{n(CONGA_DRIFT)};"
    f"rig.move.set(Math.sin(th),0,Math.cos(th)).multiplyScalar({n(CONGA_STRIDE)});"
    "if(b===self.beat)return;"
    f"self.beat=b,b%{CONGA_HOP_BEATS}===0&&rig.jump(),"
    "muted()?audio.paused||audio.pause()"
    ":audio.paused&&audio.play().catch(()=>{})},"
    "start(){if(self.on)return;"
    "self.on=!0,self.clock=0,self.beat=-1,"
    "muted()||(audio.currentTime=0,audio.play().catch(()=>{}))},"
    "stop(){if(!self.on)return;"
    "self.on=!1,self.clock=0,self.beat=-1,"
    "rig.move.set(0,0,0),audio.pause()},"
    "off(){self.on&&knob?.click()}};"
    f"audio.loop=!0,audio.volume={n(CONGA_VOLUME)};"
    # Every route goes through the sound button, so the dance and the sound
    # are one state and can never disagree.
    f"let typed=``,word=`{CONGA_WORD}`;"
    "window.addEventListener(`keydown`,e=>{"
    "if(e.metaKey||e.ctrlKey||e.altKey)return;"
    "if(e.target?.closest?.(`input,textarea,select,[contenteditable=\"true\"]`))return;"
    "if(e.code===`Escape`||e.code===`KeyR`){self.off();return}"
    "let k=e.key;"
    "if(!k||k.length!==1)return;"
    "typed=(typed+k.toLowerCase()).slice(-word.length),"
    "typed===word&&(typed=``,knob?.click())});"
    "return self}"
)

_runtime_src = (SRC / "runtime.js").read_text(encoding="utf-8")
_old_manifest_b64 = re.search(
    r"base64,([A-Za-z0-9+/=]+)", _runtime_src[_runtime_src.index("async function mF("):]
).group(1)
_manifest_out = {k: v for k, v in MODEL.items() if k != "extents"}
_new_manifest_b64 = base64.b64encode(json.dumps(_manifest_out).encode()).decode()

RUNTIME = [
    (
        "let n=new $x({color:`#142905`,roughness:.13,clearcoat:1,clearcoatRoughness:.06}),"
        "r=new $x({color:`#254508`,roughness:.24,clearcoat:.6}),"
        "i=new $x({color:`#b5d641`,roughness:.24,clearcoat:.5}),",
        f"let n=new $x({{color:`{EYE_COLOR}`,roughness:{n(FACE_ROUGHNESS)},clearcoat:0}}),"
        f"r=new $x({{color:`{MOUTH_COLOR}`,roughness:{n(FACE_ROUGHNESS)},clearcoat:0}}),"
        f"i=new $x({{color:`{MOUTH_COLOR}`,roughness:{n(FACE_ROUGHNESS)},clearcoat:0}}),",
    ),
    (
        "for(let e of[-1,1])o(s(.00325,.0043,.0015),n,e*.0095,.0465,1e-4,`eye`),"
        "o(s(.0043,.0024,16e-5),a,e*.014,.0388,1e-4,`blush`),"
        "o(new Eo(new da([new N(-.0021,-5e-4,0),new N(0,45e-5,0),new N(.0021,-2e-4,0)]),16,48e-5,8,!1),"
        "r,e*.0097,.0542,25e-5,`brow`);"
        "let c=new Ma;c.moveTo(-.0046,.0019),"
        "c.bezierCurveTo(-.002,6e-4,.002,6e-4,.0046,.002),"
        "c.bezierCurveTo(.0055,-.0046,-.0048,-.0052,-.0046,.0019),"
        "o(QF(new So(c,24)),r,0,.0389,18e-5,`mouth`);"
        "let l=new Ma;l.absellipse(0,0,.0024,.00125,0,Math.PI*2,!1,0),"
        "o(QF(new So(l,24)),i,0,.0368,28e-5,`tongue`)",
        "",   # the model's own eye/mouth meshes are baked into the surface now
    ),
    # Dot eyes squash to slits on a blink and arch on a laugh. The brow branch
    # is gone with the brows. The interior scales up from nothing on a laugh.
    (
        "if(u===`eye`){let e=f*.38+Math.sign(a)*(.0055*Math.abs(p/.0043)-.0028),"
        "t=p*.67+s*.35,o=m*.2,c=Math.max(i,r*.9);p*=1-c*.94,m*=1-c*.88,"
        "p+=(1-Math.min(1,(f/.00325)**2))*r*.00125,f+=(e-f)*n,p+=(t-p)*n,m+=(o-m)*n}"
        "else if(u===`brow`){let e=-Math.sign(a)*f/.0021;"
        "p+=n*(6e-4+e*.0011)+r*55e-5,p+=s*.6}"
        "else u===`mouth`||u===`tongue`?(p+=o-.0389,f*=1-n*.22+r*.18,p*=1-n*.48+c*.32,"
        "p+=n*(.0011-.003*(f/.0046)**2)+s,p-=r*3e-4,p-=o-.0389)"
        ":p+=r*65e-5+n*25e-5;",
        "if(u===`eye`){"
        f"let e=f*.38+Math.sign(a)*({n(EYE_SOB_SHIFT)}*Math.abs(p/{n(EYE_RY)})"
        f"-{n(EYE_SOB_SHIFT / 2)}),"
        "t=p*.67+s*.35,o=m*.2,c=Math.max(i,r*.9);p*=1-c*.94,m*=1-c*.88,"
        f"p+=(1-Math.min(1,(f/{n(EYE_RX)})**2))*r*{n(EYE_LAUGH_LIFT)},"
        "f+=(e-f)*n,p+=(t-p)*n,m+=(o-m)*n}"
        f"else u===`mouth`?(p+=o-{n(MOUTH_Y)},f*=1-n*.22+r*.18,p*=1-n*.48+c*.32,"
        f"p+=n*(.0011-.003*(f/{n(MOUTH_W)})**2)+s,p-=r*3e-4,p-=o-{n(MOUTH_Y)})"
        ":p+=r*65e-5+n*25e-5;",
    ),
    # Matte skin, so the room in the environment map stops showing through.
    (
        "let r=new $x({color:t[e].surface,roughness:.085,metalness:0,transmission:1,"
        "thickness:.035,ior:1.35,dispersion:.025,attenuationDistance:.035,clearcoat:.42,"
        "clearcoatRoughness:.05,envMapIntensity:1.05,",
        f"let r=new $x({{color:t[e].surface,roughness:{n(ROUGHNESS)},metalness:0,"
        f"transmission:{n(TRANSMISSION)},thickness:{n(THICKNESS)},ior:1.35,"
        f"dispersion:{n(DISPERSION)},attenuationDistance:.035,clearcoat:{n(CLEARCOAT)},"
        f"clearcoatRoughness:.05,envMapIntensity:{n(ENV_INTENSITY)},",
    ),
    # Load the baked Ditto asset in place of the jelly: new binary, new manifest.
    ("`/assets/jelly-baby-D3aoVKxe.bin`", f"`/assets/{stamp(MODEL_BIN)}`"),
    (_old_manifest_b64, _new_manifest_b64),
    (
        "o=Math.max(-.025,Math.min(t[r],t[i],t[a])),"
        "s=Math.min(.025,Math.max(t[r],t[i],t[a])),"
        "c=Math.max(.025,Math.min(t[r+1],t[i+1],t[a+1])),"
        "l=Math.min(.062,Math.max(t[r+1],t[i+1],t[a+1]))",
        f"o=Math.max({n(-FACE_WINDOW_X)},Math.min(t[r],t[i],t[a])),"
        f"s=Math.min({n(FACE_WINDOW_X)},Math.max(t[r],t[i],t[a])),"
        f"c=Math.max({n(FACE_WINDOW_Y[0])},Math.min(t[r+1],t[i+1],t[a+1])),"
        f"l=Math.min({n(FACE_WINDOW_Y[1])},Math.max(t[r+1],t[i+1],t[a+1]))",
    ),
    (
        "for(let e=0;e<80;e++)h.step(sF.step),l.step(sF.step);",
        f"for(let e=0;e<{SETTLE_STEPS};e++)h.step(sF.step),l.step(sF.step);",
    ),
    ("`Making a little jelly`", "`DITTO is transforming`"),
    ("C.follow(),d.update(i,l),", "C.follow(),"),
    ("C.update().catch(r),m.render()", "m.render()"),
    ("async function mF(){", breath + "async function mF(){"),
    # The form callback also paints the masthead dot and remembers the pick.
    # It runs once at startup too (without saving), or a remembered shiny loads
    # with the wrong dot colour.
    (
        "new n(e=>{u.setFlavor(e),d.setAbsorption(t[e].absorption)})",
        "new n(fv)",
    ),
    (
        "let _=new n(fv)",
        "let fv=e=>{u.setFlavor(e),d.setAbsorption(t[e].absorption),"
        "document.documentElement.style.setProperty(`--ditto`,t[e].surface)},"
        "_=new n(fv);"
        'fv(document.querySelector(`[data-flavor][aria-pressed="true"]`)'
        f"?.dataset.flavor||`{DEFAULT_FORM}`)",
    ),
    ("`Drawing the first frame`", "`DITTO used TRANSFORM`"),
    ("`Settling in`", "`Finding a patch of grass`"),
    ("`Compiling the material`", "`Studying its form`"),
    ("`Reading the light`", "`The sun is coming up`"),
    ("`Starting WebGPU`", "`Sending out DITTO`"),
    ("LI=new N(-.55,.76,.35).normalize()",
     f"LI=new N({n(SUN_VEC[0])},{n(SUN_VEC[1])},{n(SUN_VEC[2])}).normalize()"),
    ("`/assets/bg_room-CxfCC304.exr`", f"`/assets/{stamp('sky.exr')}`"),
    ("`Jelly baby. Use the touch joystick", "`Ditto. Use the touch joystick"),
    ("`Animated facial detail outside the jelly surface`", "`Animated facial detail outside the Ditto surface`"),
    ("`Could not load the reference jelly mesh`", "`Could not load the Ditto mesh`"),
    (
        "let s=new bs(36,1,.001,40);s.position.set(.082,.126,.19)",
        "let s=new bs(36,1,.001,40);globalThis.__dittoCam=s;s.position.set(.082,.126,.19)",
    ),
    (
        "async function mF(){",
        grassviz + "async function mF(){",
    ),
    (
        "let E=new Ni(new xo(200,200),y);return E.rotation.x=-Math.PI/2,E.position.y=-5e-5,",
        "let E=new Ni(new xo(200,200),y);return E.rotation.x=-Math.PI/2,E.position.y=-5e-5,dittoGrass(E,r),",
    ),
    (
        "async function mF(){",
        cageviz + "async function mF(){",
    ),
    (
        "update(e=0,t=!1){this.face.update(e,t)}",
        "update(e=0,t=!1){this.face.update(e,t),this.cageOverlay&&this.cageOverlay.refresh()}",
    ),
    (
        "this.group.add(this.mesh),this.face=new tI(n,this.group),this.update()}",
        "this.group.add(this.mesh),this.face=new tI(n,this.group),dittoCage(this,n),globalThis.__dittoBody=n,this.update()}",
    ),
    (
        "let f=i(`tets`),p=[];for(let",
        "let f=i(`tets`);globalThis.__dittoTets=f;let p=[];for(let",
    ),
    # The model surface has verts in cage tet-gaps (extrapolated bindings); relax
    # the grab-consistency tolerance so grabbing them does not throw.
    ("d.distanceTo(n)>2e-5", "d.distanceTo(n)>5e-3"),
    # Load the per-vertex faceTag onto the render surface.
    (
        "d.setAttribute(`opticalThickness`,new Wr(new Float32Array(a.length/3).fill(.04),1).setUsage(ut))",
        "d.setAttribute(`opticalThickness`,new Wr(new Float32Array(a.length/3).fill(.04),1).setUsage(ut)),"
        "d.setAttribute(`faceTag`,new Wr(n(`faceTag`).slice(),1))",
    ),
    # Colour the baked model face: eyes near-black, mouth dark pink, body keeps
    # its flavour colour. Matte and opaque via the tag; body stays translucent.
    (
        "r.thicknessNode=vF(`opticalThickness`,`float`)",
        "r.thicknessNode=vF(`opticalThickness`,`float`),"
        "r.colorNode=MF(vF(`faceTag`,`float`).greaterThan(.5),BF(.05,.04,.06),Q.materialColor)",
    ),
    # The ripped mesh has concavities (the saddle under Ditto's top bumps) and
    # inconsistent winding there, so front-face culling shows straight through
    # to the grass. The skin is matte (transmission 0), so double-siding it is
    # free of the usual translucency artefacts and closes the hole.
    ("transparent:!1,side:0,flatShading:!1", "transparent:!1,side:2,flatShading:!1"),
    # The face binder hashes body triangles by 2D (x,y) and, per face-detail
    # vertex, picks the frontmost by depth. It skipped any triangle whose 2D
    # winding was negative -- a jelly-specific assumption that drops one whole
    # winding. The real Ditto mesh winds the other way (its axis map is a
    # reflection), so its eyes fell over empty bins. Index every triangle with
    # real area instead; the depth pick already chooses the right one.
    (
        "if((t[i]-t[r])*(t[a+1]-t[r+1])-(t[i+1]-t[r+1])*(t[a]-t[r])<=1e-14)continue;",
        "if(Math.abs((t[i]-t[r])*(t[a+1]-t[r+1])-(t[i+1]-t[r+1])*(t[a]-t[r]))<=1e-14)continue;",
    ),
    # Ditto leaves no damp prints on a lawn. Only the drop shadow stays.
    (
        "y.colorNode=v.mul(xF(1).sub(xF(1).sub(T).mul(t.windowFraction)))"
        ".mul(xF(1).sub(_.mul(.4))).mul(xF(1).sub(w.mul(.35))),",
        "y.colorNode=v.mul(xF(1).sub(xF(1).sub(T).mul(t.windowFraction))),",
    ),
    # An opaque Ditto focuses no light, so the caustic patch under it goes.
    (
        "y.emissiveNode=v.mul(FF(e.lightTexture,u).rgb).mul(t.irradiance/Math.PI)"
        ".mul(BF(t.color.r,t.color.g,t.color.b)).mul(d).mul(xF(1).sub(C));",
        "y.emissiveNode=BF(0,0,0);",
    ),
    # A GBA route floor: one pixel sheet, nearest filtering, no wood relief.
    (
        "let r=new os,i=[new URL(`/assets/wood_base-BnLq3mVl.jpg`,``+import.meta.url).href,"
        "new URL(`/assets/wood_normal-pCUsk1GY.png`,``+import.meta.url).href,"
        "new URL(`/assets/wood_roughness-a0mBSnc7.jpg`,``+import.meta.url).href],"
        "[o,s,c]=await Promise.all(i.map(e=>r.loadAsync(e)));o.colorSpace=Qe;"
        "for(let e of[o,s,c])e.wrapS=e.wrapT=a,e.anisotropy=8;let l=AF.xz.div(2.5).add(.5),",
        "let r=new os,i=[new URL(`/assets/grass_tiles.webp`,``+import.meta.url).href],"
        "[o]=await Promise.all(i.map(e=>r.loadAsync(e)));o.colorSpace=Qe;"
        f"o.wrapS=o.wrapT=a,o.anisotropy=1,o.magFilter={NEAREST},"
        f"o.minFilter={NEAREST_MIPMAP_NEAREST},o.generateMipmaps=!0,o.needsUpdate=!0;"
        f"let l=AF.xz.div({n(TILE_UNITS * GRASS_TILES)}).add(.5),",
    ),
    (
        "y=new $x({metalness:0,roughness:.26,clearcoat:.38,clearcoatRoughness:.23})",
        f"y=new $x({{metalness:0,roughness:{n(GRASS_ROUGHNESS)},clearcoat:0}})",
    ),
    (
        "y.normalNode=EF(FF(s,l),zF(.27,-.27)),y.roughnessNode=FF(c,l).r.mul(.3).add(.12),",
        f"y.roughnessNode=xF({n(GRASS_ROUGHNESS)}),",
    ),
    ("[o,s,c].forEach(e=>e.dispose())", "[o].forEach(e=>e.dispose())"),
    # Two Gauss-Seidel sweeps, not three. The third sweep costs a third of the
    # solver and moves no measurable stability metric; the substep rate is what
    # holds the body stiff, and that stays at 240 Hz.
    ("step:1/240,iterations:3", "step:1/240,iterations:2"),
    # No trampoline and no swing. An empty registry is a no-op everywhere.
    (
        "g=new RL;g.add(new XL(o,l,f,a.facility)),g.add(new tR(o,l,f,a.facility));",
        "g=new RL,co=dittoConga(h,l),br=dittoBreath(l);",
    ),
    # Type the word and Ditto dances. The dance overrides the key-driven move,
    # so it runs straight after the input step.
    ("async function mF(){", conga + "async function mF(){"),
    (
        "v.advance(t,()=>{S.step(sF.step),",
        "v.advance(t,()=>{S.step(sF.step),co.step(sF.step),br.step(sF.step),",
    ),
    (
        "u.update(t,g.active?.laughing??!1)",
        "u.update(t,(g.active?.laughing??!1)||co.on)",
    ),
    # Sound starts off. Turning it on is what starts the conga.
    ("muted=!1;", "muted=!0;"),
    (
        "n.classList.toggle(`muted`,t),a.unlock().catch(()=>{}),",
        "n.classList.toggle(`muted`,t),a.unlock().catch(()=>{}),"
        "t?co.stop():co.start(),globalThis.dittoFavicon?.(!t),",
    ),
    (
        "x=()=>{a.stopFacilities(),g.reset(),S.recenter(),"
        "l.reset(),u.resetFace(),v.reset()}",
        "x=()=>{a.stopFacilities(),co.off(),g.reset(),S.recenter(),"
        "l.reset(),u.resetFace(),v.reset()}",
    ),
    (
        "o.background=new rr(`#e8d9c3`),o.fog=new ar(`#e8d9c3`,2,12);",
        f"o.background=new rr(`{HAZE}`),o.fog=new ar(`{HAZE}`,2,12);",
    ),
    # Daylight instead of a nursery.
    ("t.environment=s.texture,t.environmentIntensity=.9",
     f"t.environment=s.texture,t.environmentIntensity={n(ENV_FILL)}"),
    (
        "let c=await zI(i,o);",
        "let c=await zI(i,o);"
        f"let su=new Ds(`{SUN_COLOR}`,{n(SUN_INTENSITY)});"
        "su.position.set(-c.incoming.x,-c.incoming.y,-c.incoming.z).multiplyScalar(4),"
        f"o.add(su),o.add(new cs(`{SKY_COLOR}`,`{GROUND_COLOR}`,{n(SKY_INTENSITY)}));",
    ),
]

# The dancing-Ditto favicon. Chrome ignores an animated GIF icon and caches an
# href it has seen, so each frame goes in as a fresh <link> carrying a data
# URL. It idles while the tab is hidden.
_frames = ",".join(
    "`data:image/png;base64,"
    + base64.b64encode((ROOT / f"assets/favicon-{i}.png").read_bytes()).decode()
    + "`"
    for i in range(len(list(ROOT.glob("assets/favicon-*.png"))))
)
favicon = (
    "(()=>{"
    f"let f=[{_frames}],i=0,"
    "el=document.querySelector(`link[rel=\"icon\"]`);"
    "el||(el=document.head.appendChild(document.createElement(`link`)));"
    "let put=h=>{let n=document.createElement(`link`);"
    "n.rel=`icon`,n.type=`image/png`,n.href=h,el.replaceWith(n),el=n};"
    "let timer=0,swap=()=>{if(!document.hidden)put(f[i=(i+1)%f.length])};"
    "globalThis.dittoFavicon=on=>{"
    "if(on){if(!timer)timer=setInterval(swap,"
    f"{FAVICON_MS});}}"
    "else{timer&&clearInterval(timer),timer=0,i=0,put(f[0])}};"
    "put(f[0])})();"
)

APP = [
    (
        "var e={lime:{surface:`#eaffd4`,absorption:[48,3.2,85]},"
        "strawberry:{surface:`#ffc2ce`,absorption:[10,44,56]},"
        "blueberry:{surface:`#a9d9ff`,absorption:[14,8,3]},"
        "lemon:{surface:`#fff06a`,absorption:[8,8,112]}},t=`lime`",
        f"var e={{{forms}}},t=`{DEFAULT_FORM}`",
    ),
    (
        'aria-label="Choose jelly flavor (currently ${t})"',
        'aria-label="Choose Ditto form (currently ${t})"',
    ),
    ('title="Jelly flavor: ${t}"', 'title="Ditto form: ${t}"'),
    ('aria-label="Jelly flavor choices"', 'aria-label="Ditto forms"'),
    (
        "this.button.title=`Jelly flavor: ${e}`,this.button.setAttribute(`aria-label`,"
        "`Choose jelly flavor (currently ${e})`)",
        "this.button.title=`Ditto form: ${e}`,this.button.setAttribute(`aria-label`,"
        "`Choose Ditto form (currently ${e})`)",
    ),
    ('aria-label="Jelly baby playground"', 'aria-label="Ditto playground"'),
    (
        '<button id="sound" class="icon-button" aria-label="Mute sound" '
        'aria-pressed="false" title="Sound">',
        '<button id="sound" class="icon-button muted" aria-label="Enable sound" '
        'aria-pressed="true" title="Sound">',
    ),
    (
        '<header class="masthead"><span class="eyebrow">a small, soft world</span>'
        "<h1>jelly baby<span>.</span></h1></header>",
        '<header class="masthead">'
        f'<span class="eyebrow" id="eyebrow">{EYEBROW_EN}</span>'
        f'<h1><button type="button" id="name" title="Toggle Japanese name">'
        f'{NAME_EN}<span>.</span></button></h1></header>',
    ),
    (
        '<div class="specimen"><span></span> lime &nbsp; / &nbsp; 7 cm of happiness</div>',
        "",
    ),
    # The original label was fixed copy. It now follows the chosen form.
    (
        "this.options.forEach(t=>t.setAttribute(`aria-pressed`,String(t.dataset.flavor===e)))}",
        "this.options.forEach(t=>t.setAttribute(`aria-pressed`,String(t.dataset.flavor===e)))}",
    ),
    ('aria-label="Reset jelly baby"', 'aria-label="Reset Ditto"'),
    (
        f"var e={{{forms}}},t=`{DEFAULT_FORM}`",
        f"var e={{{forms}}},t=(()=>{{"
        # ?form=shiny or a bare ?shiny pins the form, for a shareable link.
        # Nothing is remembered between visits: every load rolls again.
        "try{let u=new URLSearchParams(location.search),"
        "f=u.get(`form`)||(u.has(`shiny`)?`shiny`:null);"
        "if(f&&e[f])return f}catch(_){}"
        f"return Math.floor(Math.random()*{SHINY_ODDS})===0?`shiny`:`{DEFAULT_FORM}`}})()",
    ),
    ("The game couldn\u2019t start. Details below.", "DITTO could not appear. Details below."),
    ("A little hiccup.", "DITTO fled!"),
    (
        "c(async()=>{let{startGame:e}=await import(",
        "c(async()=>{await (globalThis.__dittoIntroAnim||Promise.resolve());"
        "let{startGame:e}=await import(",
    ),
    (
        "l=`Playing`,document.querySelector(`#loading`).classList.add(`hidden`)",
        "l=`Playing`,(globalThis.__dittoIntro||Promise.resolve())"
        ".then(()=>document.querySelector(`#loading`).classList.add(`hidden`))",
    ),
    (
        "Try again</button></div></section>",
        "Try again</button></div></div></section>"
        '<dialog id="credits">'
        '<button id="credits-close" type="button" aria-label="Close" autofocus>'
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
        ' aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
        '<p class="credits-title">Credits</p>'
        f"<ul>{CREDIT_ROWS}</ul>"
        '<p class="credits-note">A personal, non-commercial fan project. '
        "Nothing here is licensed for redistribution.</p>"
        "</dialog>",
    ),
    (
        "${n()}\n  </nav>",
        "${n()}"
        '<button id="credits-open" class="icon-button" type="button"'
        ' aria-label="Credits" title="Credits">'
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">'
        '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.4"/>'
        '<circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none"/></svg>'
        "</button>\n  </nav>",
    ),
    (
        "<div class=\"loading-card\"><div class=\"jelly-mark\"></div>"
        "<h2>A little life.</h2>"
        "<p id=\"load-message\">Warming up the world</p>",
        "<div class=\"intro\">"
        "<div class=\"blinds\" aria-hidden=\"true\">"
        "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>"
        "<div class=\"arena\" aria-hidden=\"true\">"
        "<span class=\"pad\"></span><span class=\"foe\"></span>"
        "<span class=\"stars\"><i></i><i></i><i></i><i></i></span></div>"
        "<div class=\"box\">"
        f"<h2>Wild {NAME_EN.upper()} appeared!</h2>"
        "<p id=\"load-message\">The tall grass rustles</p>",
    ),
    (
        "var l=`Loading the game`,u=!1,d;",
        "(()=>{let n=document.querySelector(`#name`),e=document.querySelector(`#eyebrow`),ja=!1,"
        f"EN=`{NAME_EN}`,JA=`{NAME_JA}`,BEN=`{EYEBROW_EN}`,BJA=`{EYEBROW_JA}`;"
        "let paint=()=>{n.innerHTML=(ja?JA:EN)+`<span>.</span>`,"
        "e.textContent=ja?BJA:BEN,document.title=ja?JA:EN};"
        "n?.addEventListener(`click`,()=>{ja=!ja,paint()}),paint()})();"
        "(()=>{let el=document.querySelector(`.intro`);"
        "let done,shown;globalThis.__dittoIntro=new Promise(r=>done=r);"
        "globalThis.__dittoIntroAnim=new Promise(r=>shown=r);"
        f"let t0=performance.now(),MIN={INTRO_MIN_MS},DWELL={INTRO_DWELL_MS};"
        "if(el&&document.querySelector(`[data-flavor=\"shiny\"]`)"
        "?.getAttribute(`aria-pressed`)===`true`)el.classList.add(`shiny`);"
        "let ended=!1,finish=()=>{if(ended)return;ended=!0;"
    "el&&el.classList.add(`go`);shown();"
        "setTimeout(done,Math.max(DWELL,MIN-(performance.now()-t0)))};"
        f"setTimeout(finish,{INTRO_CAP_MS});"
    "if(!el){finish();return}"
        "requestAnimationFrame(()=>{"
        "let fin=[],inf=[];"
        "for(let a of el.getAnimations({subtree:!0})){"
        "let t=a.effect.getTiming();"
        "(t.iterations===Infinity?inf:fin).push([a,(t.delay||0)+(t.duration||0)*(t.iterations||1)])}"
        "if(!fin.length){finish();return}"
        "for(let[a]of fin){a.pause();a.currentTime=0}"
        # advance by the real frame delta, clamped: a fixed 16.7ms ran at
        # double speed on a 120Hz display, and the clamp is what stops a
        # main-thread stall from fast-forwarding the whole entrance
        "let last=performance.now();"
        "let step=()=>{let now=performance.now(),dt=Math.min(now-last,34);last=now;"
        "let all=!0;"
        "for(let[a,d]of fin){let c=Math.min((a.currentTime||0)+dt,d);"
        "a.currentTime=c;if(c<d)all=!1}"
        "if(all){finish();return}"
        "requestAnimationFrame(step)};requestAnimationFrame(step)})})();"
        "(()=>{let d=document.querySelector(`#credits`),o=document.querySelector(`#credits-open`),c=document.querySelector(`#credits-close`);"
        "o?.addEventListener(`click`,()=>d.showModal()),"
        "c?.addEventListener(`click`,()=>d.close()),"
        "d?.addEventListener(`click`,e=>{let r=d.getBoundingClientRect();(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)&&d.close()})})();"
        "var l=`Loading the game`,u=!1,d;",
    ),
    ("`[Jelly Baby / ${l}]`", f"`[{NAME_EN} / ${{l}}]`"),
    ("var l=`Loading the game`,u=!1,d;", favicon + "var l=`Loading the game`,u=!1,d;"),
    ("`Loading the game`", "`Entering the tall grass`"),
]

HTML = [
    ("<title>Jelly Baby</title>", f"<title>{NAME_EN}</title>"),

    ('<meta name="theme-color" content="#e8d9c3" />', f'<meta name="theme-color" content="{HAZE}" />'),
    ('    <link rel="canonical" href="https://jelly.scottsun.io" />\n', ""),
    ('    <meta property="og:url" content="https://jelly.scottsun.io" />\n', ""),
    (
        'content="Jelly Baby" />\n    <meta property="og:description"',
        f'content="{NAME_EN}" />\n    <meta property="og:description"',
    ),
    (
        'property="og:image" content="https://jelly.scottsun.io/og_image.png"',
        'property="og:image" content="/og_image.jpg"',
    ),
    ('property="og:image:alt" content="Jelly Baby"', f'property="og:image:alt" content="{NAME_EN}"'),
    ('name="twitter:title" content="Jelly Baby"', f'name="twitter:title" content="{NAME_EN}"'),
    (
        'name="twitter:image" content="https://jelly.scottsun.io/og_image.png"',
        'name="twitter:image" content="/og_image.jpg"',
    ),
    (
        "<noscript>Jelly Baby needs JavaScript and a WebGPU-capable browser.</noscript>",
        "<noscript>Ditto needs JavaScript and a WebGPU-capable browser.</noscript>",
    ),
    (
        "<!doctype html>",
        "<!doctype html>\n<!-- Ditto is a Pokemon owned by "
        "Nintendo / Creatures / Game Freak. Local, non-commercial use. -->",
    ),
]

# No jelly left in the served files: the loading mark and the body material
# keep their own names.
def dejelly(text):
    return text.replace("jelly-mark", "ditto-mark").replace("jellyMaterial", "bodyMaterial")


def relative(text):
    """Absolute /assets/... breaks under a GitHub Pages sub-path. The JS
    modules sit in assets/ themselves, so ./x resolves next to them."""
    return (text.replace("`/assets/", "`./")
                .replace('href="/', 'href="./')
                .replace('src="/', 'src="./')
                .replace('content="/og_image.jpg"', 'content="./og_image.jpg"'))


css = re.sub(
    r"#([0-9a-fA-F]{6})([0-9a-fA-F]{0,2})\b",
    lambda m: "#" + HUE.get(m.group(1).lower(), m.group(1)) + m.group(2),
    (SRC / "index.css").read_text(),
)

(ROOT / "index.html").write_text(relative(apply((SRC / "index.html").read_text(), HTML, "index.html")))
(ROOT / "assets/index-B_rmCXFl.js").write_text(relative(dejelly(apply((SRC / "index.js").read_text(), APP, "index.js"))))
(ROOT / "assets/runtime-BfiCajl-.js").write_text(
    relative(dejelly(apply((SRC / "runtime.js").read_text(), RUNTIME, "runtime.js")))
)
(ROOT / "assets/index-NajdQ5bO.css").write_text(dejelly(css + NAME_CSS + LOADING_CSS + CREDITS_CSS))
# Fixed filenames plus long cache lifetimes mean a rebuild can be served from
# cache. Leaf assets get their own content hash; the JS modules share ONE build
# stamp, because index.html and the runtime both name the app module and a
# per-file hash there is circular -- two spellings of the same URL make the
# browser evaluate the app twice, which puts two pickers on one button.
import hashlib

_css = ROOT / "assets/index-NajdQ5bO.css"
_app = ROOT / "assets/index-B_rmCXFl.js"
_rt = ROOT / "assets/runtime-BfiCajl-.js"
_html = ROOT / "index.html"

_rt.write_text(_rt.read_text()
               .replace("`./transport.worker-BWQVwIa1.js`",
                        f"`./{stamp('transport.worker-BWQVwIa1.js')}`")
               .replace("`./grass_tiles.webp`", f"`./{stamp('grass_tiles.webp')}`")
               .replace("`./grass_tuft.webp`", f"`./{stamp('grass_tuft.webp')}`")
               .replace("`./konga.mp3`", f"`./{stamp('konga.mp3')}`"))

BUILD = hashlib.sha256(
    (_app.read_text() + _rt.read_text() + _css.read_text()).encode()
).hexdigest()[:8]

_app.write_text(_app.read_text()
                .replace("`./runtime-BfiCajl-.js`", f"`./runtime-BfiCajl-.js?b={BUILD}`"))
_rt.write_text(_rt.read_text()
               .replace('"./index-B_rmCXFl.js"', f'"./index-B_rmCXFl.js?b={BUILD}"'))
_html.write_text(_html.read_text()
                 .replace('"./assets/index-NajdQ5bO.css"',
                          f'"./assets/index-NajdQ5bO.css?b={BUILD}"')
                 .replace('"./assets/index-B_rmCXFl.js"',
                          f'"./assets/index-B_rmCXFl.js?b={BUILD}"'))
print("patched 4 files")
