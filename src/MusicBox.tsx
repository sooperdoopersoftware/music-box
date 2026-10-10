"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Barrel,
  PRESET_BARRELS,
  PRONGS,
  STEPS,
  blankBarrel,
  cloneBarrel,
  deleteSavedBarrel,
  forkId,
  loadSavedBarrels,
  persistBarrel,
} from "./music-box";
import { pluck, primeAudio, setDelayAmount, setDelayTime, setReverbAmount, syncAudioClock } from "./music-synth";

// A horizontal cylinder viewed from the side: its length runs left-to-right
// (one track per prong, matching the comb laid out the same way above it),
// and each track's pins orbit a small circle at that track's x position —
// what a point on a spinning cylinder's surface looks like from the side.
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 300;
const BARREL_CENTER_Y = 190;
const BARREL_RADIUS = 62;
const TRACK_MARGIN = 46;
const WOBBLE_PX = 14; // horizontal "roundness" wobble as a track's pin orbits
const READ_ANGLE = 0; // 0 = top of the orbit, where pins trigger their prong
const FLASH_DURATION = 0.25; // seconds
const COMB_LONGEST_TOOTH = 34; // lowest pitch
const COMB_SHORTEST_TOOTH = 20; // highest pitch

// Steps are detected on animation frames, which land a few milliseconds
// early or late. Each pluck is scheduled this far ahead on the audio clock,
// less however long ago its step actually passed, so the rhythm comes out
// even regardless of frame timing.
const SCHEDULE_AHEAD = 0.05; // seconds
const DELAY_STEPS = 1.5; // echo spacing, in steps — a dotted step, so echoes fall between the notes

// Editor grid geometry, shared by the cells and the playhead over them.
const EDITOR_CELL_PX = 16;
const EDITOR_GAP_PX = 4;
const EDITOR_LABEL_PX = 40;
const EDITOR_PITCH_PX = EDITOR_CELL_PX + EDITOR_GAP_PX;

// Tempo knob. A step is an eighth of a beat pair — quarter notes in the
// presets are 2 steps apart — so a revolution's beat count is STEPS/2.
const BEATS_PER_REVOLUTION = STEPS / 2;
const MIN_BPM = 40;
const MAX_BPM = 240;
const DEFAULT_BPM = 120;
const KNOB_DRAG_RANGE_PX = 180; // vertical drag distance spanning the full knob range
const KNOB_SWEEP_DEG = 270; // total rotation sweep, centered (-135deg to +135deg)

