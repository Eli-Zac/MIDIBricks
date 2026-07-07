const $ = id => document.getElementById(id);
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
let midiData = null;   // parsed { tracks:[{notes:[{midi,start,end}]}], ppq }
let noteEvents = null; // flattened melody events for current settings

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
function flatten(){
if (!midiData) return;
const voice = $("voice").value;   // high | low
const trackSel = +$("track").value;
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
if (!all.length){ noteEvents=[]; return; }
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
const RESTCAP = 700; // never emit a silence longer than this (ms)
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
noteEvents = events;
}

function round(x){ return Math.round(x); }

// ---------- generate & render ----------
function generate(){
flatten();
if (!noteEvents || !noteEvents.length){ setStatus("No notes found in this file/track."); return; }
// drop leading rest and trailing rest
while (noteEvents.length && noteEvents[0].rest) noteEvents.shift();
while (noteEvents.length && noteEvents[noteEvents.length-1].rest) noteEvents.pop();
drawViz();
renderCode(noteEvents);
}

function renderCode(events){
const hub = $("hub").value;
const gap = clamp(+$("gapMs").value || 0, 0, 200);
const vol = clamp(Math.round(+$("volume").value), 0, 100);

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

const restCount = events.filter(e=>e.rest).length;
$("restWarn").textContent = restCount ? `${restCount} rest(s) become silent pauses (frequency 0).` : "";

const code =
`from pybricks.hubs import ${hub}
from pybricks.tools import wait

# Auto-generated from a MIDI file
hub = ${hub}()
hub.speaker.volume(${vol})

# Note frequencies (Hz)
${constLines.join("\n")}

# (frequency, duration_ms)  -- frequency 0 = silent pause
melody = [
${lines.join("\n")}
]

print("Playing melody...")
for frequency, duration in melody:
  if frequency == 0:
      wait(duration)
  else:
      hub.speaker.beep(frequency, duration)
  wait(${gap})  # small gap between notes

wait(500)
`;
$("out").textContent = code;
$("outPanel").style.display = "block";
}

// ---------- viz (piano-roll of the extracted melody) ----------
function drawViz(){
const c = $("viz"); c.classList.remove("hidden");
const dpr = window.devicePixelRatio||1;
const w = c.clientWidth, h = 100;
c.width=w*dpr; c.height=h*dpr;
const g=c.getContext("2d"); g.scale(dpr,dpr); g.clearRect(0,0,w,h);
const ev = noteEvents.filter(e=>!e.rest);
if(!ev.length) return;
const total = noteEvents.reduce((s,e)=>s+e.ms,0);
const lo = Math.min(...ev.map(e=>e.midi)), hi = Math.max(...ev.map(e=>e.midi));
let x=0;
g.fillStyle="#3fb950";
for (const e of noteEvents){
  const bw = (e.ms/total)*w;
  if(!e.rest){
    const y = h - ((e.midi-lo)/((hi-lo)||1))*(h-12) - 6;
    g.fillRect(x, y-3, Math.max(bw-1,1), 6);
  }
  x += bw;
}
}

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
const totalNotes = midiData.tracks.reduce((s,t)=>s+t.notes.length,0);
const withNotes = midiData.tracks.filter(t=>t.notes.length).length;
setStatus(`Parsed ${withNotes} track(s) with notes, ${totalNotes} notes total.` +
  (withNotes>1 ? ` Using track ${bestTrack+1} (highest register) as the melody — switch tracks if needed.` : ""));
$("regen").disabled = false;
generate();
}

const drop=$("drop"), fileInput=$("file");
["dragover","dragenter"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add("over");}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("over");}));
drop.addEventListener("drop",ev=>{ const f=ev.dataTransfer.files[0]; if(f) handle(f); });
fileInput.addEventListener("change",ev=>{ const f=ev.target.files[0]; if(f) handle(f); });
$("regen").addEventListener("click", generate);
["voice","track","speed","gapMs","volume","hub"].forEach(id=>$(id).addEventListener("change", ()=>{ if(midiData) generate(); }));
$("copyBtn").addEventListener("click",()=>{ navigator.clipboard.writeText($("out").textContent); $("copyBtn").textContent="Copied"; setTimeout(()=>$("copyBtn").textContent="Copy",1200); });
$("dlBtn").addEventListener("click",()=>{
const blob=new Blob([$("out").textContent],{type:"text/x-python"});
const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="melody.py"; a.click();
});