import type { PanoramaConfig } from "./panorama";

/** Public templates contain recipes only; personal voices and property media are resolved per job. */
export interface ProductionTemplateRecipe {
  schemaVersion: 1;
  config: Required<
    Pick<
      PanoramaConfig,
      | "language"
      | "openingTemplate"
      | "sceneTemplate"
      | "closingTemplate"
      | "videoMode"
      | "rate"
      | "speed"
      | "direction"
      | "maxSweep"
      | "aspectRatio"
      | "resolution"
      | "subtitles"
      | "design"
      | "brandColor"
      | "subtitleSize"
    >
  >;
}

export interface ProductionTemplateSnapshot {
  id: string;
  name: string;
  version: string;
  description: string;
  production: ProductionTemplateRecipe;
}

export interface ProductionTemplatePreview {
  template: ProductionTemplateSnapshot;
  segments: { id: string; text: string }[];
}
