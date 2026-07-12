const $ = id => document.getElementById(id);
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
let midiData = null;   // parsed { tracks:[{notes:[{midi,start,end}]}], ppq }
let noteEvents = null; // flattened melody events for current settings
let previewTracks = []; // event-arrays for the current selection (audio preview)

function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function noteHz(midi){ return 440 * Math.pow(2,(midi-69)/12); }
function midiToName(midi){
const name = NOTE_NAMES[((midi%12)+12)%12];
const octave = Math.floor(midi/12) - 1;
return { name, octave, label: name + octave };
}

// ---------- MIDI parser (Standard MIDI File) ----------
function parseMidi(buffer){
const dv = new DataView(buffer);
let p = 0;
const readStr = n => { let s=""; for(let i=0;i<n;i++) s+=String.fromCharCode(dv.getUint8(p++)); return s; };
const u32 = () => { const v=dv.getUint32(p); p+=4; return v; };
const u16 = () => { const v=dv.getUint16(p); p+=2; return v; };
const u8  = () => dv.getUint8(p++);

if (readStr(4) !== "MThd") throw new Error("Not a MIDI file (missing MThd header).");
u32(); // header length (6)
u16(); // format
const nTracks = u16();
const division = u16();
if (division & 0x8000) throw new Error("SMPTE time division isn't supported — re-export with ticks-per-beat timing.");
const ppq = division; // ticks per quarter note

const tracks = [];
const tempos = []; // { tick, usPerQuarter }
for (let t=0; t<nTracks; t++){
  if (readStr(4) !== "MTrk"){ break; }
  const len = u32();
  const end = p + len;
  let tick = 0, running = 0;
  const active = {}; // key = note number -> {start}
  const notes = [];
  while (p < end){
    // variable-length delta
    let delta = 0, b;
    do { b = u8(); delta = (delta<<7) | (b & 0x7f); } while (b & 0x80);
    tick += delta;
    let status = dv.getUint8(p);
    if (status & 0x80){ p++; running = status; }
    else status = running; // running status
    const type = status & 0xf0;
    if (status === 0xff){ // meta event
      const meta = u8();
      let mlen = 0, mb;
      do { mb = u8(); mlen = (mlen<<7) | (mb & 0x7f); } while (mb & 0x80);
      if (meta === 0x51 && mlen === 3){ // set tempo (us per quarter)
        const us = (dv.getUint8(p)<<16)|(dv.getUint8(p+1)<<8)|dv.getUint8(p+2);
        tempos.push({ tick, us });
      }
      p += mlen;
    } else if (status === 0xf0 || status === 0xf7){ // sysex
      let slen = 0, sb;
      do { sb = u8(); slen = (slen<<7) | (sb & 0x7f); } while (sb & 0x80);
      p += slen;
    } else if (type === 0x90){ // note on
      const note = u8(), vel = u8();
      if (vel > 0){ active[note] = tick; }
      else { closeNote(active, note, tick, notes); }
    } else if (type === 0x80){ // note off
      const note = u8(); u8();
      closeNote(active, note, tick, notes);
    } else if (type === 0xa0 || type === 0xb0 || type === 0xe0){ p+=2; }
    else if (type === 0xc0 || type === 0xd0){ p+=1; }
    else { p++; }
  }
  // close any still-held notes at track end
  for (const k in active) closeNote(active, +k, tick, notes);
  p = end;
  tracks.push({ notes });
}
return { tracks, ppq, tempos };
}

function closeNote(active, note, tick, notes){
if (active[note] != null){
  const start = active[note];
  if (tick > start) notes.push({ midi: note, start, end: tick });
  delete active[note];
}
}

// convert ticks to absolute ms using the tempo map
function buildTickToMs(ppq, tempos){
const map = tempos.slice().sort((a,b)=>a.tick-b.tick);
if (!map.length || map[0].tick > 0) map.unshift({ tick:0, us:500000 }); // default 120bpm
return (tick) => {
  let ms = 0;
  for (let i=0;i<map.length;i++){
    const seg = map[i];
    const next = map[i+1];
    const segEnd = next ? Math.min(next.tick, tick) : tick;
    if (segEnd > seg.tick){
      ms += (segEnd - seg.tick) * (seg.us/1000) / ppq;
    }
    if (next && tick <= next.tick) break;
  }
  return ms;
};
}

// ---------- flatten to a monophonic melody ----------
// trackSel: a track index, or -1 for "all tracks mixed"
// capRests: cap long silences (nice for a lone melody). MUST be false for
// multi-hub, or capping desyncs the tracks by shortening their timelines.
// Returns { events, start } where start is the absolute ms of the first onset
// (used to align tracks that enter at different times across multiple hubs).
function flatten(trackSel, capRests = true){
if (!midiData) return { events: [], start: 0 };
const voice = $("voice").value;   // high | low
const speed = clamp(+$("speed").value, 10, 400)/100;
const tickToMs = buildTickToMs(midiData.ppq, midiData.tempos);

// gather notes from chosen track(s), converting to ms
let all = [];
midiData.tracks.forEach((tr,i)=>{
  if (trackSel !== -1 && trackSel !== i) return;
  for (const n of tr.notes){
    all.push({ midi:n.midi, start: tickToMs(n.start)/speed, end: tickToMs(n.end)/speed });
  }
});
if (!all.length) return { events: [], start: 0 };
all.sort((a,b)=>a.start-b.start || a.midi-b.midi);

// Onset grid: group notes that begin at (nearly) the same time. Notes within
// ~30ms of each other count as one chord/onset so tiny timing jitter in the
// MIDI doesn't fracture the melody.
const onsets = [];
for (const n of all){
  const last = onsets[onsets.length-1];
  if (last && n.start - last.t <= 30) last.notes.push(n);
  else onsets.push({ t: n.start, notes: [n] });
}

// For each onset pick the melody voice (highest or lowest sounding note).
const events = [];
const RESTCAP = capRests ? 700 : Infinity; // never emit a silence longer than this (ms)
for (let i=0;i<onsets.length;i++){
  const o = onsets[i];
  let pick = o.notes[0];
  for (const n of o.notes) if (voice==="high" ? n.midi>pick.midi : n.midi<pick.midi) pick=n;

  const next = onsets[i+1];
  // The note sustains until the NEXT onset (this gives the score's rhythm and
  // keeps the line continuous even when the player's finger lifted early).
  let slotEnd = next != null ? next.t : pick.end;
  let dur = Math.max(1, Math.round(slotEnd - o.t));

  // Only treat it as a real rest if the melody voice is genuinely silent for
  // a big chunk before the next note AND that silence is musically meaningful.
  const soundedMs = Math.round(pick.end - o.t);
  if (next != null && soundedMs > 0 && (slotEnd - pick.end) > 250){
    // played note, then a real gap → note for its true length, then a capped rest
    const playMs = Math.max(1, soundedMs);
    const restMs = Math.min(RESTCAP, Math.round(slotEnd - pick.end));
    events.push({ midi:pick.midi, ms:playMs, rest:false });
    events.push({ rest:true, ms:restMs });
  } else {
    events.push({ midi:pick.midi, ms:dur, rest:false });
  }
}
return { events, start: onsets.length ? onsets[0].t : 0 };
}

