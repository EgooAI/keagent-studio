import type { CreatorHubComment } from "./client";

export interface CommentField {
  comment_id: string;
  parent_comment_id: string | null;
  comment_text: string | null;
  commenter_name: string | null;
  commenter_profile: string | null;
  comment_time: string | null;
  like_count: number | null;
  reply_count: number | null;
  truncated: boolean;
}

const MAX_COMMENT_ID_RUNES = 1024;
const MAX_COMMENT_TEXT_RUNES = 8192;
const MAX_NICKNAME_RUNES = 256;
const MAX_TIMESTAMP_SECONDS = 4_102_444_800;
const SEC_UID_PATTERN = /^[A-Za-z0-9_-]+$/;

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function truncateRunes(value: string, max: number) {
  const runes = Array.from(value);
  return {
    value: runes.slice(0, max).join(""),
    truncated: runes.length > max,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeComments(rows: CreatorHubComment[]): CommentField[] {
  const seen = new Set<string>();
  const out: CommentField[] = [];
  for (const row of rows) {
    if (row.is_reply) continue;
    const commentId = stringValue(row.comment_id).trim();
    if (
      !commentId ||
      Array.from(commentId).length > MAX_COMMENT_ID_RUNES ||
      seen.has(commentId)
    )
      continue;
    seen.add(commentId);

    const text = stringValue(row.text);
    const truncatedText = truncateRunes(text, MAX_COMMENT_TEXT_RUNES);
    const nickname = stringValue(row.user_nickname);
    const secUid = stringValue(row.user_sec_uid).trim();
    const createTime = finiteNumber(row.create_time);
    const likeCount = finiteNumber(row.like_count);

    out.push({
      comment_id: commentId,
      parent_comment_id: null,
      comment_text: text.trim() ? truncatedText.value : null,
      commenter_name: nickname.trim()
        ? truncateRunes(nickname, MAX_NICKNAME_RUNES).value
        : null,
      commenter_profile: SEC_UID_PATTERN.test(secUid)
        ? `https://www.douyin.com/user/${secUid}`
        : null,
      comment_time:
        createTime !== null &&
        createTime > 0 &&
        createTime < MAX_TIMESTAMP_SECONDS
          ? new Date(createTime * 1000).toISOString()
          : null,
      like_count:
        likeCount !== null &&
        likeCount >= 0 &&
        likeCount <= Number.MAX_SAFE_INTEGER
          ? likeCount
          : null,
      reply_count: null,
      truncated: text.trim() ? truncatedText.truncated : false,
    });
  }
  return out;
}
