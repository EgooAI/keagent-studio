import { expect, it } from "vitest";
import { validateRecordingDuration, voiceFormat } from "./voiceLibrary";

it("bounds recording uploads before reading bytes", () => {
  expect(voiceFormat({ name: "My Voice.WAV", size: 1000 })).toBe("wav");
  for (const file of [
    { name: "voice.exe", size: 1000 },
    { name: "voice.mp3", size: 0 },
    { name: "voice.m4a", size: 10 * 1024 * 1024 + 1 },
  ])
    expect(() => voiceFormat(file)).toThrow();
});
it("rejects silent metadata failures and out-of-range recording durations", () => {
  for (const duration of [NaN, Infinity, 0, 4.9, 30.1])
    expect(() => validateRecordingDuration(duration)).toThrow();
  expect(() => validateRecordingDuration(12)).not.toThrow();
});