// single hub: trim leading AND trailing rests (no one to stay aligned with)
function buildEvents(trackSel){
const e = flatten(trackSel).events;
while (e.length && e[0].rest) e.shift();
while (e.length && e[e.length-1].rest) e.pop();
return e;
}

// multi hub: keep the absolute start so tracks entering at different times
// can be aligned to a common musical zero. Trim only trailing silence.
// Rests are NOT capped here -- every track must keep its true timeline or the
// hubs drift apart (a capped rest makes that track finish its bar too early).
function buildTimeline(trackSel){
const e = flatten(trackSel, false);
const events = e.events.slice();
while (events.length && events[events.length-1].rest) events.pop();
return { events, start: e.start };
}

// ---------- generate & render ----------
function generate(){
if (!midiData) return;
stopAllPreview();              // settings changed -> stop any stale preview
const outputs = $("outputs");
outputs.innerHTML = "";
const hubCount = clamp(Math.round(+$("hubCount").value) || 1, 1, maxHubs());

if (hubCount <= 1){
  const events = buildEvents(+$("track").value);
  if (!events.length){ setStatus("No notes found in this file/track."); setRestWarn(0); previewTracks = []; return; }
  noteEvents = events;
  previewTracks = [events];
  drawViz();
  setRestWarn(events.filter(e=>e.rest).length);
  const ts = +$("track").value;
  const code = renderCode(events, { mode:"single", displayNum: ts >= 0 ? ts + 1 : null });
  outputs.appendChild(makeOutputPanel({ title:"Generated Pybricks code", code, filename:"melody.py", events }));
  return;
}

// --- multi-hub: one track per hub, kept in sync over BLE ---
const assigns = readAssignments(hubCount);
// Align every track to a common musical zero so a part that enters later
// keeps its lead-in silence instead of starting immediately.
const timelines = assigns.map(buildTimeline);
const starts = timelines.filter(t => t.events.length).map(t => t.start);
const globalStart = starts.length ? Math.min(...starts) : 0;

let totalRest = 0, empties = 0;
previewTracks = [];
timelines.forEach((tl, i) => {
  let events = tl.events;
  const lead = Math.round(tl.start - globalStart);
  if (events.length && lead > 0) events = [{ rest:true, ms:lead }, ...events];
  if (!events.length) empties++;
  else previewTracks.push(events);
  totalRest += events.filter(e=>e.rest).length;
  const role = i === 0 ? "leader" : "follower";
  const trackSel = assigns[i];
  const code = renderCode(events, { mode: role, channel: 1, displayNum: trackSel >= 0 ? trackSel + 1 : i + 1 });
  const title = `Hub ${i+1} · ${role === "leader" ? "Leader (start hub)" : "Follower"} · ${trackLabel(trackSel)}`;
  outputs.appendChild(makeOutputPanel({ title, code, filename:`hub${i+1}_${role}.py`, events }));
});
drawViz();          // show every hub's track together, aligned on one timeline
setRestWarn(totalRest);
setStatus(`${hubCount} Prime hubs, one track each. Run every follower program first (they wait), then press the leader hub's center button to start them together.` +
  (empties ? ` Note: ${empties} assigned track(s) had no notes.` : ""));
}

