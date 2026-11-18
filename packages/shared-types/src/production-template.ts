import type { PanoramaConfig } from "./panorama";
import type { ResourceRef } from "./index";

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
  parts?: TemplateBundle["parts"];
  cover?: CoverTemplate;
}

export interface ProductionTemplatePreview {
  template: ProductionTemplateSnapshot;
  segments: { id: string; text: string }[];
  definition?: CatalogTemplate;
  cover?: CoverTemplate;
}

export type TemplatePartKind = "edit" | "cover" | "script";
export type CatalogKind = TemplatePartKind | "bundle";
export type TemplatePartRef = ResourceRef & { name: string };
export type TemplatePartOption = TemplatePartRef & { kind: TemplatePartKind };

export type EditTemplate = {
  kind: "edit";
  config: Omit<ProductionRenderConfig, "language">;
  opening?: ProductionOpening;
};
export type CoverTemplate = {
  kind: "cover";
  design: ProductionRenderConfig["design"];
  brandColor: string;
  imageSource: "first" | "last" | "frame";
  titleSource: "opening" | "property";
  showFacts: boolean;
};
export type ScriptTemplate = {
  kind: "script";
  language: PanoramaConfig["language"];
} & (
  | {
      scriptRules: Extract<
        ProductionTemplateRecipe,
        { schemaVersion: 2 }
      >["scriptRules"];
    }
  | {
      phrases: Pick<
        PanoramaConfig,
        "openingTemplate" | "sceneTemplate" | "closingTemplate"
      >;
    }
);
export type TemplateBundle = {
  kind: "bundle";
  parts: Record<TemplatePartKind, TemplatePartRef>;
};
export type CatalogTemplate =
  EditTemplate | CoverTemplate | ScriptTemplate | TemplateBundle;
