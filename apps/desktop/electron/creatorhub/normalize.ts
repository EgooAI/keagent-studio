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

export function normalizeComments(rows: CreatorHubComment[]): CommentField[] {
  const seen = new Set<string>();
  const out: CommentField[] = [];
  for (const row of rows) {
    if (row.is_reply || !row.comment_id || seen.has(row.comment_id)) continue;
    seen.add(row.comment_id);
    out.push({
      comment_id: row.comment_id,
      parent_comment_id: null,
      comment_text: row.text || null,
      commenter_name: row.user_nickname || null,
      commenter_profile: row.user_sec_uid
        ? `https://www.douyin.com/user/${row.user_sec_uid}`
        : null,
      comment_time:
        row.create_time > 0
          ? new Date(row.create_time * 1000).toISOString()
          : null,
      like_count: Number.isFinite(row.like_count) ? row.like_count : null,
      reply_count: null,
      truncated: false,
    });
  }
  return out;
}