function cssColorToRgb(colorString: string): [number, number, number] {
  if (typeof document === "undefined") return [0, 0, 0];
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colorString;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function trackX(prongIndex: number): number {
  return TRACK_MARGIN + (prongIndex / (PRONGS.length - 1)) * (CANVAS_WIDTH - 2 * TRACK_MARGIN);
}

function Knob({
  value,
  min,
  max,
  onChange,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  format: (value: number) => string;
}) {
  const dragStart = useRef<{ y: number; value: number } | null>(null);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = { y: e.clientY, value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const dy = start.y - e.clientY; // dragging up increases the value
    const range = max - min;
    const next = Math.round(start.value + (dy / KNOB_DRAG_RANGE_PX) * range);
    onChange(Math.min(max, Math.max(min, next)));
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    let next: number;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = value + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = value - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };

  const t = (value - min) / (max - min);
  const angle = -KNOB_SWEEP_DEG / 2 + t * KNOB_SWEEP_DEG;

  return (
    <div className="flex items-center gap-2">
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        className="relative h-9 w-9 shrink-0 select-none rounded-full border border-foreground/20 bg-foreground/5"
        style={{ touchAction: "none", cursor: "ns-resize" }}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
      >
        <div
          className="absolute inset-0 flex justify-center"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="mt-1 h-3 w-0.5 rounded-full bg-accent" />
        </div>
      </div>
      <span className="w-28 shrink-0 font-mono tabular-nums text-foreground/50">{format(value)}</span>
    </div>
  );
}

export default function MusicBox() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [barrels, setBarrels] = useState<Barrel[]>(() => [...PRESET_BARRELS, ...loadSavedBarrels()]);
  const [selectedId, setSelectedId] = useState(PRESET_BARRELS[0].id);
  const [workingBarrel, setWorkingBarrel] = useState<Barrel>(() =>
    cloneBarrel(PRESET_BARRELS[0], { isPreset: true }),
  );
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [delayMix, setDelayMix] = useState(0);
  const [reverbMix, setReverbMix] = useState(0);
  const [editing, setEditing] = useState(false);

  const workingBarrelRef = useRef(workingBarrel);
  const isPlayingRef = useRef(playing);
  const revolutionSecondsRef = useRef((BEATS_PER_REVOLUTION * 60) / DEFAULT_BPM);
  // Comb tooth glow is per-prong (only one tooth per pitch). Pin glow is per
  // (prong, step) so only the specific pin that was actually struck lights
  // up, not every pin of that same pitch elsewhere on the barrel.
  const flashRef = useRef<number[]>(new Array(PRONGS.length).fill(-Infinity));
  const pinFlashRef = useRef<number[][]>(PRONGS.map(() => new Array(STEPS).fill(-Infinity)));

  useEffect(() => {
    workingBarrelRef.current = workingBarrel;
  }, [workingBarrel]);
  useEffect(() => {
    isPlayingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    revolutionSecondsRef.current = (BEATS_PER_REVOLUTION * 60) / bpm;
    // Keep the echoes locked to the tempo instead of a fixed time.
    setDelayTime((DELAY_STEPS * revolutionSecondsRef.current) / STEPS);
  }, [bpm]);
  useEffect(() => {
    setDelayAmount(delayMix / 100);
  }, [delayMix]);
  useEffect(() => {
    setReverbAmount(reverbMix / 100);
  }, [reverbMix]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_WIDTH * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    let wallCss: string;
    let accentCss: string;
    const readColors = () => {
      const rootStyle = getComputedStyle(document.documentElement);
      const wallColor = cssColorToRgb(rootStyle.getPropertyValue("--foreground").trim() || "#171717");
      const accentColor = cssColorToRgb(rootStyle.getPropertyValue("--accent").trim() || "#d97706");
      wallCss = `rgba(${wallColor[0]}, ${wallColor[1]}, ${wallColor[2]}, `;
      accentCss = `rgba(${accentColor[0]}, ${accentColor[1]}, ${accentColor[2]}, `;
    };
    readColors();
    // The theme variables follow the OS colour scheme; pick up a switch
    // without needing a reload.
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", readColors);

    let rafId: number;
    let lastTime = performance.now();
    // Start a hair before step 0 so the first frame of playback crosses it
    // and the opening note sounds, instead of waiting a whole revolution.
    let stepAcc = -1e-6;

    const cy = BARREL_CENTER_Y;
    const leftCap = trackX(0);
    const rightCap = trackX(PRONGS.length - 1);

    const draw = (nowSeconds: number) => {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const barrel = workingBarrelRef.current;
      const currentStep = ((stepAcc % STEPS) + STEPS) % STEPS;

      // Comb legend across the top: one tooth per prong, low pitch to high,
      // positioned directly above its track, glowing when just plucked.
      const combY = 16;
      ctx.strokeStyle = wallCss + "0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(leftCap, combY);
      ctx.lineTo(rightCap, combY);
      ctx.stroke();

      for (let p = 0; p < PRONGS.length; p++) {
        const tx = trackX(p);
        // Longer teeth for lower notes, like a real comb.
        const combHeight =
          COMB_LONGEST_TOOTH - (p / (PRONGS.length - 1)) * (COMB_LONGEST_TOOTH - COMB_SHORTEST_TOOTH);
        const glow = Math.max(0, 1 - (nowSeconds - flashRef.current[p]) / FLASH_DURATION);
        ctx.strokeStyle = glow > 0 ? accentCss + "1)" : wallCss + "0.5)";
        ctx.lineWidth = glow > 0 ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(tx, combY);
        ctx.lineTo(tx, combY + combHeight + glow * 6);
        ctx.stroke();
      }

      // Barrel body: two end-cap ellipses (the round ends, seen edge-on)
      // joined by top/bottom lines — a simple horizontal-cylinder silhouette.
      ctx.strokeStyle = wallCss + "0.3)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(leftCap, cy, BARREL_RADIUS * 0.28, BARREL_RADIUS, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(rightCap, cy, BARREL_RADIUS * 0.28, BARREL_RADIUS, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(leftCap, cy - BARREL_RADIUS);
      ctx.lineTo(rightCap, cy - BARREL_RADIUS);
      ctx.moveTo(leftCap, cy + BARREL_RADIUS);
      ctx.lineTo(rightCap, cy + BARREL_RADIUS);
      ctx.stroke();

      // Read line: the top edge is where every track's pins trigger.
      ctx.strokeStyle = wallCss + "0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(leftCap, cy - BARREL_RADIUS);
      ctx.lineTo(rightCap, cy - BARREL_RADIUS);
      ctx.stroke();
      ctx.setLineDash([]);

      // Faint per-track guide lines down the barrel's length.
      for (let p = 0; p < PRONGS.length; p++) {
        const tx = trackX(p);
        ctx.strokeStyle = wallCss + "0.12)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, cy - BARREL_RADIUS);
        ctx.lineTo(tx, cy + BARREL_RADIUS);
        ctx.stroke();
      }

      // Pins: each orbits a small vertical circle at its track's x position —
      // what a point on the spinning cylinder's surface looks like from the
      // side. angle=0 (top of the orbit) is the read position.
      for (let p = 0; p < PRONGS.length; p++) {
        const tx = trackX(p);
        for (let s = 0; s < STEPS; s++) {
          if (!barrel.pins[p][s]) continue;
          const angle = READ_ANGLE + ((s - currentStep) / STEPS) * Math.PI * 2;
          const px = tx + WOBBLE_PX * Math.sin(angle);
          const py = cy - BARREL_RADIUS * Math.cos(angle);
          // Depth cue: brighter/bigger near the read line (front), dimmer
          // and smaller on the far side of the cylinder.
          const depth = Math.cos(angle) * 0.5 + 0.5;
          const glow = Math.max(0, 1 - (nowSeconds - pinFlashRef.current[p][s]) / FLASH_DURATION);
          const radius = 2 + depth * 1.5 + glow * 3;
          ctx.fillStyle = glow > 0.05 ? accentCss + "1)" : wallCss + `${0.25 + depth * 0.4})`;
          ctx.beginPath();
          ctx.arc(px, py, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const nowSeconds = now / 1000;
      syncAudioClock();

      if (isPlayingRef.current) {
        const stepsPerSecond = STEPS / revolutionSecondsRef.current;
        const prevAcc = stepAcc;
        stepAcc += dt * stepsPerSecond;
        const prevFloor = Math.floor(prevAcc);
        const currFloor = Math.floor(stepAcc);
        const barrel = workingBarrelRef.current;
        for (let s = prevFloor + 1; s <= currFloor; s++) {
          const stepIndex = ((s % STEPS) + STEPS) % STEPS;
          const sinceStep = (stepAcc - s) / stepsPerSecond;
          for (let p = 0; p < PRONGS.length; p++) {
            if (barrel.pins[p][stepIndex]) {
              pluck(PRONGS[p].freq, 1, SCHEDULE_AHEAD - sinceStep);
              flashRef.current[p] = nowSeconds;
              pinFlashRef.current[p][stepIndex] = nowSeconds;
            }
          }
        }
      }

      draw(nowSeconds);
      // The editor's playhead is moved directly rather than through React
      // state, which would re-render the whole grid on every step.
      const playhead = playheadRef.current;
      if (playhead) {
        const column = ((Math.floor(stepAcc) % STEPS) + STEPS) % STEPS;
        playhead.style.transform = `translateX(${column * EDITOR_PITCH_PX}px)`;
        playhead.style.opacity = stepAcc >= 0 ? "1" : "0";
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      colorScheme.removeEventListener("change", readColors);
    };
  }, []);

  const selectBarrel = (id: string) => {
    const found = barrels.find((b) => b.id === id);
    if (!found) return;
    setSelectedId(id);
    setWorkingBarrel(cloneBarrel(found, { isPreset: found.isPreset }));
  };

  const togglePin = (prongIndex: number, step: number) => {
    const base: Barrel = workingBarrel.isPreset
      ? cloneBarrel(workingBarrel, { id: forkId(), name: `${workingBarrel.name} copy` })
      : workingBarrel;

    const pins = base.pins.map((row, r) =>
      r === prongIndex ? row.map((value, s) => (s === step ? !value : value)) : row,
    );
    const target: Barrel = { ...base, pins };
    // Sound a pin as it's placed, so writing a tune doesn't mean waiting
    // for the barrel to come round to hear each note.
    if (pins[prongIndex][step]) pluck(PRONGS[prongIndex].freq);

    if (workingBarrel.isPreset) {
      setBarrels((bs) => [...bs, target]);
      setSelectedId(target.id);
    }
    setWorkingBarrel(target);
  };

  const handleNew = () => {
    const fresh = blankBarrel(`Barrel ${barrels.length + 1}`);
    setBarrels((bs) => [...bs, fresh]);
    setSelectedId(fresh.id);
    setWorkingBarrel(cloneBarrel(fresh, { isPreset: false }));
    setEditing(true);
  };

  const handleSave = () => {
    persistBarrel(workingBarrel);
    setBarrels((bs) => [...bs.filter((b) => b.id !== workingBarrel.id), workingBarrel]);
  };

  const handleDelete = () => {
    if (workingBarrel.isPreset) return;
    deleteSavedBarrel(workingBarrel.id);
    setBarrels((bs) => bs.filter((b) => b.id !== workingBarrel.id));
    const fallback = PRESET_BARRELS[0];
    setSelectedId(fallback.id);
    setWorkingBarrel(cloneBarrel(fallback, { isPreset: true }));
  };

  const togglePlay = () => {
    if (!playing) primeAudio();
    setPlaying((p) => !p);
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", maxWidth: CANVAS_WIDTH, aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
      />

      <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded-full border border-foreground/20 px-4 py-1.5 text-foreground/70 hover:border-accent/50 hover:text-accent"
        >
          {playing ? "Pause" : "Play"}
        </button>

        <select
          value={selectedId}
          onChange={(e) => selectBarrel(e.target.value)}
          className="rounded-full border border-foreground/20 bg-transparent px-4 py-1.5 text-foreground/70"
        >
          {barrels.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="rounded-full border border-foreground/20 px-4 py-1.5 text-foreground/70 hover:border-accent/50 hover:text-accent"
        >
          {editing ? "Hide editor" : "Edit barrel"}
        </button>

        <Knob value={bpm} min={MIN_BPM} max={MAX_BPM} onChange={setBpm} label="Tempo" format={(v) => `${v} bpm`} />
        <Knob value={delayMix} min={0} max={100} onChange={setDelayMix} label="Delay" format={(v) => `delay ${v}%`} />
        <Knob
          value={reverbMix}
          min={0}
          max={100}
          onChange={setReverbMix}
          label="Reverb"
          format={(v) => `reverb ${v}%`}
        />
      </div>

      {editing && (
        <div className="w-full">
          <div className="mb-3 flex flex-wrap items-center justify-center gap-3 text-sm">
            <input
              value={workingBarrel.name}
              disabled={workingBarrel.isPreset}
              onChange={(e) => setWorkingBarrel({ ...workingBarrel, name: e.target.value })}
              className="rounded-full border border-foreground/20 bg-transparent px-3 py-1 text-foreground/70 disabled:opacity-40"
            />
            <button
              type="button"
              onClick={handleNew}
              className="rounded-full border border-foreground/20 px-3 py-1 text-foreground/70 hover:border-accent/50 hover:text-accent"
            >
              New
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={workingBarrel.isPreset}
              className="rounded-full border border-foreground/20 px-3 py-1 text-foreground/70 hover:border-accent/50 hover:text-accent disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={workingBarrel.isPreset}
              className="rounded-full border border-foreground/20 px-3 py-1 text-foreground/70 hover:border-red-400/50 hover:text-red-400 disabled:opacity-40"
            >
              Delete
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-foreground/10 p-3">
            <div
              className="relative flex flex-col gap-0.5"
              style={{ minWidth: EDITOR_LABEL_PX + STEPS * EDITOR_PITCH_PX }}
            >
              <div
                ref={playheadRef}
                className="pointer-events-none absolute inset-y-0 rounded-sm bg-accent/20"
                style={{ left: EDITOR_LABEL_PX + EDITOR_GAP_PX, width: EDITOR_CELL_PX, opacity: 0 }}
              />
              {[...PRONGS].map((prong, displayIndex) => {
                const prongIndex = PRONGS.length - 1 - displayIndex;
                return (
                  <div key={prong.midi} className="flex items-center gap-1">
                    <span className="w-10 shrink-0 font-mono text-xs text-foreground/40">
                      {PRONGS[prongIndex].label}
                    </span>
                    {Array.from({ length: STEPS }).map((_, step) => {
                      const active = workingBarrel.pins[prongIndex][step];
                      return (
                        <button
                          key={step}
                          type="button"
                          onClick={() => togglePin(prongIndex, step)}
                          className={`h-4 w-4 shrink-0 rounded-sm border ${
                            active
                              ? "border-accent bg-accent"
                              : `${step % 4 === 0 ? "border-foreground/30" : "border-foreground/10"} bg-foreground/5 hover:bg-foreground/10`
                          }`}
                          aria-label={`${PRONGS[prongIndex].label} at step ${step + 1}`}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
