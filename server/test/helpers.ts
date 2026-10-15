import type { D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect } from "vitest";
import { leaderboardCacheKey } from "../src/cache";
import worker from "../src/index";
import { SQL } from "../src/sql";

// vitest.config.tsが渡すテスト専用バインディングの型
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export const BASE = "https://ranking.test";

/** 送信間隔(20秒)より十分に古い時刻にするためのずらし量 */
export const AGED_MS = 25_000;

export interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  /** JSONとして読めた本文（読めなければnull）。テストが形を緩く確かめるためanyにしている。 */
  body: any;
}

/** このテストで受け取った応答の本文。afterEachで秘密情報が漏れていないか調べる。 */
const seenBodies: string[] = [];
/** このテストで使ったplayerIdとtoken。応答に含まれていたら失敗にする。 */
const secrets = new Set<string>();

export function newPlayerId(): string {
  const id = crypto.randomUUID();
  secrets.add(id);
  return id;
}

export function newToken(): string {
  // 32文字以上で、[A-Za-z0-9_-]だけの値
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
  secrets.add(token);
  return token;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 応答を読み取ってApiResultにする。受け取った本文は、afterEachの秘密情報の検査に回す。 */
export async function readResult(response: Response): Promise<ApiResult> {
  const text = await response.text();
  seenBodies.push(text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // JSONでない応答はbodyをnullのままにする（content-typeの検査で気付けるようにする）
  }
  return { status: response.status, headers: response.headers, text, body };
}

export async function call(path: string, init?: RequestInit): Promise<ApiResult> {
  return readResult(await exports.default.fetch(new Request(`${BASE}${path}`, init)));
}

/** 差し替えたDBでWorkerのfetchハンドラを直接呼ぶ（exports.default.fetchはenvを差し替えられない）。 */
export async function callWithDb(db: D1Database, path: string, init?: RequestInit): Promise<ApiResult> {
  // fetchハンドラの型はcfがIncomingRequestCfPropertiesのRequestを求めるので、initからcfを除いて作る
  const { cf: _cf, ...rest } = init ?? {};
  const request = new Request<unknown, IncomingRequestCfProperties>(`${BASE}${path}`, rest);
  return readResult(await worker.fetch(request, { ...env, DB: db }));
}

const JSON_HEADERS = { "content-type": "application/json" };

/** JSON文字列をそのまま送る（壊れたJSONを送るテスト用） */
export function sendRaw(method: string, path: string, raw: string, contentType = "application/json") {
  return call(path, { method, headers: { "content-type": contentType }, body: raw });
}

export function sendJson(method: string, path: string, payload: unknown) {
  return call(path, { method, headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

/** postScoreと同じ本文を、差し替えたDB経由で送る。 */
export function postScoreWithDb(db: D1Database, creds: Credentials, input: ScoreInput = score()) {
  return callWithDb(db, "/v1/scores", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...creds, ...input }) });
}

export interface Credentials {
  playerId: string;
  token: string;
}

export function newCredentials(): Credentials {
  return { playerId: newPlayerId(), token: newToken() };
}

export interface ScoreInput {
  name: string;
  level: number;
  deepest: number;
  totalExp: number;
  kills: number;
  ticks: number;
}

/** 検証を通る標準の成績。テストごとに一部だけ上書きする。 */
export function score(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return { name: "ミナト", level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100, ...overrides };
}

export function postScore(creds: Credentials, input: ScoreInput = score()) {
  return sendJson("POST", "/v1/scores", { ...creds, ...input });
}

export function deleteScore(creds: Credentials) {
  return sendJson("DELETE", "/v1/scores", creds);
}

const BOARD_NAMES = ["level", "deepest", "exp"] as const;

/** 上位N件のキャッシュを、3ボード×limit 1〜50の全キーぶん消す（150回のdeleteなので、必要なテストだけが呼ぶ）。 */
export async function clearLeaderboardCache(): Promise<void> {
  const keys = BOARD_NAMES.flatMap((by) => Array.from({ length: 50 }, (_, i) => leaderboardCacheKey(BASE, by, i + 1)));
  await Promise.all(keys.map((key) => caches.default.delete(key)));
}

/** クエリが指す（byとlimitで決まる）キャッシュ1件を消す。不正なクエリなら何もしない。 */
async function purgeLeaderboardCacheFor(query: string): Promise<void> {
  const params = new URLSearchParams(query);
  const by = params.get("by") ?? "level";
  const limitText = params.get("limit") ?? "20";
  if (!/^[0-9]+$/.test(limitText)) return;
  await caches.default.delete(leaderboardCacheKey(BASE, by, Number(limitText)));
}

/**
 * ランキングを取得する。DBを書き換えながら繰り返し読むテストが多いので、毎回その組み合わせの
 * キャッシュを消してからD1の最新の値を読む。キャッシュそのものを試すときはleaderboardNoPurgeを使う。
 */
export async function leaderboard(query = "") {
  await purgeLeaderboardCacheFor(query);
  return leaderboardNoPurge(query);
}

/** キャッシュを消さずにランキングを取得する（キャッシュの挙動を確かめるテスト用）。 */
export function leaderboardNoPurge(query = "") {
  return call(`/v1/leaderboard${query}`);
}

/** 送信間隔を過ぎた状態にする（実時間で20秒待たずにすむ） */
export async function ageUpdatedAt(playerId: string, byMs = AGED_MS): Promise<void> {
  await env.DB.prepare("UPDATE players SET updated_at = updated_at - ? WHERE id = ?").bind(byMs, playerId).run();
}

/** 各ボードの指標に到達した時刻を直接書き換える（並び順を決まった形にしたいテスト用）。省略した列は変えない。 */
export async function setReachTimes(
  playerId: string,
  times: { levelAt?: number; deepestAt?: number; expAt?: number },
): Promise<void> {
  await env.DB.prepare(
    "UPDATE players SET level_at = COALESCE(?, level_at), deepest_at = COALESCE(?, deepest_at), " +
      "exp_at = COALESCE(?, exp_at) WHERE id = ?",
  )
    .bind(times.levelAt ?? null, times.deepestAt ?? null, times.expAt ?? null, playerId)
    .run();
}

export interface DbHooks {
  /**
   * 認証情報を読むSQL(SQL.selectPlayer)のfirst()が結果を返した直後に、1回だけ呼ぶ。
   * 「読んだ直後に、競合する相手の書き込みが入る」状態を、タイミング任せにせず決まった順で作る。
   * 呼び出し元には、読んだ時点の結果をそのまま返す。
   */
  afterSelectPlayer?: () => Promise<void>;
}

export interface InstrumentedDb {
  db: D1Database;
  /** prepare()に渡されたSQL（呼ばれた順） */
  prepared: string[];
  /** batch()が返した結果（呼ばれた順） */
  batches: D1Result<unknown>[][];
}

/**
 * 本物のD1を包んで、呼び出しを記録し、必要なら競合する書き込みを差し込む。
 * SQL.selectPlayer以外の文と、batchは、本物のD1にそのまま渡す。
 */
export function instrumentDb(real: D1Database, hooks: DbHooks = {}): InstrumentedDb {
  const prepared: string[] = [];
  const batches: D1Result<unknown>[][] = [];
  let hookFired = false;

  const hookedStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => hookedStatement(target.bind(...values));
        if (property === "first") {
          return async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(target.first, target, args);
            if (!hookFired && hooks.afterSelectPlayer !== undefined) {
              hookFired = true;
              await hooks.afterSelectPlayer();
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const db = new Proxy(real, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          prepared.push(sql);
          const statement = target.prepare(sql);
          return sql === SQL.selectPlayer ? hookedStatement(statement) : statement;
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          batches.push(results);
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, prepared, batches };
}

export interface SeedRow {
  id?: string;
  /** 省略するとSHA-256の形をした値（0が64個）にする。 */
  tokenHash?: string;
  name?: string;
  level?: number;
  deepest?: number;
  totalExp?: number;
  kills?: number;
  ticks?: number;
  /** 最終送信時刻。省略するとlevelAtなども同じ値になる。 */
  updatedAt?: number;
  /** 各ボードの指標に到達した時刻。省略するとupdatedAtと同じ。 */
  levelAt?: number;
  deepestAt?: number;
  expAt?: number;
}

/** APIを通さず、行をそのままDBへ入れる。並び順や同順位を正確に作りたいときに使う。 */
export async function seed(rows: SeedRow[]): Promise<string[]> {
  const ids: string[] = [];
  const statements = rows.map((row, index) => {
    const id = row.id ?? newPlayerId();
    ids.push(id);
    const updatedAt = row.updatedAt ?? 1_000 + index;
    return env.DB.prepare(
      "INSERT INTO players (id, token_hash, name, level, deepest, total_exp, kills, ticks, created_at, updated_at, " +
        "level_at, deepest_at, exp_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      row.tokenHash ?? "0".repeat(64),
      row.name ?? `p${index}`,
      row.level ?? 1,
      row.deepest ?? 1,
      row.totalExp ?? 0,
      row.kills ?? 0,
      row.ticks ?? 0,
      updatedAt,
      updatedAt,
      row.levelAt ?? updatedAt,
      row.deepestAt ?? updatedAt,
      row.expAt ?? updatedAt,
    );
  });
  if (statements.length > 0) await env.DB.batch(statements);
  return ids;
}

export interface PlayerDbRow {
  id: string;
  token_hash: string;
  name: string;
  level: number;
  deepest: number;
  total_exp: number;
  kills: number;
  ticks: number;
  created_at: number;
  updated_at: number;
  level_at: number;
  deepest_at: number;
  exp_at: number;
}

export async function dbRow(playerId: string): Promise<PlayerDbRow | null> {
  return env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(playerId).first<PlayerDbRow>();
}

/** playersの実際の行数（全件を数える。テストの確認用） */
export async function dbCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
  return row?.n ?? 0;
}

/** 登録人数のカウンタ行の値（Workerが読むのと同じ値） */
export async function counterValue(): Promise<number> {
  const row = await env.DB.prepare("SELECT n FROM player_count WHERE id = 1").first<{ n: number }>();
  return row?.n ?? Number.NaN;
}

const FORBIDDEN_KEYS = new Set(["playerid", "player_id", "id", "token", "token_hash", "tokenhash"]);
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA256_ANYWHERE = /[0-9a-f]{64}/i;

/** JSONの全キーと全文字列を調べ、識別子やトークンのハッシュが含まれていないことを確かめる。 */
function assertNoLeak(text: string): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        expect(FORBIDDEN_KEYS.has(key.toLowerCase()), `応答に禁止キー${key}が含まれている`).toBe(false);
        visit(inner);
      }
    } else if (typeof value === "string") {
      expect(UUID_ANYWHERE.test(value), `応答にUUIDらしい文字列が含まれている: ${value}`).toBe(false);
      expect(SHA256_ANYWHERE.test(value), `応答にSHA-256らしい文字列が含まれている: ${value}`).toBe(false);
    }
  };
  try {
    visit(JSON.parse(text));
  } catch {
    // JSONでない応答は下の部分文字列の検査だけにする
  }
  for (const secret of secrets) {
    expect(text.includes(secret), "応答にplayerIdまたはtokenが含まれている").toBe(false);
  }
}

