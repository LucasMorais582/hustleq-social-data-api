import { env } from '../../../config/env.js';
import { requestStoredPostRefresh } from './instagram.post.refresh.repository.js';

export function readOrRefreshInstagramPost(postId: string, userId: string) {
  return requestStoredPostRefresh(
    postId,
    userId,
    'on_open',
    env.INSTAGRAM_MANUAL_REFRESH_DAILY_LIMIT,
  );
}
export async function refreshInstagramPost(postId: string, userId: string) {
  await requestStoredPostRefresh(
    postId,
    userId,
    'refresh',
    env.INSTAGRAM_MANUAL_REFRESH_DAILY_LIMIT,
  );
}
