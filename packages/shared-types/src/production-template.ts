import type { PanoramaConfig } from "./panorama";

/** Personal voices, agent photos and property media are resolved per job. */
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
> &
  Pick<PanoramaConfig, "cameraMode">;

export type ProductionOpening = {
  prompt: string;
  /** Desktop snapshots keep the fixed picture as a local asset reference. */
  location: { source: "property" } | { source: "fixed"; image?: string };
};

export type ProductionTemplateRecipe =
  | {
      schemaVersion: 1;
      config: ProductionRenderConfig & { cameraMode?: "panorama" } & Pick<
          PanoramaConfig,
          "openingTemplate" | "sceneTemplate" | "closingTemplate"
        >;
    }
  | {
      schemaVersion: 2;
      config: ProductionRenderConfig;
      opening?: ProductionOpening;
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