// Build one hub's Pybricks program. opts.mode: "single" | "leader" | "follower".
function renderCode(events, opts){
const hub = $("hub").value;
const gap = clamp(+$("gapMs").value || 0, 0, 200);
const vol = clamp(Math.round(+$("volume").value), 0, 100);
const mode = opts.mode || "single";
const channel = opts.channel || 1;
// Sync trim: how many ms a follower stays behind the leader's clock, to fill
// the BLE/audio latency. +ve = follower later, -ve = follower earlier. With
// continuous re-sync this only sets the constant offset; drift is handled.
const trim = clamp(Math.round(+$("syncTrim").value) || 0, -2000, 2000);
// Countdown (seconds -> ms) before the first note. The leader counts this down
// on its display while every hub locks onto the shared clock, so playback starts
// already in sync instead of drifting for the first few seconds.
const lead = clamp(Math.round(+$("countdownSec").value) || 0, 0, 10) * 1000;
// Track number to show on the hub's light matrix (Prime/Inventor only).
const hasDisplay = hub === "PrimeHub" || hub === "InventorHub";
const displayNum = (hasDisplay && opts.displayNum != null) ? opts.displayNum : null;
const displayLine = displayNum != null ? `hub.display.number(${displayNum})   # show this hub's track number\n` : "";

const seen = new Map();
for (const e of events) if (!e.rest && !seen.has(e.midi)){
  const nm = midiToName(e.midi);
  let name = nm.name.replace("#","S") + nm.octave;
  let base=name,k=2; while([...seen.values()].includes(name)) name=base+"_"+(k++);
  seen.set(e.midi, name);
}
const constLines = [...seen.entries()]
  .sort((a,b)=>a[0]-b[0])
  .map(([midi,name]) => `${name} = ${Math.round(noteHz(midi))}`);

const tuples = events.map(e => e.rest ? `(0, ${Math.round(e.ms)})` : `(${seen.get(e.midi)}, ${Math.round(e.ms)})`);
const lines = [];
for (let i=0;i<tuples.length;i+=6) lines.push("    " + tuples.slice(i,i+6).join(", ") + ",");
if (lines.length) lines[lines.length-1] = lines[lines.length-1].replace(/,$/,"");

const notesBlock =
`# Note frequencies (Hz)
${constLines.join("\n")}

# (frequency, duration_ms)  -- frequency 0 = silent pause
melody = [
${lines.join("\n")}
]`;

// --- single hub: plain blocking playback ---
if (mode === "single"){
  return (
`from pybricks.hubs import ${hub}
from pybricks.tools import wait

# Auto-generated from a MIDI file
hub = ${hub}()
hub.speaker.volume(${vol})
${displayLine}
${notesBlock}

print("Playing melody...")
for frequency, duration in melody:
    if frequency == 0:
        wait(duration)
    else:
        hub.speaker.beep(frequency, duration)
    wait(${gap})  # small gap between notes

wait(500)
`);
}

// --- multi hub: async so playback and the stop-watcher run together ---
// Protocol on the BLE channel: broadcast 1 = "start", STOP = "everyone stop".
// The radio moved from hub.ble to pybricks.messaging in Pybricks 4.0, so the
// setup tries the new module and falls back to hub.ble on older firmware.
const isLeader = mode === "leader";
let imports = `from pybricks.hubs import ${hub}\nfrom pybricks.tools import wait, multitask, run_task, StopWatch`;
if (isLeader) imports += `\nfrom pybricks.parameters import Button`;

const radioSetup = isLeader ?
`CHANNEL = ${channel}
try:
    from pybricks.messaging import BLERadio   # Pybricks 4.0+
    hub = ${hub}()
    _radio = BLERadio(broadcast_channel=CHANNEL)
    def signal(value):
        _radio.broadcast(value)
except ImportError:
    hub = ${hub}(broadcast_channel=CHANNEL)   # older firmware
    def signal(value):
        hub.ble.broadcast(value)` :
`CHANNEL = ${channel}
try:
    from pybricks.messaging import BLERadio   # Pybricks 4.0+
    hub = ${hub}()
    _radio = BLERadio(observe_channels=[CHANNEL])
    def look():
        return _radio.observe(CHANNEL)
except ImportError:
    hub = ${hub}(observe_channels=[CHANNEL])   # older firmware
    def look():
        return hub.ble.observe(CHANNEL)`;

const head =
`${imports}

# Auto-generated from a MIDI file
${radioSetup}
hub.speaker.volume(${vol})
${displayLine}
${notesBlock}

STOP = -1     # broadcast value meaning "everyone stop now"
GAP = ${gap}       # silence between notes -- taken out of the note, NOT added to
                   # the timeline, so every bar lands on the exact same beat
clock = StopWatch()

async def play():
    # pos() is where the music SHOULD be right now (the shared clock). Every note
    # is pinned to it. If we run late (e.g. a slow low-frequency beep), we shorten
    # the note -- or skip it entirely if its slot has already passed -- so we snap
    # back onto the beat instead of falling behind and never catching up.
    t = 0
    for frequency, duration in melody:
        if pos() < t + duration:         # slot not fully in the past -> play it
            while pos() < t:             # not our moment yet -> wait for it
                await wait(1)
            if frequency != 0:
                remaining = t + duration - pos() - GAP   # only the time still ahead of us
                if remaining > 0:
                    await hub.speaker.beep(frequency, remaining)
        t += duration                    # always advance the schedule by the true length

# Pixels around the edge of the 5x5 light matrix, in a loop, for the "playing"
# animation. A little comet travels the border so you can see a hub is live.
_EDGE = [(0,0),(0,1),(0,2),(0,3),(0,4),(1,4),(2,4),(3,4),
         (4,4),(4,3),(4,2),(4,1),(4,0),(3,0),(2,0),(1,0)]

async def spin():
    # Loops forever (the race in main() cancels it when playback ends). Lights the
    # leading pixel and clears the one 3 steps back -> a moving 3-4 pixel comet.
    hub.display.off()
    i = 0
    while True:
        r, c = _EDGE[i % len(_EDGE)]
        hub.display.pixel(r, c, 100)
        pr, pc = _EDGE[(i - 3) % len(_EDGE)]
        hub.display.pixel(pr, pc, 0)
        i += 1
        await wait(80)
`;

const body = isLeader ?
`SYNC = 100     # broadcast our position this often (ms) so followers can track us
LEAD = ${lead}    # countdown before the first note (ms). The clock starts now, so
                   # followers lock onto it during the countdown and begin in sync.

def pos():
    return clock.time() - LEAD    # music position; negative during the countdown

async def report():
    # The leader is the master clock: keep telling the followers our exact
    # position so they re-align every SYNC ms and never drift apart. Broadcasting
    # starts during the countdown so followers pre-sync before the first note.
    while True:
        signal(clock.time())
        await wait(SYNC)

async def show():
    # Count down on the display, then switch to the "playing" animation once the
    # first note is due (pos() >= 0). Every hub shows the animation together.
    last = -1
    while pos() < 0:
        n = (-pos() + 999) // 1000       # seconds remaining, rounded up
        if n != last:
            hub.display.number(n)
            last = n
        await wait(50)
    await spin()

# The center button is normally the STOP button, which would kill this
# program. Move "stop" to the Bluetooth button so the center button is
# free to start (and later stop) playback. Press Bluetooth for a hard stop.
hub.system.set_stop_button(Button.BLUETOOTH)

async def wait_center():
    while Button.CENTER not in hub.buttons.pressed():
        await wait(10)
    while Button.CENTER in hub.buttons.pressed():   # wait for release
        await wait(10)
    return True

async def main():
    # --- LEADER hub: run every follower first, then press this hub's center
    # --- button to start all hubs. Press it again to stop them all.
    print("Press the center button to start all hubs.")
    await wait_center()
    clock.reset()          # t=0 is the START of the countdown, not the first note
    print("Counting down...")
    # Play + broadcast position + countdown/animation, stopping when the melody
    # ends or the center button is pressed again.
    results = await multitask(play(), report(), show(), wait_center(), race=True)
    if results[3]:         # center pressed -> stop the followers immediately
        signal(STOP)
        await wait(300)
    signal(None)           # stop broadcasting (followers finish their own track)
    await wait(500)

run_task(main())
` :
`TRIM = ${trim}      # stay this many ms behind the leader's clock (BLE latency)
LEAD = ${lead}     # countdown before the first note (ms) -- matches the leader
STEP = 4         # max ms we nudge per correction -- keeps steering gentle & smooth
offset = [0]     # our position = clock.time() + offset[0]
ref = [0]        # leader position captured at our start (shared zero)
locked = [False] # have we done the initial hard lock yet?

def pos():
    return clock.time() + offset[0] - LEAD   # music position on the leader's clock

async def follow():
    # Our own clock is smooth; the leader's reported position is stale and jittery.
    # So we lock onto it ONCE at the start, then only steer by tiny steps to cancel
    # slow crystal drift. Hard-snapping every reading is what caused the stutter.
    while True:
        data = look()
        if data == STOP:
            return
        if data is not None and data >= 0:
            error = (data - ref[0] - TRIM) - (clock.time() + offset[0])
            if not locked[0]:
                offset[0] += error          # snap into sync once
                locked[0] = True
            elif error > STEP:
                offset[0] += STEP           # else creep toward it, never jump
            elif error < -STEP:
                offset[0] -= STEP
            else:
                offset[0] += error
        await wait(250)   # correct gently, a few times a second is plenty

async def show():
    # Stay dark through the leader's countdown, then run the same "playing"
    # animation as every other hub once the first note is due.
    while pos() < 0:
        await wait(50)
    await spin()

async def main():
    # --- FOLLOWER hub: run this, then press the leader hub's center button.
    print("Waiting for the leader hub...")
    while True:
        d = look()
        if d is not None and d >= 0:      # first position broadcast = go
            break
        await wait(10)
    hub.display.off()        # leader has started the countdown -> stop showing our track number
    clock.reset()
    ref[0] = d               # leader's position now is our zero
    offset[0] = -TRIM        # start TRIM ms behind to fill the BLE latency
    print("Counting down with the leader...")
    # Play + track the leader + animate, stopping when it says STOP or our track ends.
    await multitask(play(), follow(), show(), race=True)
    await wait(500)

run_task(main())
`;

return head + "\n" + body;
}

