/** Tiny synthesized sound effects (Web Audio, no files). All silent when muted. */
import { load, save } from './storage';

let ctx: AudioContext | null = null;
let muted = load<boolean>('muted') ?? false;

export const isMuted = (): boolean => muted;
export function setMuted(value: boolean): void {
  muted = value;
  save('muted', value);
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Browsers only allow sound after a tap: wake the context on the first one.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => audio(), { once: true, passive: true });
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', gain = 0.2, slideTo?: number): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(at: number, dur: number, gain = 0.3, cutoff = 1200): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const amp = ac.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(t);
}

export const sfx = {
  /** Rubber stamp hitting the desk. */
  thud() {
    noise(0, 0.12, 0.5, 700);
    tone(110, 0, 0.18, 'sine', 0.5, 45);
  },
  /** A card flicked across the table. */
  flick() {
    noise(0, 0.05, 0.12, 5000);
  },
  /** Container doors slamming. */
  clang() {
    noise(0, 0.25, 0.4, 500);
    tone(180, 0, 0.35, 'square', 0.08, 90);
    tone(410, 0.01, 0.3, 'triangle', 0.07);
  },
  /** Customs is onto somebody. */
  siren() {
    for (let i = 0; i < 3; i++) {
      tone(620, i * 0.36, 0.18, 'sawtooth', 0.09, 880);
      tone(880, i * 0.36 + 0.18, 0.18, 'sawtooth', 0.09, 620);
    }
  },
  /** Wrong call. */
  buzzer() {
    tone(140, 0, 0.35, 'sawtooth', 0.16, 90);
    tone(147, 0, 0.35, 'square', 0.08, 95);
  },
  /** Clean getaway. */
  fanfare() {
    [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.3, 'triangle', 0.16));
    tone(1047, 0.6, 0.6, 'triangle', 0.14);
    noise(0.55, 0.3, 0.1, 6000);
  },
  tick() {
    tone(900, 0, 0.04, 'square', 0.04);
  },
};
