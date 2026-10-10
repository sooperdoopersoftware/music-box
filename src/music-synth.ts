// Tiny Web Audio "music box tine" synth — no audio assets. Each pluck is a
// few short-decaying oscillators, fed dry to the output plus parallel
// sends into a delay and a reverb bus (both built from scratch, no files).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let delaySend: GainNode | null = null;
let delayNode: DelayNode | null = null;
let reverbSend: GainNode | null = null;
let convolver: ConvolverNode | null = null;

const MAX_DELAY_TIME = 2; // seconds
const DELAY_FEEDBACK = 0.35;
const MAX_DELAY_SEND = 0.6; // caps how loud the delay send can get at 100%
const MAX_REVERB_SEND = 0.8;
const LOWEST_FREQ = 261.63; // C4, the longest-ringing tine
const RING_SECONDS = 1.1; // how long the lowest tine rings

// The knobs can be turned before the first Play creates the audio graph, so
// remember what they asked for and apply it when the graph is built.
let delayAmount = 0;
let reverbAmount = 0;
let delayTime = 0.32; // seconds

/** White noise shaped with an exponential decay — a plain algorithmic reverb tail, no IR file needed. */
function makeImpulseResponse(audioCtx: AudioContext, duration = 2.2, decay = 3.2): AudioBuffer {
  const rate = audioCtx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function setupEffects(audioCtx: AudioContext) {
  // Everything sums here and goes through a limiter: chords, ringing tails
  // and the wet buses stack well past full scale otherwise, and clip.
  master = audioCtx.createGain();
  master.gain.value = 0.9;
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter);
  limiter.connect(audioCtx.destination);

  delayNode = audioCtx.createDelay(MAX_DELAY_TIME);
  delayNode.delayTime.value = delayTime;
  const delayFeedback = audioCtx.createGain();
  delayFeedback.gain.value = DELAY_FEEDBACK;
  delaySend = audioCtx.createGain();
  delaySend.gain.value = delayAmount * MAX_DELAY_SEND;

  delaySend.connect(delayNode);
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayNode.connect(master);

  convolver = audioCtx.createConvolver();
  convolver.buffer = makeImpulseResponse(audioCtx);
  reverbSend = audioCtx.createGain();
  reverbSend.gain.value = reverbAmount * MAX_REVERB_SEND;

  reverbSend.connect(convolver);
  convolver.connect(master);
}

function getContext(): AudioContext {
  if (!ctx) {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AudioContextCtor();
    setupEffects(ctx);
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

// `currentTime` only moves forward once per output buffer — in steps of a
// few milliseconds on most hardware, tens of milliseconds on some — so
// reading it directly snaps every note to the nearest buffer and the rhythm
// lurches. The performance clock is smooth; track the offset between the two
// at its high-water mark (the readings taken just after a buffer boundary)
// and derive audio time from that instead.
let clockOffset = -Infinity; // audio clock minus performance clock, seconds
const CLOCK_SLACK_PER_READ = 2e-6; // lets the estimate follow drift between the clocks
const CLOCK_RESYNC_GAP = 0.2; // further ahead of currentTime than any buffer: the context was paused

function audioNow(audioCtx: AudioContext): number {
  const perf = performance.now() / 1000;
  const observed = audioCtx.currentTime - perf;
  clockOffset = Math.max(clockOffset - CLOCK_SLACK_PER_READ, observed);
  if (clockOffset - observed > CLOCK_RESYNC_GAP) clockOffset = observed;
  return perf + clockOffset;
}

/** Call once per animation frame so scheduled plucks land on an accurate clock. */
export function syncAudioClock() {
  if (ctx) audioNow(ctx);
}

/** Call this from a user-gesture handler (e.g. the Play button) to satisfy autoplay policies. */
export function primeAudio() {
  getContext();
}

/** 0-1 wet amount for the delay send. */
export function setDelayAmount(amount: number) {
  delayAmount = amount;
  if (ctx && delaySend) delaySend.gain.setTargetAtTime(amount * MAX_DELAY_SEND, ctx.currentTime, 0.02);
}

/** 0-1 wet amount for the reverb send. */
export function setReverbAmount(amount: number) {
  reverbAmount = amount;
  if (ctx && reverbSend) reverbSend.gain.setTargetAtTime(amount * MAX_REVERB_SEND, ctx.currentTime, 0.02);
}

/** Time between echoes, in seconds — set it from the tempo to keep the echoes on the beat. */
export function setDelayTime(seconds: number) {
  delayTime = Math.min(MAX_DELAY_TIME, Math.max(0.03, seconds));
  if (ctx && delayNode) delayNode.delayTime.setTargetAtTime(delayTime, ctx.currentTime, 0.05);
}

function partial(
  audioCtx: AudioContext,
  type: OscillatorType,
  freq: number,
  peak: number,
  attack: number,
  decay: number,
  start: number,
) {
  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
  osc.connect(gain);
  if (master) gain.connect(master);
  if (delaySend) gain.connect(delaySend);
  if (reverbSend) gain.connect(reverbSend);
  osc.start(start);
  osc.stop(start + decay + 0.05);
}

/**
 * Pluck a tine. `delaySeconds` schedules it that far ahead on the audio
 * clock, which is how a caller driven by animation frames keeps the rhythm
 * even: frames land a few milliseconds early or late, the audio clock doesn't.
 */
export function pluck(freq: number, velocity = 1, delaySeconds = 0) {
  const audioCtx = getContext();
  const start = audioNow(audioCtx) + Math.max(0, delaySeconds);
  const peak = 0.28 * velocity;
  // Shorter tines ring for less time, as on a real comb.
  const ring = RING_SECONDS * Math.pow(LOWEST_FREQ / freq, 0.4);

  partial(audioCtx, "triangle", freq, peak, 0.005, ring, start);
  // A brief bright overtone on top gives it more of a metal-tine "plink"
  // than a plain triangle wave alone.
  partial(audioCtx, "sine", freq * 2, peak * 0.35, 0.004, ring * 0.5, start);
  // And a very short inharmonic one for the strike itself — the second mode
  // of a bar clamped at one end sits about 6.27x above its fundamental.
  partial(audioCtx, "sine", freq * 6.27, peak * 0.1, 0.002, 0.08, start);
}
