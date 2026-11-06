import type { ArtifactExchange } from "@keagent/shared-types";
import { authRequest } from "./transport";

export type ArtifactTransport = (
  operation: string,
  args: unknown[],
) => Promise<unknown>;

/** No Mock fallback: tests inject a transport explicitly. */
export function createArtifactExchange(
  transport: ArtifactTransport = authRequest,
): ArtifactExchange {
  const call = <T>(method: string, input: unknown) =>
    transport(method, [input]) as Promise<T>;
  return {
    registerAsset: (input) => call("asset.register", input),
    getAsset: (id) => call("asset.get", { id }),
    reportAvailability: (input) => call("asset.availability", input),
    createArtifact: (input) => call("artifact.create", input),
    getArtifact: (id) => call("artifact.get", { id }),
    listArtifacts: (input = {}) => call("artifact.list", input),
    reviewArtifact: (input) => call("artifact.review", input),
    createHandoff: (input) => call("artifactHandoff.create", input),
    getHandoff: (id) => call("artifactHandoff.get", { id }),
  };
}

export const artifactExchange = createArtifactExchange();