/** ここまでに受け取った全応答に、playerIdやtokenのハッシュが含まれていないことを確かめる。 */
export function assertNoLeaksInSeenBodies(): void {
  for (const text of seenBodies) assertNoLeak(text);
}

/** エラー応答の形（errorキーだけのJSON、UTF-8）とステータスを確かめる。 */
export function expectError(res: ApiResult, status: number, reason?: string): void {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(Object.keys(res.body ?? {})).toEqual(["error"]);
  expect(typeof res.body.error).toBe("string");
  // 短い英語の理由（英字と半角スペースだけ）
  expect(res.body.error).toMatch(/^[A-Za-z][A-Za-z ]*$/);
  if (reason !== undefined) expect(res.body.error).toBe(reason);
}

/**
 * 各テストの前にテーブルを空にし、各テストの後に「どの応答にもplayerIdやtokenのハッシュが
 * 含まれていない」ことを確かめる。テストファイルの先頭で1回呼ぶ。
 */
export function setupPerTest(): void {
  beforeEach(async () => {
    // DELETEのトリガーが登録人数のカウンタも0に戻す
    await env.DB.prepare("DELETE FROM players").run();
    seenBodies.length = 0;
    secrets.clear();
  });
  afterEach(() => {
    for (const text of seenBodies) assertNoLeak(text);
  });
}