// ---------- audio preview (square wave ~ the hub buzzer) ----------
// Notes are bounced to a single AudioBuffer up front, then played back as one
// buffer -- so playback cost no longer depends on track/note count, which is
// what caused audible lag/glitching past ~7 tracks with the old approach
// (a live OscillatorNode+GainNode per note per track on the real-time context).
//
// The bounce itself writes square-wave samples directly into a typed array
// instead of going through a Web Audio graph (OfflineAudioContext + one
// oscillator node per note): a real multi-track song can have thousands of
// notes, and Web Audio's per-node graph-processing overhead turned out to
// scale badly with node count even offline (a 10-track/150-note-per-track
// song took ~9s to bounce, and a 12-track/400-note-per-track song didn't
// finish in 40s). Direct sample synthesis is O(total sounding note-time) with
// no graph overhead, so it stays fast regardless of track/note count.
let audioCtx = null;
let playSourceNode = null;   // the single AudioBufferSourceNode currently playing
let currentStop = null;      // () => void that stops playback + resets its button
let renderCache = null;      // { tracks, buffer } -- avoids re-rendering the same tracks

// Playhead/seek state for the MAIN "Preview audio" button only (per-track spk
// buttons in the code panels aren't tracked here -- the viz chart always shows
// the combined multi-track timeline, so the seek bar follows that one).
let vizTotalSec = 0;          // duration of the current combined preview timeline
let seekSec = 0;              // playhead position; persists across stop (pause-like)
let mainBuffer = null;        // the AudioBuffer currently loaded for the main preview
let mainOnEndCb = null;       // onEnd callback to reuse when a seek restarts the source
let playStartCtxTime = null;  // ctx.currentTime when mainBuffer last started/resumed
let playStartOffsetSec = 0;   // seekSec at that moment
let vizRafId = null;
let vizDragging = false;

function isMainPlaying(){ return playStartCtxTime != null; }

function currentMainSec(){
if (!isMainPlaying()) return seekSec;
const ctx = audio();
return clamp(playStartOffsetSec + (ctx.currentTime - playStartCtxTime), 0, vizTotalSec);
}

function audio(){
if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
return audioCtx;
}

