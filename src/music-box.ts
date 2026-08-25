// Data model for the music box: a shared comb of prongs (fixed pitches) and
// swappable "barrels" — grids of pins (which step, on which prong) that get
// plucked as the barrel rotates past a fixed read point.

export const STEPS = 32;

// C4 up to A5, a plain major scale — plenty of range for plinky melodies
// without needing sharps/flats in the UI.
const SCALE_MIDI = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81];
const NOTE_LABELS = [
  "C4", "D4", "E4", "F4", "G4", "A4", "B4",
  "C5", "D5", "E5", "F5", "G5", "A5",
];

export interface Prong {
  midi: number;
  label: string;
  freq: number;
}

export const PRONGS: Prong[] = SCALE_MIDI.map((midi, i) => ({
  midi,
  label: NOTE_LABELS[i],
  freq: 440 * Math.pow(2, (midi - 69) / 12),
}));

export interface Barrel {
  id: string;
  name: string;
  /** pins[prongIndex][step] */
  pins: boolean[][];
  /** Presets can't be saved over — editing them forks a new custom barrel. */
  readonly isPreset?: boolean;
}

export function emptyPins(): boolean[][] {
  return PRONGS.map(() => new Array(STEPS).fill(false));
}

export function cloneBarrel(barrel: Barrel, overrides: Partial<Barrel> = {}): Barrel {
  return {
    ...barrel,
    isPreset: false,
    ...overrides,
    pins: barrel.pins.map((row) => [...row]),
  };
}

function prongIndexForMidi(midi: number): number {
  return SCALE_MIDI.indexOf(midi);
}

function barrelFromNotes(
  id: string,
  name: string,
  notes: Array<{ step: number; midi: number }>,
): Barrel {
  const pins = emptyPins();
  for (const { step, midi } of notes) {
    const prong = prongIndexForMidi(midi);
    if (prong === -1) continue;
    pins[prong][step % STEPS] = true;
  }
  return { id, name, pins, isPreset: true };
}

// "Twinkle Twinkle Little Star", first phrase, quantized to a 32-step loop
// (quarter notes = 2 steps, the two held notes = 4 steps).
const TWINKLE = barrelFromNotes("preset:twinkle", "Twinkle Twinkle", [
  { step: 0, midi: 60 },
  { step: 2, midi: 60 },
  { step: 4, midi: 67 },
  { step: 6, midi: 67 },
  { step: 8, midi: 69 },
  { step: 10, midi: 69 },
  { step: 12, midi: 67 },
  { step: 16, midi: 65 },
  { step: 18, midi: 65 },
  { step: 20, midi: 64 },
  { step: 22, midi: 64 },
  { step: 24, midi: 62 },
  { step: 26, midi: 62 },
  { step: 28, midi: 60 },
]);

// A simple original up-and-down run across the whole scale.
const ARPEGGIO = barrelFromNotes(
  "preset:arpeggio",
  "Scale Runner",
  SCALE_MIDI.flatMap((midi, i) => [
    { step: i * 2, midi },
    { step: 26 - i * 2 >= 0 ? 26 - i * 2 : 0, midi: SCALE_MIDI[SCALE_MIDI.length - 1 - i] },
  ]),
);

// A bouncy broken-chord arpeggio (root-third-fifth, climbing up to a ninth
// then settling back down) with tight eighth-note-ish spacing for a lively
// bounce rather than a steady scale run.
const BOUNCE_SCALE_INDICES = [0, 2, 4, 7, 9, 7, 4, 2, 0, 4, 7, 11, 12, 11, 7, 4];
const ARPEGGIO_BOUNCE = barrelFromNotes(
  "preset:arpeggio-bounce",
  "Arpeggio Bounce",
  BOUNCE_SCALE_INDICES.map((scaleIndex, i) => ({
    step: i * 2,
    midi: SCALE_MIDI[scaleIndex],
  })),
);

export function forkId(): string {
  return `custom:${Date.now()}`;
}

export function blankBarrel(name = "New barrel"): Barrel {
  return { id: forkId(), name, pins: emptyPins() };
}

export const PRESET_BARRELS: Barrel[] = [TWINKLE, ARPEGGIO, ARPEGGIO_BOUNCE];

const STORAGE_KEY = "sooper-dooper:music-box:barrels";

export function loadSavedBarrels(): Barrel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Barrel[];
  } catch {
    return [];
  }
}

export function persistBarrel(barrel: Barrel) {
  if (typeof window === "undefined") return;
  const existing = loadSavedBarrels().filter((b) => b.id !== barrel.id);
  const updated = [...existing, { ...barrel, isPreset: false }];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function deleteSavedBarrel(id: string) {
  if (typeof window === "undefined") return;
  const updated = loadSavedBarrels().filter((b) => b.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}
