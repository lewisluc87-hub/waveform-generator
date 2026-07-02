const test = require('node:test');
const assert = require('node:assert');
const WaveformCore = require('../waveform-core.js');

function makeSineWave(freq, sampleRate, length) {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

test('fft: throws on non-power-of-2 length', () => {
  const re = new Float64Array(100);
  const im = new Float64Array(100);
  assert.throws(() => WaveformCore.fft(re, im));
});

test('fft: pure tone produces a magnitude peak at the expected frequency bin', () => {
  const sampleRate = 44100;
  const fftSize = 2048;
  const freq = 440; // A4
  const samples = makeSineWave(freq, sampleRate, fftSize);
  const mags = WaveformCore.computeMagnitudeSpectrum(samples);

  let peakBin = 0, peakVal = -Infinity;
  for (let i = 0; i < mags.length; i++) {
    if (mags[i] > peakVal) { peakVal = mags[i]; peakBin = i; }
  }
  const binHz = sampleRate / fftSize;
  const expectedBin = Math.round(freq / binHz);
  assert.ok(
    Math.abs(peakBin - expectedBin) <= 1,
    `expected peak near bin ${expectedBin}, got bin ${peakBin}`
  );
});

test('fft: silence produces near-zero magnitude everywhere', () => {
  const samples = new Float64Array(2048); // all zeros
  const mags = WaveformCore.computeMagnitudeSpectrum(samples);
  const maxMag = Math.max(...mags);
  assert.ok(maxMag < 1e-9, `expected near-zero magnitude for silence, got max ${maxMag}`);
});

test('bucketIntoBands: returns correct band count, no NaNs, non-negative', () => {
  const sampleRate = 44100, fftSize = 2048, numBands = 28;
  const samples = makeSineWave(1000, sampleRate, fftSize);
  const mags = WaveformCore.computeMagnitudeSpectrum(samples);
  const bands = WaveformCore.bucketIntoBands(mags, numBands, sampleRate, fftSize);
  assert.strictEqual(bands.length, numBands);
  for (const v of bands) {
    assert.ok(!Number.isNaN(v), 'band value is NaN');
    assert.ok(v >= 0, 'band value is negative');
  }
});

test('bucketIntoBands: a 1kHz tone energizes a low/mid band more than the top band', () => {
  const sampleRate = 44100, fftSize = 2048, numBands = 28;
  const samples = makeSineWave(1000, sampleRate, fftSize);
  const mags = WaveformCore.computeMagnitudeSpectrum(samples);
  const bands = WaveformCore.bucketIntoBands(mags, numBands, sampleRate, fftSize);
  const topBand = bands[numBands - 1];
  const maxOverall = Math.max(...bands);
  assert.ok(maxOverall > topBand * 5, 'expected energy concentrated away from the top band for a 1kHz tone');
});

test('smoothBandsOverTime: attack responds faster than release (step response)', () => {
  const fps = 30, numBands = 1;
  // silence for 10 frames, then loud for 30 frames, then silence for 30 frames
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push(new Float64Array([0]));
  for (let i = 0; i < 30; i++) frames.push(new Float64Array([1]));
  for (let i = 0; i < 30; i++) frames.push(new Float64Array([0]));

  const smoothed = WaveformCore.smoothBandsOverTime(frames, 40, 180, fps);

  // 5 frames after the loud section starts, should already be climbing significantly (fast attack)
  const afterAttack = smoothed[10 + 5][0];
  assert.ok(afterAttack > 0.5, `expected fast attack, got ${afterAttack} after 5 frames`);

  // Right at the peak (just before silence returns), should be very close to 1
  const atPeak = smoothed[10 + 29][0];
  assert.ok(atPeak > 0.9, `expected near-peak value, got ${atPeak}`);

  // 5 frames after silence resumes, release should be slower than attack was -
  // i.e. it should NOT have already dropped as low as attack had climbed in the same time
  const afterRelease = smoothed[10 + 30 + 5][0];
  assert.ok(afterRelease > (1 - afterAttack), 'expected release to be slower than attack');
});

test('normalizeBands: scales values into 0..1 range', () => {
  const frames = [
    new Float64Array([0, 2, 4]),
    new Float64Array([0, 1, 8]),
    new Float64Array([0, 0.5, 6]),
  ];
  const normalized = WaveformCore.normalizeBands(frames);
  for (const frame of normalized) {
    for (const v of frame) {
      assert.ok(v >= 0 && v <= 1, `value out of range: ${v}`);
    }
  }
});

test('mapToBarHeights: respects min/max pixel bounds', () => {
  const frame = new Float64Array([0, 0.5, 1]);
  const heights = WaveformCore.mapToBarHeights(frame, 400, 4);
  assert.strictEqual(heights[0], 4);
  assert.strictEqual(heights[2], 400);
  assert.ok(heights[1] > 4 && heights[1] < 400);
});

test('end-to-end: loud speech-like bursts map to taller bars than silent gaps', () => {
  const sampleRate = 44100;
  const durationSeconds = 2;
  const totalSamples = sampleRate * durationSeconds;
  const channelData = new Float64Array(totalSamples);

  // Simulate speech: loud 300ms burst, silent 600ms gap, repeating.
  // The gap is deliberately long relative to the 180ms release constant so a
  // late-gap sample reflects genuine silence rather than mid-decay.
  const burstLen = Math.floor(0.3 * sampleRate);
  const gapLen = Math.floor(0.6 * sampleRate);
  let i = 0;
  while (i < totalSamples) {
    for (let j = 0; j < burstLen && i < totalSamples; j++, i++) {
      channelData[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }
    i += gapLen; // leave zeros (silence) for the gap
  }

  const barsPerFrame = WaveformCore.computeBarHeightsForClip(channelData, sampleRate, durationSeconds, {
    fps: 30, fftSize: 2048, numBands: 28, attackMs: 40, releaseMs: 180, maxHeightPx: 400, minHeightPx: 4,
  });

  const fps = 30;
  // Near the end of the burst (attack has had time to fully catch up)
  const frameInBurst = Math.floor(0.25 * fps); // 250ms in, burst runs 0-300ms
  // Late in the gap, well beyond the 180ms release constant (300ms burst-end + 550ms = 850ms)
  const frameInGap = Math.floor(0.85 * fps);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const burstAvg = avg(barsPerFrame[frameInBurst]);
  const gapAvg = avg(barsPerFrame[frameInGap]);

  assert.ok(
    burstAvg > gapAvg * 1.5,
    `expected louder section to produce clearly taller bars: burst=${burstAvg.toFixed(1)} gap=${gapAvg.toFixed(1)}`
  );
});
