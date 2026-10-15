/**
 * GET /v1/leaderboardの「上位N件と登録人数」をCache APIに短時間だけ保存する。
 * 保存するのはmeを含まない部分だけで、キャッシュのキーはbyとlimitだけにする。
 * 誰が見ても同じ内容なので、アクセスが増えてもD1を読むのは数秒に1回ですむ。
 *
 * クライアントへの応答は今までどおりno-storeのままにする。max-ageを付けるのは、
 * Cache APIに保存するための内部のResponseだけ。
 */

/** キャッシュに保存する秒数 */
export const LEADERBOARD_CACHE_TTL_SECONDS = 10;

/** キャッシュに保存する1件分。isYouを付け直すためにidを持つ（クライアントへ返す前に取り除く）。 */
export interface CachedEntry {
  id: string;
  rank: number;
  name: string;
  level: number;
  deepest: number;
  totalExp: number;
}

export interface CachedBoard {
  entries: CachedEntry[];
  players: number;
}

/**
 * キャッシュのキー。byとlimitだけで決まり、meは含めない。
 * ゾーンのキャッシュに合わせるため、リクエストと同じオリジンを使う。
 */
export function leaderboardCacheKey(origin: string, by: string, limit: number): Request {
  return new Request(`${origin}/_cache/v1/leaderboard?by=${by}&limit=${limit}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCachedEntry(value: unknown): value is CachedEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.rank === "number" &&
    typeof value.name === "string" &&
    typeof value.level === "number" &&
    typeof value.deepest === "number" &&
    typeof value.totalExp === "number"
  );
}

/** キャッシュの中身が期待した形か確かめる。形が違えば（古い形式など）キャッシュなしとして扱う。 */
function parseCachedBoard(value: unknown): CachedBoard | null {
  if (!isRecord(value) || typeof value.players !== "number" || !Array.isArray(value.entries)) return null;
  const entries: CachedEntry[] = [];
  for (const entry of value.entries) {
    if (!isCachedEntry(entry)) return null;
    entries.push(entry);
  }
  return { entries, players: value.players };
}

function logCacheFailure(message: string, error: unknown): void {
  console.warn(JSON.stringify({ message, error: error instanceof Error ? error.message : String(error) }));
}

/** キャッシュにあれば返す。無い、読めない、形が違うときはnull（キャッシュの失敗でAPIを止めない）。 */
export async function readCachedBoard(key: Request): Promise<CachedBoard | null> {
  try {
    const hit = await caches.default.match(key);
    if (hit === undefined) return null;
    return parseCachedBoard(await hit.json());
  } catch (error) {
    logCacheFailure("leaderboard cache read failed", error);
    return null;
  }
}

/** キャッシュに保存する。失敗してもAPIの応答には影響させない。 */
export async function writeCachedBoard(key: Request, board: CachedBoard): Promise<void> {
  try {
    await caches.default.put(
      key,
      new Response(JSON.stringify(board), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `max-age=${LEADERBOARD_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch (error) {
    logCacheFailure("leaderboard cache write failed", error);
  }
}
