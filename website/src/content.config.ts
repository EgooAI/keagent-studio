import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(["快速上手", "核心功能", "账号与计费", "门店与运维"]),
    order: z.number(),
    updatedAt: z.string().optional(),
  }),
});

const changelog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/changelog" }),
  schema: z.object({
    version: z.string(),
    title: z.string(),
    date: z.string(),
    channel: z.enum(["内测版", "正式版", "功能更新"]).default("内测版"),
    highlights: z.array(z.string()).default([]),
    order: z.number(),
  }),
});

export const collections = { docs, changelog };
