// Attenuates the video's sound through Web Audio, because iOS ignores
// `video.volume`. The audio graph is built on the first user gesture (iOS
// only starts an AudioContext from one) and kept for the element's lifetime;
// source reloads keep flowing through it.
import { VOLUME_GAINS, parseLevel } from '../core/volume.ts';

const STORAGE_KEY = 'sla.volumeLevel';

interface AudioSessionNavigator {
  audioSession?: { type: string };
}

export interface Volume {
  level(): number;
  setLevel(level: number): void;
  /** Builds or resumes the audio graph; call from a user gesture. */
  unlock(): void;
}

export function createVolume(video: HTMLVideoElement): Volume {
  let level = parseLevel(localStorage.getItem(STORAGE_KEY));
  let context: AudioContext | null = null;
  let gain: GainNode | null = null;

  function unlock(): void {
    if (context === null) {
      // Plays through the silent switch like the video element itself does.
      const session = (navigator as AudioSessionNavigator).audioSession;
      if (session) session.type = 'playback';
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = VOLUME_GAINS[level] as number;
      context.createMediaElementSource(video).connect(gain).connect(context.destination);
    }
    // iOS suspends the context after interruptions such as calls or the lock screen.
    if (context.state !== 'running') void context.resume();
  }

  video.addEventListener('play', () => {
    if (context !== null && context.state !== 'running') void context.resume();
  });

  return {
    level: () => level,
    setLevel(next) {
      level = next;
      localStorage.setItem(STORAGE_KEY, String(level));
      if (gain !== null && context !== null) gain.gain.setTargetAtTime(VOLUME_GAINS[level] as number, context.currentTime, 0.02);
    },
    unlock,
  };
}
