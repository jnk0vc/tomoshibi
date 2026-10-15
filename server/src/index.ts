/**
 * 灯火迷宮のランキングAPI（Cloudflare Workers + D1）。
 * フレームワークは使わず、fetchハンドラだけでAPIの取り決め（README参照）をそのまま実装する。
 */
import { type CachedBoard, type CachedEntry, leaderboardCacheKey, readCachedBoard, writeCachedBoard } from "./cache";
import { SQL, updatePlayerSql } from "./sql";

// ── 定数 ──

/** リクエストボディの上限（バイト） */
const MAX_BODY_BYTES = 4096;
/** 既存プレイヤーが送信できる間隔（ミリ秒） */
const SUBMIT_INTERVAL_MS = 20_000;
/** 名前の最大長（コードポイント数） */
const MAX_NAME_CODE_POINTS = 12;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 同時リクエストに先を越されたときに、状態を読み直して判定をやり直す最大回数 */
const MAX_WRITE_ATTEMPTS = 3;

/** 小文字のUUID v4 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** 制御文字(Cc)と書式文字(Cf) */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

const BOARDS = ["level", "deepest", "exp"] as const;
type Board = (typeof BOARDS)[number];

// ── エラー表現 ──

/** ステータスコード付きのエラー。最上位のfetchでJSONのエラー応答に変換する。 */
class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// ── リクエストの読み取りと検証 ──

/** ストリームを読みながらサイズを数え、上限を超えた時点で読み取りをやめる。 */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(400, "body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** POST/DELETEのボディをJSONとして読む。Content-Typeが違えば415、読めなければ400。 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new HttpError(415, "unsupported media type");

  // 申告サイズが上限を超えていれば、読み始める前に断る
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) throw new HttpError(400, "body too large");

  const bytes = await readLimited(request.body, MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    // 不正なUTF-8は例外にする。先頭のBOMは取り除く（ignoreBOMがfalseの動作）
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "body must be a json object");
  }
  return parsed as Record<string, unknown>;
}

function parsePlayerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) throw new HttpError(400, "invalid playerId");
  return value;
}

function parseToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) throw new HttpError(400, "invalid token");
  return value;
}

/**
 * 名前を整える。前後の空白を除き、途中の空白の連続を半角スペース1つにし、
 * そのあとで長さ(1〜12コードポイント)と文字種(制御文字・書式文字なし)を確かめる。
 */
function parseName(value: unknown): string {
  // 対になっていないサロゲートはUTF-8で保存できないので先に断る
  if (typeof value !== "string" || !value.isWellFormed()) throw new HttpError(400, "invalid name");
  const name = value.trim().replace(/\s+/g, " ");
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_CODE_POINTS || CONTROL_OR_FORMAT.test(name)) {
    throw new HttpError(400, "invalid name");
  }
  return name;
}

/** 安全な整数で、min以上であること。 */
function parseCount(body: Record<string, unknown>, key: string, min: number): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new HttpError(400, `invalid ${key}`);
  }
  // JSONの負のゼロ(-0)を0にそろえる
  return value === 0 ? 0 : value;
}

interface Score {
  name: string;
  level: number;
  deepest: number;
  totalExp: number;
  kills: number;
  ticks: number;
}

function parseScore(body: Record<string, unknown>): Score {
  return {
    name: parseName(body.name),
    level: parseCount(body, "level", 1),
    deepest: parseCount(body, "deepest", 1),
    totalExp: parseCount(body, "totalExp", 0),
    kills: parseCount(body, "kills", 0),
    ticks: parseCount(body, "ticks", 0),
  };
}

/** 簡易的な不正対策。ticksに対して現実的でない成績は422で断る。 */
function assertPlausible(score: Score): void {
  if (score.level > 20 + Math.floor(score.ticks / 8)) throw new HttpError(422, "implausible level");
  if (score.deepest > 20 + Math.floor(score.ticks / 4)) throw new HttpError(422, "implausible deepest");
  if (score.kills > score.ticks) throw new HttpError(422, "implausible kills");
}

