import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  shortTourCameras,
  cameraCommands,
  spatialRuns,
} = require("./media.cjs");

const scenes = [
  { id: "living", yaw: 170, direction: 1 },
  { id: "bedroom", yaw: 40, direction: -1 },
];
const config = { speed: 36, maxSweep: 180, direction: 1 };

describe("spatial shot planning", () => {
  const job = {
    config: { design: "short-tour" },
    scenes: scenes.map((scene, index) => ({
      ...scene,
      spatial: { panoIndex: index },
    })),
  };
  const audio = [
    { kind: "opening", sceneId: "living", duration: 2.365792 },
    { kind: "scene", sceneId: "living", duration: 2.874625 },
    { kind: "scene", sceneId: "bedroom", duration: 3.260792 },
    { kind: "closing", sceneId: "bedroom", duration: 3.253875 },
  ];
  it("keeps the final room and closing in one physical movement with exact frame trims", () => {
    const runs = spatialRuns(job, audio, true);
    expect(runs).toHaveLength(2);
    expect(runs[0].segments).toEqual([
      { index: 1, offsetFrames: 0, frames: 86 },
    ]);
    expect(runs[1].segments).toEqual([
      { index: 2, offsetFrames: 0, frames: 98 },
      { index: 3, offsetFrames: 98, frames: 98 },
    ]);
    expect(runs[1].frames).toBe(196);
    expect(runs[1].duration).toBeCloseTo(6.514667);
    expect(
      runs.reduce(
        (total: number, run: { frames: number }) => total + run.frames,
        71,
      ),
    ).toBe(
      Math.round(
        audio.reduce((total, segment) => total + segment.duration, 0) * 30,
      ),
    );
  });
  it("includes room opening but rejects any selected scene without geometry", () => {
    expect(spatialRuns(job, audio, false)[0].frames).toBe(157);
    expect(() => spatialRuns({ ...job, scenes }, audio, false)).toThrow(
      "VR 空间",
    );
  });
});

describe("short tour camera pacing", () => {
  it("shows ninety degrees in a short scene at the requested speed", () => {
    expect(
      shortTourCameras(
        scenes,
        [{ sceneId: "living", kind: "scene", duration: 2.5 }],
        config,
        false,
      ),
    ).toEqual([{ start: 170, end: 260, sweep: 90, duration: 2.5 }]);
  });

  it("spreads a capped turn evenly across the room and its closing narration", () => {
    expect(
      shortTourCameras(
        scenes,
        [
          { sceneId: "bedroom", kind: "scene", duration: 4 },
          { sceneId: "bedroom", kind: "closing", duration: 6 },
        ],
        config,
        false,
      ),
    ).toEqual([
      { start: 40, end: -32, sweep: -72, duration: 4 },
      { start: -32, end: -140, sweep: -108, duration: 6 },
    ]);
  });

  it("excludes an avatar opening from the following room's yaw and duration", () => {
    const audio = [
      { sceneId: "living", kind: "opening", duration: 8 },
      { sceneId: "living", kind: "scene", duration: 3 },
    ];
    expect(shortTourCameras(scenes, audio, config, true)).toEqual([
      null,
      { start: 170, end: 278, sweep: 108, duration: 3 },
    ]);
    const panoramaOpening = shortTourCameras(scenes, audio, config, false);
    expect(panoramaOpening[0].end).toBe(panoramaOpening[1].start);
    expect(panoramaOpening[1].end).toBeCloseTo(350);
    expect(panoramaOpening[0].sweep / 8).toBeCloseTo(
      panoramaOpening[1].sweep / 3,
    );
  });

  it("recalculates the room movement when its contiguous closing gets longer", () => {
    const audio = [
      { sceneId: "living", kind: "scene", duration: 3 },
      { sceneId: "living", kind: "closing", duration: 2 },
    ];
    const original = shortTourCameras(scenes, audio, config, false);
    const longer = shortTourCameras(
      scenes,
      [audio[0], { ...audio[1], duration: 7 }],
      config,
      false,
    );
    expect(original[0].sweep).toBe(108);
    expect(longer[0].sweep).toBe(54);
    expect(longer[1].start).toBe(longer[0].end);
    expect(longer[1].end).toBe(350);
  });

  it("caps separate room visits independently while preserving their last yaw", () => {
    expect(
      shortTourCameras(
        scenes,
        [
          { sceneId: "living", kind: "scene", duration: 3 },
          { sceneId: "bedroom", kind: "scene", duration: 3 },
          { sceneId: "living", kind: "closing", duration: 3 },
        ],
        config,
        false,
      ),
    ).toEqual([
      { start: 170, end: 278, sweep: 108, duration: 3 },
      { start: 40, end: -68, sweep: -108, duration: 3 },
      { start: 278, end: 386, sweep: 108, duration: 3 },
    ]);
  });

  it("uses the configured direction when a room has no override", () => {
    expect(
      shortTourCameras(
        [{ id: "living", yaw: 10 }],
        [{ sceneId: "living", kind: "scene", duration: 2 }],
        { ...config, direction: -1 },
        false,
      ),
    ).toEqual([{ start: 10, end: -62, sweep: -72, duration: 2 }]);
  });
});

describe("FFmpeg camera commands", () => {
  const angles = (commands: string) =>
    commands
      .trim()
      .split("\n")
      .map((line) => Number(line.match(/yaw ([-\d.]+);/)![1]));

  it.each([1, -1])(
    "keeps turning through the panorama boundary in direction %s",
    (direction) => {
      const output = angles(
        cameraCommands(
          { start: 530 * direction, sweep: 40 * direction, duration: 2 },
          21,
          10,
          20,
        ),
      );
      expect(output).toHaveLength(20);
      expect(output[0]).toBe(172 * direction);
      expect(output.at(-1)).toBe(-150 * direction);
      for (const [index, angle] of output.entries()) {
        expect(angle).toBeGreaterThanOrEqual(-180);
        expect(angle).toBeLessThanOrEqual(180);
        if (index) {
          let delta = angle - output[index - 1];
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          expect(delta).toBeCloseTo(2 * direction);
        }
      }
    },
  );

  it("preserves the classic camera's hold after reaching its sweep cap", () => {
    const output = angles(
      cameraCommands({ start: 175, sweep: 10, duration: 2 }, 21, 10, 20),
    );
    expect(output.slice(0, 5)).toEqual([177, 179, -179, -177, -175]);
    expect(output.slice(5)).toEqual(Array(15).fill(-175));
  });
});
