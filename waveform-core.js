/*
 * waveform-core.js
 * Pure signal-processing logic for the voiceover waveform generator.
 * No browser APIs used here (no AudioContext, no canvas) so this file
 * can be loaded both in the browser (as a <script> tag, attaches to
 * window.WaveformCore) and in Node for unit testing (module.exports).
 */
(function (root) {
  'use strict';

  // ---- FFT (iterative radix-2 Cooley-Tukey, in-place) ----
  // re/im must be Float64Array of length n, where n is a power of 2.
  function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;
    if ((n & (n - 1)) !== 0) {
      throw new Error('fft: length must be a power of 2, got ' + n);
    }

    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curWr = 1, curWi = 0;
        for (let j = 0; j < len / 2; j++) {
          const ur = re[i + j], ui = im[i + j];
          const vr = re[i + j + len / 2] * curWr - im[i + j + len / 2] * curWi;
          const vi = re[i + j + len / 2] * curWi + im[i + j + len / 2] * curWr;
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
          const nextWr = curWr * wr - curWi * wi;
          const nextWi = curWr * wi + curWi * wr;
          curWr = nextWr; curWi = nextWi;
        }
      }
    }
  }

  // ---- Windowing ----
  function hannWindow(samples) {
    const n = samples.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      out[i] = samples[i] * w;
    }
    return out;
  }

  // ---- Magnitude spectrum for one window of samples (length must be power of 2) ----
  function computeMagnitudeSpectrum(samples) {
    const n = samples.length;
    const windowed = hannWindow(samples);
    const re = Float64Array.from(windowed);
    const im = new Float64Array(n);
    fft(re, im);
    const mags = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / n;
    }
    return mags;
  }

  // ---- Bucket a magnitude spectrum into N log-spaced frequency bands ----
  function bucketIntoBands(magnitudes, numBands, sampleRate, fftSize, minFreq, maxFreq) {
    minFreq = minFreq || 60;
    const nyquist = sampleRate / 2;
    maxFreq = Math.min(maxFreq || 8000, nyquist);
    const binHz = sampleRate / fftSize;
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);
    const bands = new Float64Array(numBands);

    for (let b = 0; b < numBands; b++) {
      const f0 = Math.pow(10, logMin + (b / numBands) * (logMax - logMin));
      const f1 = Math.pow(10, logMin + ((b + 1) / numBands) * (logMax - logMin));
      let bin0 = Math.max(0, Math.floor(f0 / binHz));
      let bin1 = Math.min(magnitudes.length - 1, Math.ceil(f1 / binHz));
      if (bin1 < bin0) bin1 = bin0;
      let sum = 0, count = 0;
      for (let k = bin0; k <= bin1; k++) { sum += magnitudes[k]; count++; }
      bands[b] = count > 0 ? sum / count : 0;
    }
    return bands;
  }

  // ---- Extract a zero-padded window of `size` samples centered at `centerSample` ----
  function extractWindow(channelData, centerSample, size) {
    const out = new Float64Array(size);
    const start = centerSample - Math.floor(size / 2);
    for (let i = 0; i < size; i++) {
      const srcIdx = start + i;
      out[i] = (srcIdx >= 0 && srcIdx < channelData.length) ? channelData[srcIdx] : 0;
    }
    return out;
  }

  // ---- Compute band energies for every video frame across the whole clip ----
  function computeAllFrames(channelData, sampleRate, durationSeconds, fps, fftSize, numBands) {
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * fps));
    const samplesPerFrame = sampleRate / fps;
    const frames = [];
    for (let f = 0; f < totalFrames; f++) {
      const centerSample = Math.round(f * samplesPerFrame);
      const window = extractWindow(channelData, centerSample, fftSize);
      const mags = computeMagnitudeSpectrum(window);
      const bands = bucketIntoBands(mags, numBands, sampleRate, fftSize);
      frames.push(bands);
    }
    return frames;
  }

  // ---- Temporal smoothing (attack/release envelope follower) applied per band ----
  function smoothBandsOverTime(framesBands, attackMs, releaseMs, fps) {
    if (framesBands.length === 0) return [];
    const numBands = framesBands[0].length;
    const attackCoeff = Math.exp(-1 / ((attackMs / 1000) * fps));
    const releaseCoeff = Math.exp(-1 / ((releaseMs / 1000) * fps));
    const smoothed = [];
    let prev = new Float64Array(numBands);
    for (const frame of framesBands) {
      const cur = new Float64Array(numBands);
      for (let b = 0; b < numBands; b++) {
        const target = frame[b];
        const coeff = target > prev[b] ? attackCoeff : releaseCoeff;
        cur[b] = coeff * prev[b] + (1 - coeff) * target;
      }
      smoothed.push(cur);
      prev = cur;
    }
    return smoothed;
  }

  // ---- Normalize the whole clip's band values to roughly 0..1 using a 95th percentile reference ----
  function normalizeBands(framesBands) {
    if (framesBands.length === 0) return [];
    const all = [];
    for (const frame of framesBands) for (let b = 0; b < frame.length; b++) all.push(frame[b]);
    all.sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (all.length - 1));
    const reference = Math.max(all[idx], 1e-9);
    return framesBands.map((frame) => {
      const out = new Float64Array(frame.length);
      for (let b = 0; b < frame.length; b++) out[b] = Math.min(1, frame[b] / reference);
      return out;
    });
  }

  // ---- Map normalized 0..1 band values to pixel bar heights, with an idle floor ----
  function mapToBarHeights(bandsFrame, maxHeightPx, minHeightPx) {
    minHeightPx = minHeightPx == null ? 4 : minHeightPx;
    const out = new Float64Array(bandsFrame.length);
    for (let b = 0; b < bandsFrame.length; b++) {
      out[b] = minHeightPx + bandsFrame[b] * (maxHeightPx - minHeightPx);
    }
    return out;
  }

  // ---- Full pipeline: raw channel samples -> smoothed, normalized bar heights per frame ----
  function computeBarHeightsForClip(channelData, sampleRate, durationSeconds, opts) {
    opts = opts || {};
    const fps = opts.fps || 30;
    const fftSize = opts.fftSize || 2048;
    const numBands = opts.numBands || 28;
    const attackMs = opts.attackMs || 40;
    const releaseMs = opts.releaseMs || 180;
    const maxHeightPx = opts.maxHeightPx || 400;
    const minHeightPx = opts.minHeightPx == null ? 4 : opts.minHeightPx;

    const rawFrames = computeAllFrames(channelData, sampleRate, durationSeconds, fps, fftSize, numBands);
    const smoothedFrames = smoothBandsOverTime(rawFrames, attackMs, releaseMs, fps);
    const normalizedFrames = normalizeBands(smoothedFrames);
    return normalizedFrames.map((frame) => mapToBarHeights(frame, maxHeightPx, minHeightPx));
  }

  const WaveformCore = {
    fft,
    hannWindow,
    computeMagnitudeSpectrum,
    bucketIntoBands,
    extractWindow,
    computeAllFrames,
    smoothBandsOverTime,
    normalizeBands,
    mapToBarHeights,
    computeBarHeightsForClip,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WaveformCore;
  } else {
    root.WaveformCore = WaveformCore;
  }
})(typeof window !== 'undefined' ? window : global);
