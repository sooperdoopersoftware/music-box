// Tiny Web Audio "music box tine" synth — no audio assets. Each pluck is a
// couple of short-decaying oscillators, fed dry to the output plus parallel
// sends into a delay and a reverb bus (both built from scratch, no files).

let ctx: AudioContext | null = null;
let delaySend: GainNode | null = null;
let delayNode: DelayNode | null = null;
let reverbSend: GainNode | null = null;
let convolver: ConvolverNode | null = null;

const DELAY_TIME = 0.32; // seconds
const DELAY_FEEDBACK = 0.35;
const MAX_DELAY_SEND = 0.6; // caps how loud the delay send can get at 100%
const MAX_REVERB_SEND = 0.8;

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
  delayNode = audioCtx.createDelay(2);
  delayNode.delayTime.value = DELAY_TIME;
  const delayFeedback = audioCtx.createGain();
  delayFeedback.gain.value = DELAY_FEEDBACK;
  delaySend = audioCtx.createGain();
  delaySend.gain.value = 0;

  delaySend.connect(delayNode);
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayNode.connect(audioCtx.destination);

  convolver = audioCtx.createConvolver();
  convolver.buffer = makeImpulseResponse(audioCtx);
  reverbSend = audioCtx.createGain();
  reverbSend.gain.value = 0;

  reverbSend.connect(convolver);
  convolver.connect(audioCtx.destination);
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

/** Call this from a user-gesture handler (e.g. the Play button) to satisfy autoplay policies. */
export function primeAudio() {
  getContext();
}

/** 0-1 wet amount for the delay send. */
export function setDelayAmount(amount: number) {
  if (delaySend) delaySend.gain.value = amount * MAX_DELAY_SEND;
}

/** 0-1 wet amount for the reverb send. */
export function setReverbAmount(amount: number) {
  if (reverbSend) reverbSend.gain.value = amount * MAX_REVERB_SEND;
}

export function pluck(freq: number, velocity = 1) {
  const audioCtx = getContext();
  const now = audioCtx.currentTime;
  const peak = 0.28 * velocity;

  const osc = audioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  if (delaySend) gain.connect(delaySend);
  if (reverbSend) gain.connect(reverbSend);
  osc.start(now);
  osc.stop(now + 0.65);

  // A brief bright overtone on top gives it more of a metal-tine "plink"
  // than a plain triangle wave alone.
  const overtone = audioCtx.createOscillator();
  overtone.type = "sine";
  overtone.frequency.value = freq * 2;
  const overtoneGain = audioCtx.createGain();
  overtoneGain.gain.setValueAtTime(0, now);
  overtoneGain.gain.linearRampToValueAtTime(peak * 0.35, now + 0.004);
  overtoneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  overtone.connect(overtoneGain);
  overtoneGain.connect(audioCtx.destination);
  if (delaySend) overtoneGain.connect(delaySend);
  if (reverbSend) overtoneGain.connect(reverbSend);
  overtone.start(now);
  overtone.stop(now + 0.35);
}