// Bounce the given tracks down to a single (stereo) AudioBuffer of square-wave
// notes. Cached by reference so replaying (or exporting right after previewing)
// doesn't re-render. onProgress(0..1), if given, is called periodically as notes
// are synthesized; the loop yields to the event loop between chunks so a big
// render doesn't freeze the tab.
async function renderTracks(tracks, onProgress){
if (renderCache && renderCache.tracks === tracks){
  if (onProgress) onProgress(1);
  return renderCache.buffer;
}
const sampleRate = 44100;
const t0 = 0.02;
const totalMs = tracks.reduce((m, ev) => Math.max(m, ev.reduce((s,e)=>s+e.ms, 0)), 0);
const lengthSec = t0 + totalMs / 1000 + 0.05;   // pad for the last note's release tail
const numFrames = Math.max(1, Math.ceil(lengthSec * sampleRate));
const data = new Float32Array(numFrames);
const vol = 0.16 / Math.max(1, Math.sqrt(tracks.length));   // don't clip when mixed

// Flatten every track to a plain list of notes so we can chunk the synth work
// and yield periodically, independent of how many tracks they came from.
const notes = [];
for (const events of tracks){
  let t = t0;
  for (const e of events){
    const dur = Math.max(0.001, e.ms / 1000);
    if (!e.rest && e.midi != null) notes.push({ t, dur, midi: e.midi });
    t += dur;
  }
}

const CHUNK = 200;   // notes per chunk before yielding to the event loop
for (let i = 0; i < notes.length; i++){
  const { t, dur, midi } = notes[i];
  const freq = noteHz(midi);
  const sound = Math.max(0.02, dur - 0.012);   // small gap between notes
  const a = 0.004;                              // tiny attack/release, no clicks
  const startFrame = Math.max(0, Math.round(t * sampleRate));
  const endFrame = Math.min(numFrames, Math.round((t + sound) * sampleRate));
  const period = sampleRate / freq;
  for (let f = startFrame; f < endFrame; f++){
    const localSec = (f - startFrame) / sampleRate;
    let env = 1;
    if (localSec < a) env = localSec / a;
    else if (localSec > sound - a) env = Math.max(0, (sound - localSec) / a);
    const phase = ((f - startFrame) % period) / period;
    data[f] += (phase < 0.5 ? 1 : -1) * env * vol;
  }
  if (onProgress && (i % CHUNK === CHUNK - 1 || i === notes.length - 1)){
    onProgress((i + 1) / notes.length);
    await new Promise(r => setTimeout(r, 0));
  }
}
if (!notes.length && onProgress) onProgress(1);

for (let f = 0; f < numFrames; f++) data[f] = Math.max(-1, Math.min(1, data[f]));

const buffer = new AudioBuffer({ length: numFrames, numberOfChannels: 2, sampleRate });
buffer.copyToChannel(data, 0);
buffer.copyToChannel(data, 1);
renderCache = { tracks, buffer };
return buffer;
}

// Render a button's content as "<label> <ring with pct in the middle>". Used
// while a render is in flight so the user can see it's working, not stuck.
// Small icon-only buttons (the per-track "spk" speaker buttons) skip the label
// and just show the ring, so they don't balloon in width.
function setBtnProgress(btn, label, pct){
const p = Math.max(0, Math.min(100, Math.round(pct)));
btn.classList.add("has-progress");
const compact = btn.classList.contains("spk");
// Width/height/fill are set as real attributes, not just CSS, so the ring stays a
// small outline (not a giant filled disc -- SVG's UA default fill is black and its
// default intrinsic size is ~300x150) even if styles.css hasn't loaded yet/at all.
btn.innerHTML =
  (compact ? "" : `<span class="btn-label">${label}</span>`) +
  `<span class="btn-ring" style="--p:${p}">` +
    `<svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">` +
      `<circle class="ring-bg" cx="18" cy="18" r="15.9155" fill="none"/>` +
      `<circle class="ring-fg" cx="18" cy="18" r="15.9155" fill="none"/>` +
    `</svg>` +
    `<span class="btn-ring-pct">${p}</span>` +
  `</span>`;
}

// Starts (or restarts, for a seek) playback of a buffer from offsetSec. Returns
// the ctx time / offset the source actually started at, so callers can track a
// playhead position against ctx.currentTime.
function playBuffer(buffer, onEnd, offsetSec){
const ctx = audio();
if (ctx.state === "suspended") ctx.resume();
const off = clamp(offsetSec || 0, 0, buffer.duration);
const src = ctx.createBufferSource();
src.buffer = buffer;
src.connect(ctx.destination);
playSourceNode = src;
src.onended = () => { if (playSourceNode === src){ playSourceNode = null; if (onEnd) onEnd(); } };
const startCtxTime = ctx.currentTime;
src.start(startCtxTime, off);
return { startCtxTime, offset: off };
}

function stopAudio(){
if (playSourceNode){
  try { playSourceNode.onended = null; playSourceNode.stop(); } catch(e){}
  playSourceNode = null;
}
}

function stopAllPreview(){
if (currentStop){ const s = currentStop; currentStop = null; s(); }
}

function hasNotes(tracks){ return tracks.some(t => t.some(e => !e.rest && e.midi != null)); }

// Toggle play/stop for a button. tracks = array of event-arrays to play together.
// The main "Preview audio" button additionally drives the viz chart's playhead
// and seek bar (see the viz section below); per-track spk buttons don't.
async function togglePreview(btn, tracks, idleHTML, playingHTML){
const isMain = btn === $("preview");
const wasThis = currentStop && currentStop.btn === btn;
stopAllPreview();               // stop anything already playing (and reset its button)
if (wasThis) return;            // clicking the active button again just stops
if (!tracks.length || !hasNotes(tracks)) return;

btn.classList.add("playing");
setBtnProgress(btn, "Loading", 0);
const reset = () => { btn.classList.remove("has-progress"); btn.innerHTML = idleHTML; btn.classList.remove("playing"); };
const stop = () => {
  if (isMain && isMainPlaying()) seekSec = currentMainSec();   // pause in place, not reset to 0
  stopAudio();
  if (isMain){ playStartCtxTime = null; mainBuffer = null; stopVizLoop(); renderVizFrame(seekSec); updateVizTimeLabel(seekSec); }
  reset();
};
stop.btn = btn;
currentStop = stop;             // set before awaiting so stop/regenerate can cancel a pending render

let buffer;
try { buffer = await renderTracks(tracks, pct => { if (currentStop === stop) setBtnProgress(btn, "Loading", pct * 100); }); }
catch(e){ if (currentStop === stop){ currentStop = null; reset(); } return; }
if (currentStop !== stop) return;   // stopped, or superseded by another click, while rendering

btn.classList.remove("has-progress");
btn.innerHTML = playingHTML;

const onEnd = () => {
  if (isMain){ seekSec = 0; playStartCtxTime = null; mainBuffer = null; stopVizLoop(); renderVizFrame(0); updateVizTimeLabel(0); }
  reset();
  if (currentStop === stop) currentStop = null;
};
if (isMain){
  mainBuffer = buffer;
  mainOnEndCb = onEnd;
  const info = playBuffer(buffer, onEnd, seekSec);   // resume from wherever it was last paused/sought
  playStartCtxTime = info.startCtxTime;
  playStartOffsetSec = info.offset;
  startVizLoop();
} else {
  playBuffer(buffer, onEnd, 0);
}
}