// ── トークン ──

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256の16進文字列どうしを一定時間で比べる。長さは固定(64)で秘密ではないので先に確かめてよい。 */
function tokenHashMatches(stored: string, sent: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(stored);
  const b = encoder.encode(sent);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// ── DBの行の形 ──

interface PlayerRow {
  token_hash: string;
  updated_at: number;
  level: number;
  deepest: number;
  total_exp: number;
}

interface RankRow {
  level_rank: number;
  deepest_rank: number;
  exp_rank: number;
}

interface EntryRow {
  id: string;
  name: string;
  level: number;
  deepest: number;
  total_exp: number;
}

interface MeRow {
  name: string;
  level: number;
  deepest: number;
  total_exp: number;
  rank: number;
}

interface CountRow {
  n: number;
}

/** batch()の結果から行の配列を取り出す。SQLの列と行の型はこのファイルで対応させている。 */
function rowsOf<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

// ── POST /v1/scores ──

function tooManyRequests(elapsedMs: number): HttpError {
  // 時計のずれで待ち時間が間隔を超えないように上限を付ける
  const waitSeconds = Math.min(
    SUBMIT_INTERVAL_MS / 1000,
    Math.max(1, Math.ceil((SUBMIT_INTERVAL_MS - elapsedMs) / 1000)),
  );
  return new HttpError(429, "too many requests", { "retry-after": String(waitSeconds) });
}

/**
 * 既存プレイヤーの更新文を作る。
 * 保存済みの指標より送信値が大きいボードだけをSETに入れ、そうでないボードのインデックスは書き換えない。
 * 読んだ時点より前に保存値が伸びていても、SQLのMAXが守るので、送信値が保存値を下げることはない。
 */
function buildUpdate(env: Env, playerId: string, existing: PlayerRow, score: Score, now: number): D1PreparedStatement {
  const raised = {
    level: score.level > existing.level,
    deepest: score.deepest > existing.deepest,
    exp: score.totalExp > existing.total_exp,
  };
  const values: (string | number)[] = [score.name, score.kills, score.ticks, now];
  // 指標の送信値、到達時刻の判定に使う同じ送信値、到達時刻の順（SQLのSETの並びと同じ）
  if (raised.level) values.push(score.level, score.level, now);
  if (raised.deepest) values.push(score.deepest, score.deepest, now);
  if (raised.exp) values.push(score.totalExp, score.totalExp, now);
  values.push(playerId, existing.token_hash, now - SUBMIT_INTERVAL_MS);
  return env.DB.prepare(updatePlayerSql(raised)).bind(...values);
}

async function postScore(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const playerId = parsePlayerId(body.playerId);
  const token = parseToken(body.token);
  const score = parseScore(body);
  assertPlausible(score);
  const tokenHash = await sha256Hex(token);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const now = Date.now();
    const existing = await env.DB.prepare(SQL.selectPlayer).bind(playerId).first<PlayerRow>();

    let write: D1PreparedStatement;
    if (existing === null) {
      write = env.DB.prepare(SQL.insertPlayer).bind(
        playerId,
        tokenHash,
        score.name,
        score.level,
        score.deepest,
        score.totalExp,
        score.kills,
        score.ticks,
        now,
        now,
        // level_at, deepest_at, exp_at: 登録した時点で各指標に到達したことにする
        now,
        now,
        now,
      );
    } else {
      if (!tokenHashMatches(existing.token_hash, tokenHash)) throw new HttpError(403, "invalid token");
      const elapsed = now - existing.updated_at;
      if (elapsed < SUBMIT_INTERVAL_MS) throw tooManyRequests(elapsed);
      write = buildUpdate(env, playerId, existing, score, now);
    }

    // 書き込みと順位の読み取りを1つのトランザクションにして、書き込み直後の順位を返す
    const [writeResult, rankResult] = await env.DB.batch<unknown>([
      write,
      env.DB.prepare(SQL.rankAll).bind(playerId),
    ]);
    // 登録人数のトリガーが行を書き換えるので、新規登録のchangesは1ではなく2になる。
    // 書き込まれなかったとき（0）だけを「先を越された」と見なす。
    if ((writeResult?.meta.changes ?? 0) > 0) {
      const rank = rowsOf<RankRow>(rankResult)[0];
      if (rank === undefined) throw new Error("rank row missing after write");
      return json({ ok: true, rank: { level: rank.level_rank, deepest: rank.deepest_rank, exp: rank.exp_rank } });
    }
    // 同時リクエストに先を越された。状態を読み直して判定をやり直す
  }
  throw new HttpError(429, "too many requests", { "retry-after": String(SUBMIT_INTERVAL_MS / 1000) });
}

// ── DELETE /v1/scores ──

async function deleteScore(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const playerId = parsePlayerId(body.playerId);
  const token = parseToken(body.token);
  const tokenHash = await sha256Hex(token);

  const existing = await env.DB.prepare(SQL.selectPlayer).bind(playerId).first<PlayerRow>();
  if (existing === null) throw new HttpError(404, "player not found");
  if (!tokenHashMatches(existing.token_hash, tokenHash)) throw new HttpError(403, "invalid token");

  const result = await env.DB.prepare(SQL.deletePlayer).bind(playerId, existing.token_hash).run();
  // 確認から削除までの間に別のリクエストが先に削除していた場合（changesが0）。
  // 登録人数のトリガーも行を書き換えるので、成功したときのchangesは1とは限らない。
  if (result.meta.changes === 0) throw new HttpError(404, "player not found");
  return json({ ok: true });
}

// ── GET /v1/leaderboard ──

function isBoard(value: string): value is Board {
  return (BOARDS as readonly string[]).includes(value);
}

/** クエリの値を1つだけ取り出す。無ければnull、複数あれば400。 */
function singleParam(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) throw new HttpError(400, `invalid ${key}`);
  return values[0] ?? null;
}

