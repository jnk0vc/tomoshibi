import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQL } from "../src/sql";
import {
  ageUpdatedAt,
  callWithDb,
  clearLeaderboardCache,
  instrumentDb,
  newCredentials,
  postScore,
  postScoreWithDb,
  score,
  seed,
  setupPerTest,
  sha256Hex,
} from "./helpers";

setupPerTest();

// 上位N件のキャッシュが前のテストから残らないようにする
beforeEach(clearLeaderboardCache);
afterEach(clearLeaderboardCache);

/**
 * D1は読んだ行数と書いた行数で制限と課金が決まる。ここでは、登録人数Nに比例して増える読み取りが
 * 残っていないことと、更新の書き込み行数を、D1が返すmeta（rows_read、rows_written）で確かめる。
 * schema.spec.tsのクエリプランの検査は、全件走査の有無を見るだけで、実際の行数は見ない。
 */

/** 本体と同じSQLを実行して、読んだ行数と書いた行数を返す。 */
async function metaOf(sql: string, ...values: unknown[]) {
  const result = await env.DB.prepare(sql)
    .bind(...values)
    .all();
  return { rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written, results: result.results };
}

/** レベルが重ならないn人を入れる（順位が人数に近い下位のプレイヤーも作れる）。 */
async function seedLadder(count: number): Promise<string[]> {
  return seed(Array.from({ length: count }, (_, i) => ({ name: `p${i}`, level: 1000 - i, deepest: 1000 - i, totalExp: 1000 - i })));
}

describe("登録人数の取得", () => {
  it("人数が増えても、読むのはカウンタの1行だけ", async () => {
    await seedLadder(40);
    const small = await metaOf(SQL.countPlayers);
    await seedLadder(360);
    const large = await metaOf(SQL.countPlayers);

    expect(small.results).toEqual([{ n: 40 }]);
    expect(large.results).toEqual([{ n: 400 }]);
    expect(small.rowsRead).toBe(1);
    expect(large.rowsRead).toBe(1);
  });
});

describe("上位N件の取得", () => {
  it("人数がいくら増えても、読む行数はlimitで決まる（Nに比例しない）", async () => {
    await seedLadder(40);
    const small = await metaOf(SQL.leaderboard.level, 5);
    await seedLadder(360);
    const large = await metaOf(SQL.leaderboard.level, 5);

    expect(large.results).toHaveLength(5);
    expect(large.rowsRead).toBe(small.rowsRead);
    expect(large.rowsRead).toBeLessThanOrEqual(5 * 2);
  });

  it("3つのボードとも同じで、limit=50でも50行のオーダーで止まる", async () => {
    await seedLadder(400);
    for (const by of ["level", "deepest", "exp"] as const) {
      const { rowsRead } = await metaOf(SQL.leaderboard[by], 50);
      expect(rowsRead, by).toBeLessThanOrEqual(50 * 2);
    }
  });
});

describe("GET /v1/leaderboard全体のD1の読み取り", () => {
  it("meなしでキャッシュにないとき、登録人数が400人でも読む行数は上位N件と人数の取得だけ", async () => {
    await seedLadder(400);
    const spy = instrumentDb(env.DB);
    const res = await callWithDb(spy.db, "/v1/leaderboard?limit=5");

    expect(res.status).toBe(200);
    expect(res.body.players).toBe(400);
    const batch = spy.batches[0] ?? [];
    expect(batch).toHaveLength(2);
    const rowsRead = batch.reduce((sum, result) => sum + result.meta.rows_read, 0);
    // 上位5件ぶんと、カウンタの1行。人数の400には比例しない
    expect(rowsRead).toBeLessThanOrEqual(5 * 2 + 1);
  });

  it("キャッシュにあるときは、meなしならD1を読まない", async () => {
    await seedLadder(50);
    await callWithDb(env.DB, "/v1/leaderboard?limit=5"); // キャッシュに載せる
    const spy = instrumentDb(env.DB);
    const res = await callWithDb(spy.db, "/v1/leaderboard?limit=5");
    expect(res.status).toBe(200);
    expect(spy.prepared).toEqual([]);
    expect(spy.batches).toEqual([]);
  });
});

