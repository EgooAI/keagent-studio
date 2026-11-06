import { describe, expect, it } from "vitest";
import { createArtifactExchange } from "./artifacts";
import fixture from "../../shared-types/fixtures/artifact-handoff.v1.json";

describe("artifact exchange consumer boundary", () => {
  it("passes only exchange objects through the injected transport", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    const client = createArtifactExchange(async (operation, [input]) => {
      calls.push({ operation, input });
      return structuredClone(fixture);
    });
    const receipt = await client.getHandoff(fixture.id);
    expect(receipt.artifact.source.producer).toBe("fixture-producer");
    expect(
      receipt.assets.find((asset) => asset.id === receipt.artifact.assets.video)
        ?.kind,
    ).toBe("video");
    expect(calls).toEqual([
      { operation: "artifactHandoff.get", input: { id: fixture.id } },
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(
      /videoUrl|absolutePath|accessToken|accountId/,
    );
  });

  it("supports the producer, reviewer and consumer without job-specific APIs", async () => {
    const operations: string[] = [];
    const client = createArtifactExchange(async (operation) => {
      operations.push(operation);
      return {};
    });
    const { location, ...asset } = fixture.assets[0];
    const input = {
      kind: "video" as const,
      mimeType: "video/mp4" as const,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs!,
      fileToken: location.fileToken,
      requestKey: "fixture-request-0001",
    };
    await client.registerAsset(input);
    await client.getAsset(asset.id);
    await client.reportAvailability({
      id: asset.id,
      expectedRevision: 1,
      state: "missing",
    });
    await client.createArtifact({
      requestKey: input.requestKey,
      source: fixture.artifact.source,
      content: fixture.artifact.content,
      assets: fixture.artifact.assets,
    });
    await client.getArtifact(fixture.artifact.id);
    await client.listArtifacts();
    await client.reviewArtifact({
      id: fixture.artifact.id,
      expectedRevision: 1,
      state: "approved",
    });
    await client.createHandoff({
      requestKey: input.requestKey,
      artifactId: fixture.artifact.id,
      expectedReviewRevision: 2,
    });
    await client.getHandoff(fixture.id);
    expect(operations).toEqual([
      "asset.register",
      "asset.get",
      "asset.availability",
      "artifact.create",
      "artifact.get",
      "artifact.list",
      "artifact.review",
      "artifactHandoff.create",
      "artifactHandoff.get",
    ]);
  });

  it("propagates missing-file/review conflicts without local success or automatic retry", async () => {
    let attempts = 0;
    const client = createArtifactExchange(async () => {
      attempts++;
      throw new Error("成片文件已报告缺失");
    });
    await expect(
      client.createHandoff({
        requestKey: "fixture-request-0001",
        artifactId: fixture.artifact.id,
        expectedReviewRevision: 2,
      }),
    ).rejects.toThrow("成片文件已报告缺失");
    expect(attempts).toBe(1);
  });
});