// ---------- WAV export ----------
function audioBufferToWav(buffer){
const numCh = buffer.numberOfChannels;
const sampleRate = buffer.sampleRate;
const numFrames = buffer.length;
const blockAlign = numCh * 2;
const dataSize = numFrames * blockAlign;
const out = new ArrayBuffer(44 + dataSize);
const view = new DataView(out);
const writeStr = (o,s) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };

writeStr(0, "RIFF");
view.setUint32(4, 36 + dataSize, true);
writeStr(8, "WAVE");
writeStr(12, "fmt ");
view.setUint32(16, 16, true);                    // PCM chunk size
view.setUint16(20, 1, true);                      // PCM format
view.setUint16(22, numCh, true);
view.setUint32(24, sampleRate, true);
view.setUint32(28, sampleRate * blockAlign, true); // byte rate
view.setUint16(32, blockAlign, true);
view.setUint16(34, 16, true);                     // bits per sample
writeStr(36, "data");
view.setUint32(40, dataSize, true);

const chData = []; for (let c=0;c<numCh;c++) chData.push(buffer.getChannelData(c));
let offset = 44;
for (let i=0;i<numFrames;i++){
  for (let c=0;c<numCh;c++){
    const s = Math.max(-1, Math.min(1, chData[c][i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
}
return new Blob([out], { type: "audio/wav" });
}

async function exportWav(){
if (!previewTracks.length || !hasNotes(previewTracks)) return;
const btn = $("exportWav");
const original = btn.textContent;
btn.disabled = true;
setBtnProgress(btn, "Rendering", 0);
try {
  const buffer = await renderTracks(previewTracks, pct => setBtnProgress(btn, "Rendering", pct * 100));
  const blob = audioBufferToWav(buffer);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "midibricks-preview.wav";
  a.click();
  URL.revokeObjectURL(a.href);
} finally {
  btn.classList.remove("has-progress");
  btn.disabled = false;
  btn.textContent = original;
}
}

// Create a collapsible code output panel. Collapsed by default; click the
// header (chevron/title) to expand. Copy/Download stay clickable in the header.
function makeOutputPanel({ title, code, filename, events }){
const panel = document.createElement("div");
panel.className = "panel out-panel collapsed";

const head = document.createElement("div");
head.className = "code-head out-toggle";
head.setAttribute("role", "button");
head.setAttribute("tabindex", "0");

const heading = document.createElement("div");
heading.className = "out-heading";
const chevron = document.createElement("span");
chevron.className = "chevron"; chevron.textContent = "▶";   // ▶
const h = document.createElement("h2");
h.textContent = title;
heading.append(chevron, h);

const btns = document.createElement("div");
btns.style.cssText = "display:flex;gap:.5rem";
const PLAY = "🔊", STOP_ICON = "◼";
const spk = document.createElement("button");
spk.className = "sec spk"; spk.textContent = PLAY; spk.title = "Play what this track should sound like";
const copy = document.createElement("button"); copy.className = "sec"; copy.textContent = "Copy";
const dl = document.createElement("button"); dl.className = "sec"; dl.textContent = "Download .py";
btns.append(spk, copy, dl);
head.append(heading, btns);

const pre = document.createElement("pre");
pre.textContent = code;
panel.append(head, pre);

const toggle = () => panel.classList.toggle("collapsed");
head.addEventListener("click", toggle);
head.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " "){ e.preventDefault(); toggle(); }
});

// keep the action buttons from toggling the panel
spk.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePreview(spk, [events || []], PLAY, STOP_ICON);
});
copy.addEventListener("click", (e) => {
  e.stopPropagation();
  navigator.clipboard.writeText(code);
  copy.textContent = "Copied"; setTimeout(() => copy.textContent = "Copy", 1200);
});
dl.addEventListener("click", (e) => {
  e.stopPropagation();
  const blob = new Blob([code], { type:"text/x-python" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
});
return panel;
}

function setRestWarn(n){
$("restWarn").textContent = n ? `${n} rest(s) become silent pauses (frequency 0).` : "";
}

// ---------- multi-hub track assignment ----------
let trackInfos = [];   // [{ i, count, avg }] for tracks that have notes
let defaultOrder = []; // track indices, melody-ish (highest register) first

function maxHubs(){ return Math.max(1, trackInfos.length); }

function trackLabel(trackSel){
if (trackSel === -1) return "All tracks";
const info = trackInfos.find(t => t.i === trackSel);
return `Track ${trackSel+1}` + (info ? ` (${info.count} notes)` : "");
}

// (re)build the per-hub track dropdowns for the current hub count
function buildAssignUI(hubCount){
const wrap = $("assign");
wrap.innerHTML = "";
for (let i=0;i<hubCount;i++){
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = `Hub ${i+1}` + (i === 0 ? " (leader)" : "");
  const sel = document.createElement("select");
  trackInfos.forEach(t => {
    const o = document.createElement("option");
    o.value = t.i; o.textContent = `Track ${t.i+1} (${t.count} notes)`;
    sel.appendChild(o);
  });
  // default: give each hub a distinct track, melody-ish tracks first
  sel.value = String(defaultOrder[i % defaultOrder.length]);
  sel.addEventListener("change", () => { if (midiData) generate(); });
  field.append(label, sel);
  wrap.appendChild(field);
}
}

function readAssignments(hubCount){
const sels = [...$("assign").querySelectorAll("select")];
const out = [];
for (let i=0;i<hubCount;i++){
  out.push(sels[i] ? +sels[i].value : defaultOrder[i % defaultOrder.length]);
}
return out;
}

function onHubCountChange(){
const n = clamp(Math.round(+$("hubCount").value) || 1, 1, maxHubs());
$("hubCount").value = String(n);
const multi = n > 1;
$("assignRow").style.display = multi ? "block" : "none";
$("singleTrackField").style.display = multi ? "none" : "";
updateSyncTrimVisibility();
if (multi) buildAssignUI(n);
if (midiData) generate();
}

// Only Prime / Inventor hubs get the multi-hub (BLE sync) option.
function isMultiCapable(){
const h = $("hub").value;
return h === "PrimeHub" || h === "InventorHub";
}

function updateHubUI(){
const capable = isMultiCapable();
$("hubCountField").style.display = capable ? "" : "none";
$("multiHint").style.display = capable ? "block" : "none";
if (!capable) $("hubCount").value = "1";   // force single-hub for non-BLE hubs
onHubCountChange();
}

// the sync-trim and countdown fields only matter when there are 2+ hubs
function updateSyncTrimVisibility(){
const multi = isMultiCapable() && clamp(Math.round(+$("hubCount").value) || 1, 1, maxHubs()) > 1;
$("syncTrimField").style.display = multi ? "" : "none";
$("countdownField").style.display = multi ? "" : "none";
}

// ---------- viz (piano-roll of the extracted melody) ----------
// Piano-roll of every track being previewed, overlaid on one shared timeline.
// In multi-hub mode this shows all hubs' parts together (each a different colour),
// aligned exactly as they play; in single-hub mode it's just the one track.
//
// The piano-roll itself is drawn once into an offscreen canvas (vizBaseCanvas)
// and cached; playback then just redraws that cached image plus a thin playhead
// line every frame, which is cheap enough to run smoothly at 60fps without
// recomputing hundreds of note rectangles on every tick. The bar is draggable:
// dragging only moves the visual playhead (so scrubbing stays glitch-free), and
// releasing commits the seek -- restarting the live buffer at that position if
// the main preview is currently playing.
const VIZ_COLORS = ["#3fb950","#58a6ff","#d29922","#db61a2","#a371f7","#f0883e"];
let vizBaseCanvas = null;   // offscreen cache of the piano-roll pixels, no playhead

function drawViz(){
const c = $("viz"); c.classList.remove("hidden");
$("vizTime").classList.remove("hidden");
const dpr = window.devicePixelRatio||1;
const w = c.clientWidth, h = 100;
c.width=w*dpr; c.height=h*dpr;

const tracks = (previewTracks && previewTracks.length) ? previewTracks
             : (noteEvents ? [noteEvents] : []);
// pitch range and time span across ALL tracks so they share one grid
let lo = Infinity, hi = -Infinity, total = 0;
for (const ev of tracks){
  let dur = 0;
  for (const e of ev){ dur += e.ms; if(!e.rest){ if(e.midi<lo)lo=e.midi; if(e.midi>hi)hi=e.midi; } }
  if (dur > total) total = dur;
}
if(!isFinite(lo) || !total){ vizBaseCanvas = null; vizTotalSec = 0; return; }

const off = document.createElement("canvas");
off.width = c.width; off.height = c.height;
const g = off.getContext("2d");
g.scale(dpr,dpr);
g.globalAlpha = tracks.length > 1 ? 0.8 : 1;   // let overlapping parts show through
tracks.forEach((ev, ti) => {
  g.fillStyle = VIZ_COLORS[ti % VIZ_COLORS.length];
  let x = 0;
  for (const e of ev){
    const bw = (e.ms/total)*w;
    if(!e.rest){
      const y = h - ((e.midi-lo)/((hi-lo)||1))*(h-12) - 6;
      g.fillRect(x, y-3, Math.max(bw-1,1), 6);
    }
    x += bw;
  }
});
g.globalAlpha = 1;

vizBaseCanvas = off;
vizTotalSec = total / 1000;
seekSec = clamp(seekSec, 0, vizTotalSec);   // keep any existing seek position valid
renderVizFrame(currentMainSec());
updateVizTimeLabel(currentMainSec());
}

function fmtTime(sec){
sec = Math.max(0, Math.round(sec));
const m = Math.floor(sec/60), s = sec%60;
return `${m}:${String(s).padStart(2,"0")}`;
}

function updateVizTimeLabel(sec){
$("vizTime").textContent = `${fmtTime(sec)} / ${fmtTime(vizTotalSec)}`;
}

// Redraws the cached piano-roll plus a playhead line at the given position.
function renderVizFrame(sec){
const c = $("viz");
if (!vizBaseCanvas) return;
const g = c.getContext("2d");
g.setTransform(1,0,0,1,0,0);
g.clearRect(0,0,c.width,c.height);
g.drawImage(vizBaseCanvas, 0, 0);   // 1:1 device-pixel copy of the cached roll

const dpr = window.devicePixelRatio||1;
g.scale(dpr,dpr);
const w = c.width/dpr, h = c.height/dpr;
const x = vizTotalSec ? clamp((sec/vizTotalSec)*w, 0, w) : 0;
g.strokeStyle = "#f0f6fc";
g.lineWidth = 2;
g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke();
g.fillStyle = "#f0f6fc";
g.beginPath(); g.moveTo(x-5,0); g.lineTo(x+5,0); g.lineTo(x,7); g.closePath(); g.fill();
}

function stopVizLoop(){
if (vizRafId){ cancelAnimationFrame(vizRafId); vizRafId = null; }
}

function vizLoop(){
if (!vizDragging){
  const sec = currentMainSec();
  renderVizFrame(sec);
  updateVizTimeLabel(sec);
}
if (isMainPlaying()) vizRafId = requestAnimationFrame(vizLoop);
else vizRafId = null;
}

function startVizLoop(){
stopVizLoop();
vizLoop();
}

function vizFracFromEvent(e){
const c = $("viz");
const rect = c.getBoundingClientRect();
return rect.width ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
}

// Drag-move: update the visual playhead + time only, so scrubbing never
// restarts the audio node on every pointermove (that would click/glitch).
function updateSeekVisualFromEvent(e){
if (!vizTotalSec) return;
seekSec = clamp(vizFracFromEvent(e) * vizTotalSec, 0, vizTotalSec);
renderVizFrame(seekSec);
updateVizTimeLabel(seekSec);
}

// Drag-release (or a plain click): commit the seek -- if the main preview is
// currently playing, restart its buffer at the new position; otherwise just
// remember it as where the next Play should start from.
function commitSeek(){
if (!vizTotalSec) return;
if (isMainPlaying() && mainBuffer){
  if (playSourceNode){ try { playSourceNode.onended = null; playSourceNode.stop(); } catch(e){} playSourceNode = null; }
  const info = playBuffer(mainBuffer, mainOnEndCb, seekSec);
  playStartCtxTime = info.startCtxTime;
  playStartOffsetSec = info.offset;
}
renderVizFrame(seekSec);
updateVizTimeLabel(seekSec);
}

(() => {
const c = $("viz");
c.addEventListener("pointerdown", (e) => {
  if (!vizTotalSec) return;
  vizDragging = true;
  c.classList.add("dragging");
  c.setPointerCapture(e.pointerId);
  updateSeekVisualFromEvent(e);
});
c.addEventListener("pointermove", (e) => { if (vizDragging) updateSeekVisualFromEvent(e); });
const endDrag = (e) => {
  if (!vizDragging) return;
  vizDragging = false;
  c.classList.remove("dragging");
  updateSeekVisualFromEvent(e);
  commitSeek();
};
c.addEventListener("pointerup", endDrag);
c.addEventListener("pointercancel", () => { vizDragging = false; c.classList.remove("dragging"); });
})();

function setStatus(t){ $("status").textContent = t; }

// ---------- load & wiring ----------
async function handle(file){
const ic=$("dropIcon"); if(ic) ic.style.display="none";
$("dropText").innerHTML = `<strong>${file.name}</strong><br><span class="muted-s">${(file.size/1024).toFixed(0)} KB — click to replace</span>`;
try {
  const buf = await file.arrayBuffer();
  midiData = parseMidi(buf);
} catch(e){ setStatus("Couldn't parse this MIDI file: " + e.message); midiData=null; return; }

// populate track dropdown
const sel = $("track");
sel.innerHTML = '<option value="-1">All tracks (mixed)</option>';
let bestTrack = -1, bestAvg = -1;
midiData.tracks.forEach((tr,i)=>{
  if (tr.notes.length){
    const o=document.createElement("option");
    o.value=i; o.textContent=`Track ${i+1} (${tr.notes.length} notes)`;
    sel.appendChild(o);
    // track with the highest average pitch is usually the melody hand
    const avg = tr.notes.reduce((s,n)=>s+n.midi,0)/tr.notes.length;
    if (avg > bestAvg){ bestAvg = avg; bestTrack = i; }
  }
});
// default to the melody track, not the mashed-together "all tracks"
if (bestTrack !== -1) sel.value = String(bestTrack);

// multi-hub state: which tracks have notes, ordered melody-first for defaults
trackInfos = [];
midiData.tracks.forEach((tr,i)=>{
  if (tr.notes.length){
    trackInfos.push({ i, count: tr.notes.length, avg: tr.notes.reduce((s,n)=>s+n.midi,0)/tr.notes.length });
  }
});
defaultOrder = trackInfos.slice().sort((a,b)=>b.avg-a.avg).map(t=>t.i);
$("hubCount").max = String(maxHubs());
$("hubCount").value = "1";                 // start single-hub on every new file
$("assignRow").style.display = "none";
$("singleTrackField").style.display = "";
updateHubUI();                             // sync hub-count visibility to hub type

const totalNotes = midiData.tracks.reduce((s,t)=>s+t.notes.length,0);
const withNotes = midiData.tracks.filter(t=>t.notes.length).length;
setStatus(`Parsed ${withNotes} track(s) with notes, ${totalNotes} notes total.` +
  (withNotes>1 ? ` Using track ${bestTrack+1} (highest register) as the melody — switch tracks if needed.` : ""));
$("regen").disabled = false;
$("preview").disabled = false;
$("exportWav").disabled = false;
}

const drop=$("drop"), fileInput=$("file");
["dragover","dragenter"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add("over");}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("over");}));
drop.addEventListener("drop",ev=>{ const f=ev.dataTransfer.files[0]; if(f) handle(f); });
fileInput.addEventListener("change",ev=>{ const f=ev.target.files[0]; if(f) handle(f); });
$("regen").addEventListener("click", () => {
const btn = $("regen");
generate();
btn.classList.add("ok");
btn.textContent = "Regenerated ✓";
clearTimeout(btn._t);
btn._t = setTimeout(() => { btn.classList.remove("ok"); btn.textContent = "Regenerate"; }, 1200);
});
["voice","track","speed","gapMs","volume","syncTrim","countdownSec"].forEach(id=>$(id).addEventListener("change", ()=>{ if(midiData) generate(); }));
$("hub").addEventListener("change", ()=>{ if(midiData) updateHubUI(); });
$("hubCount").addEventListener("input", onHubCountChange);
$("hubCount").addEventListener("change", onHubCountChange);
$("preview").addEventListener("click", () => togglePreview($("preview"), previewTracks, "▶ Preview audio", "◼ Stop"));
$("exportWav").addEventListener("click", exportWav);