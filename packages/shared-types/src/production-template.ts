import type { PanoramaConfig } from "./panorama";

/** Public templates contain recipes only; personal voices and property media are resolved per job. */
type ProductionRenderConfig = Required<
  Pick<
    PanoramaConfig,
    | "language"
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

export type ProductionTemplateRecipe =
  | {
      schemaVersion: 1;
      config: ProductionRenderConfig &
        Pick<
          PanoramaConfig,
          "openingTemplate" | "sceneTemplate" | "closingTemplate"
        >;
    }
  | {
      schemaVersion: 2;
      config: ProductionRenderConfig;
      scriptRules: {
        overall: string;
        opening: string;
        scene: string;
        closing: string;
      };
    };

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
