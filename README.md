# Waveform generator

A small browser-based tool that turns a voiceover audio file into a reactive waveform video — black background, white mirrored bars that move with the volume of the voice. Built for dropping into a video editor as an overlay: set the clip's blend mode to **Screen** or **Lighten** and the black disappears, leaving just the bars, so it works as a full scene, a zoom, a bottom-third bar, or part of a split screen.

No install, no server, no account, no dependencies. Everything runs client-side in the browser.

## Usage

1. Download `index.html` and `waveform-core.js` and keep them in the same folder.
2. Open `index.html` in Chrome or Edge (video export requires a Chromium-based browser).
3. Drop in a voiceover file (mp3, wav, m4a).
4. Click **Preview** to check the bars react correctly to the audio.
5. Click **Generate & download** to export a `.webm` video (1080x1920, 30fps, silent — no audio track).
6. In your editor, set the clip's blend mode to Screen or Lighten.

## How it works

- Audio is decoded client-side with the Web Audio API (`decodeAudioData`).
- The raw samples are analyzed with a real FFT, bucketed into 28 log-spaced frequency bands per video frame.
- An attack/release envelope follower smooths each band over time so bars don't flicker on every sample — fast attack, slower release, like a level meter.
- Band values are normalized against the clip's own 95th-percentile energy, then mapped to bar heights.
- The whole envelope is precomputed before rendering, so preview and export always match the same analysis — not a live/real-time analyser.
- Export records the canvas via `canvas.captureStream()` + `MediaRecorder` into a WebM file.

## Running the tests

The core signal-processing logic (FFT, band bucketing, smoothing, normalization) is a standalone module with no browser dependencies, so it's unit tested directly in Node — no install required:

```
node --test
```

## Known limitations

- Export happens in real time (recording the canvas as it renders), so a 60-second clip takes about 60 seconds to export.
- WebM is broadly supported, but if your editor doesn't import it cleanly, converting to MP4 first (e.g. with ffmpeg) is a simple workaround.
- Single file at a time — no batch processing.

## License

MIT — see [LICENSE](LICENSE).
