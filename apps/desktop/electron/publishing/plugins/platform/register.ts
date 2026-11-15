import type { SocialPlatform } from "@keagent/shared-types";
export const PLATFORM_REGISTRY = { douyin: true, xhs: true } as const;
export type PlatformId = SocialPlatform;