function parseBoard(params: URLSearchParams): Board {
  const value = singleParam(params, "by");
  if (value === null) return "level";
  if (!isBoard(value)) throw new HttpError(400, "invalid by");
  return value;
}

function parseLimit(params: URLSearchParams): number {
  const value = singleParam(params, "limit");
  if (value === null) return DEFAULT_LIMIT;
  // 数字だけの文字列に限る。それ以外（小数、負数、英字、空）は範囲外の0として扱い、400にする。
  const limit = /^[0-9]+$/.test(value) ? Number(value) : 0;
  if (limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, "invalid limit");
  return limit;
}

function parseMe(params: URLSearchParams): string | null {
  const value = singleParam(params, "me");
  if (value === null) return null;
  if (!UUID_V4.test(value)) throw new HttpError(400, "invalid me");
  return value;
}

function statOf(row: EntryRow, by: Board): number {
  if (by === "level") return row.level;
  if (by === "deepest") return row.deepest;
  return row.total_exp;
}

/**
 * D1から上位N件と登録人数を読んで、キャッシュに保存できる形にする。
 * meを指定したときは、同じトランザクションでボード上の自分の行と順位も読む。
 */
async function loadBoard(
  env: Env,
  by: Board,
  limit: number,
  me: string | null,
): Promise<{ board: CachedBoard; meRow: MeRow | undefined }> {
  // 2〜3個の問い合わせを1つのトランザクションにして、同じ時点の結果で組み立てる
  const statements = [env.DB.prepare(SQL.leaderboard[by]).bind(limit), env.DB.prepare(SQL.countPlayers)];
  if (me !== null) statements.push(env.DB.prepare(SQL.me[by]).bind(me));
  const [entriesResult, countResult, meResult] = await env.DB.batch<unknown>(statements);

  // 先頭から取っているので、同じ指標が続く間は直前と同じ順位になる（標準競技順位）
  const entries: CachedEntry[] = [];
  let previousStat = -1;
  let previousRank = 0;
  for (const [index, row] of rowsOf<EntryRow>(entriesResult).entries()) {
    const stat = statOf(row, by);
    const rank = stat === previousStat ? previousRank : index + 1;
    previousStat = stat;
    previousRank = rank;
    entries.push({
      id: row.id,
      rank,
      name: row.name,
      level: row.level,
      deepest: row.deepest,
      totalExp: row.total_exp,
    });
  }

  return {
    board: { entries, players: rowsOf<CountRow>(countResult)[0]?.n ?? 0 },
    meRow: rowsOf<MeRow>(meResult)[0],
  };
}

async function getLeaderboard(url: URL, env: Env): Promise<Response> {
  const by = parseBoard(url.searchParams);
  const limit = parseLimit(url.searchParams);
  const me = parseMe(url.searchParams);

  // 上位N件と登録人数は誰が見ても同じなので、数秒だけキャッシュする（キーはbyとlimitだけ）。
  // meを指定したときも、上位N件はキャッシュを使い、自分の行と順位だけをD1から読む。
  const cacheKey = leaderboardCacheKey(url.origin, by, limit);
  const cached = await readCachedBoard(cacheKey);
  let board: CachedBoard;
  let meRow: MeRow | undefined;
  if (cached !== null) {
    board = cached;
    if (me !== null) meRow = (await env.DB.prepare(SQL.me[by]).bind(me).first<MeRow>()) ?? undefined;
  } else {
    ({ board, meRow } = await loadBoard(env, by, limit, me));
    // 保存が終わってから応答する（失敗しても応答は返す）。ミスのときだけなので待ち時間は小さい
    await writeCachedBoard(cacheKey, board);
  }

  return json({
    by,
    // キャッシュにはidを持たせてあるので、isYouをidの比較で付け直し、idは返さない
    entries: board.entries.map((entry) => ({
      rank: entry.rank,
      name: entry.name,
      level: entry.level,
      deepest: entry.deepest,
      totalExp: entry.totalExp,
      isYou: entry.id === me,
    })),
    me:
      meRow === undefined
        ? null
        : { rank: meRow.rank, name: meRow.name, level: meRow.level, deepest: meRow.deepest, totalExp: meRow.total_exp },
    players: board.players,
  });
}

// ── ルーティング ──

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "method not allowed", { allow });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/v1/scores":
      if (request.method === "POST") return postScore(request, env);
      if (request.method === "DELETE") return deleteScore(request, env);
      throw methodNotAllowed("POST, DELETE");
    case "/v1/leaderboard":
      if (request.method === "GET") return getLeaderboard(url, env);
      throw methodNotAllowed("GET");
    default:
      throw new HttpError(404, "not found");
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status, error.headers);
      }
      // 想定外の失敗。内部の詳細（SQLの内容など）は応答に出さず、ログにだけ残す
      console.error(
        JSON.stringify({
          message: "unhandled error",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
