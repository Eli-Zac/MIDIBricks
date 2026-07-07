# MIDIBricks

Turn a MIDI file into ready-to-run [Pybricks](https://pybricks.com/) code that plays the melody through a LEGO® hub's built-in speaker.

Upload a `.mid` file in the browser, MIDIBricks extracts a single-voice melody line and emits a Python `beep` sequence you can paste straight into the Pybricks editor and run on your hub.

## Features

- **Client-side MIDI parser** — Standard MIDI Files are parsed entirely in the browser; nothing is uploaded to a server.
- **Melody extraction** — flattens polyphonic MIDI down to a monophonic line, keeping either the highest note (melody) or lowest note (bass) at each onset.
- **Tempo-aware timing** — reads the MIDI tempo map to convert ticks to real millisecond durations.
- **Smart track picking** — auto-selects the track in the highest register (usually the melody hand), or choose a specific track / all tracks.
- **Tunable output** — adjust playback speed, gap between notes, and volume.
- **Piano-roll preview** — visualizes the extracted melody before you export.
- **Copy or download** — grab the generated `.py` code with one click.
- **Multi-hub support** — TechnicHub, PrimeHub, InventorHub, MoveHub, and CityHub.

## Usage

This is a static site — no build step or dependencies.

1. Serve the `public/` directory with any static file server, for example:

   ```bash
   npx serve public
   # or
   python -m http.server -d public 8000
   ```

   (You can also just open `public/index.html` directly in a browser.)

2. Drop a `.mid` / `.midi` file onto the page, or click to browse.

3. Tweak the settings if needed:

   | Setting | What it does |
   | --- | --- |
   | **Voice to keep** | Keep the highest note (melody) or lowest note (bass) at each moment. |
   | **Track** | Use all tracks mixed, or isolate a single track. |
   | **Speed (%)** | Scale playback tempo (10–400%). |
   | **Gap between notes (ms)** | Small silence inserted after every note. |
   | **Volume (0–100)** | Hub speaker volume. |
   | **Hub** | Target Pybricks hub class. |

4. Copy or download the generated Python and run it in the [Pybricks editor](https://code.pybricks.com/).

## Generated code

The output is a self-contained Pybricks program: note frequencies defined as
constants, a `melody` list of `(frequency, duration_ms)` tuples (frequency `0`
means a silent rest), and a loop that beeps each note through
`hub.speaker.beep(...)`.

```python
from pybricks.hubs import TechnicHub
from pybricks.tools import wait

hub = TechnicHub()
hub.speaker.volume(100)

# Note frequencies (Hz)
C4 = 262
E4 = 330
G4 = 392

melody = [
    (C4, 400), (E4, 400), (G4, 400),
]

print("Playing melody...")
for frequency, duration in melody:
    if frequency == 0:
        wait(duration)
    else:
        hub.speaker.beep(frequency, duration)
    wait(10)  # small gap between notes

wait(500)
```

## Project structure

```
public/
├── index.html   # UI and controls
├── script.js    # MIDI parser, melody extraction, code generator, viz
└── styles.css   # styling
```

## How it works

1. **Parse** — `parseMidi()` reads the SMF header and each `MTrk` chunk,
   handling running status, meta events (including tempo), sysex, and
   note on/off pairs to build per-track note lists.
2. **Time** — `buildTickToMs()` walks the tempo map to convert tick positions
   into absolute milliseconds.
3. **Flatten** — `flatten()` groups near-simultaneous notes into onsets
   (~30 ms window), picks the melody/bass voice per onset, and derives note
   durations and musically meaningful rests (rests are capped so silences
   never drag).
4. **Generate** — `renderCode()` maps notes to frequency constants and emits
   the Pybricks program.

## Notes & limitations

- SMPTE time-division MIDI files aren't supported — re-export with
  ticks-per-beat (PPQ) timing.
- Output is strictly monophonic; chords are reduced to one note per onset.
- Rests become silent pauses (frequency `0`) in the generated code.

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.