describe("順位の計算（標準競技順位）", () => {
  it("上位のプレイヤーほど読む行数が少なく、1位なら定数行で済む", async () => {
    const ids = await seedLadder(300);
    const top = await metaOf(SQL.me.level, ids[0]);
    const bottom = await metaOf(SQL.me.level, ids[299]);

    expect(top.results).toMatchObject([{ rank: 1 }]);
    expect(bottom.results).toMatchObject([{ rank: 300 }]);
    // 順位の計算は、自分より指標が大きい人数ぶんの行を読む（標準競技順位の定義上、なくせない）。
    // 1位なら自分の行だけ、最下位ならほぼ全員ぶん
    expect(top.rowsRead).toBeLessThanOrEqual(3);
    expect(bottom.rowsRead).toBeGreaterThanOrEqual(299);
    expect(bottom.rowsRead).toBeLessThanOrEqual(300 + 3);
  });

  it("書き込み後の3ボードの順位も、1位なら定数行で済む", async () => {
    const ids = await seedLadder(300);
    const top = await metaOf(SQL.rankAll, ids[0]);
    expect(top.rowsRead).toBeLessThanOrEqual(5);
  });
});

describe("POST /v1/scoresの更新の書き込み行数", () => {
  /** 送信間隔を過ぎた状態の既存プレイヤーを用意して、更新を送り、更新文のrows_writtenを返す。 */
  async function updateRowsWritten(initial: { level: number; deepest: number; totalExp: number }, sent: Partial<ReturnType<typeof score>>) {
    const creds = newCredentials();
    await seed([{ id: creds.playerId, tokenHash: await sha256Hex(creds.token), ...initial, updatedAt: 1_000 }]);
    const spy = instrumentDb(env.DB);
    const res = await postScoreWithDb(spy.db, creds, score({ kills: 0, ticks: 1_000, ...sent }));
    expect(res.status).toBe(200);
    const write = spy.batches[0]?.[0];
    expect(write).toBeDefined();
    return write?.meta.rows_written;
  }

  const stored = { level: 10, deepest: 12, totalExp: 500 };

  it("指標が1つも伸びない送信は、行本体の1行だけを書く（インデックスは書き換えない）", async () => {
    // 同値の再送信
    expect(await updateRowsWritten(stored, { level: 10, deepest: 12, totalExp: 500 })).toBe(1);
    // 古いクライアントの、すべて下がった送信
    expect(await updateRowsWritten(stored, { level: 1, deepest: 1, totalExp: 0 })).toBe(1);
  });

  it("指標が伸びたボードの数だけ、インデックスの書き込みが増える", async () => {
    expect(await updateRowsWritten(stored, { level: 11, deepest: 12, totalExp: 500 })).toBe(2);
    expect(await updateRowsWritten(stored, { level: 10, deepest: 13, totalExp: 500 })).toBe(2);
    expect(await updateRowsWritten(stored, { level: 10, deepest: 12, totalExp: 501 })).toBe(2);
    expect(await updateRowsWritten(stored, { level: 11, deepest: 13, totalExp: 500 })).toBe(3);
    expect(await updateRowsWritten(stored, { level: 11, deepest: 13, totalExp: 501 })).toBe(4);
  });

  it("指標が変わらない送信を続けても、並びを決める列（*_at）は書き換えない", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ level: 10, deepest: 12, totalExp: 500 }));
    const row = await env.DB.prepare("SELECT level_at, deepest_at, exp_at FROM players WHERE id = ?")
      .bind(creds.playerId)
      .first();
    await ageUpdatedAt(creds.playerId);
    await postScore(creds, score({ level: 10, deepest: 12, totalExp: 500, kills: 41, ticks: 101 }));
    expect(
      await env.DB.prepare("SELECT level_at, deepest_at, exp_at FROM players WHERE id = ?").bind(creds.playerId).first(),
    ).toEqual(row);
  });
});
