import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ageUpdatedAt,
  counterValue,
  dbCount,
  deleteScore,
  leaderboard,
  newCredentials,
  newToken,
  postScore,
  score,
  seed,
  setupPerTest,
} from "./helpers";

setupPerTest();

/** 登録人数のカウンタ（player_count）が、実際の行数とずれないことを確かめる。 */
describe("登録人数のカウンタ", () => {
  it("新規登録で1増え、GETのplayersに反映される", async () => {
    expect(await counterValue()).toBe(0);
    await postScore(newCredentials());
    await postScore(newCredentials());

    expect(await counterValue()).toBe(2);
    expect(await dbCount()).toBe(2);
    expect((await leaderboard()).body.players).toBe(2);
  });

  it("更新と、断られた送信（400、403、422、429）では増減しない", async () => {
    const creds = newCredentials();
    await postScore(creds);

    expect((await postScore(creds)).status).toBe(429);
    expect((await postScore({ playerId: creds.playerId, token: newToken() })).status).toBe(403);
    expect((await postScore(creds, score({ name: "" }))).status).toBe(400);
    expect((await postScore(creds, score({ level: 99, ticks: 0 }))).status).toBe(422);
    await ageUpdatedAt(creds.playerId);
    expect((await postScore(creds)).status).toBe(200); // 更新

    expect(await counterValue()).toBe(1);
    expect(await dbCount()).toBe(1);
  });

  it("削除で1減り、二度目の削除や、トークン違い、登録なしでは減らない", async () => {
    const creds = newCredentials();
    const other = newCredentials();
    await postScore(creds);
    await postScore(other);

    expect((await deleteScore({ playerId: creds.playerId, token: newToken() })).status).toBe(403);
    expect(await counterValue()).toBe(2);

    expect((await deleteScore(creds)).status).toBe(200);
    expect(await counterValue()).toBe(1);
    expect((await deleteScore(creds)).status).toBe(404);
    expect((await deleteScore(newCredentials())).status).toBe(404);
    expect(await counterValue()).toBe(1);
    expect(await dbCount()).toBe(1);
    expect((await leaderboard()).body.players).toBe(1);
  });

  it("削除したあとの登録し直しで、また1増える", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await deleteScore(creds);
    expect(await counterValue()).toBe(0);

    await postScore({ playerId: creds.playerId, token: newToken() });
    expect(await counterValue()).toBe(1);
  });

  it("ON CONFLICT DO NOTHINGで挿入されなかった行は、カウンタを増やさない", async () => {
    const [id] = await seed([{}]);
    expect(await counterValue()).toBe(1);
    const result = await env.DB.prepare(
      "INSERT INTO players (id, token_hash, name, level, deepest, total_exp, kills, ticks, created_at, updated_at, " +
        "level_at, deepest_at, exp_at) VALUES (?, 'h', 'n', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0) ON CONFLICT(id) DO NOTHING",
    )
      .bind(id)
      .run();
    // 挿入されていない（トリガーも動かない）ので、更新された行は0
    expect(result.meta.changes).toBe(0);
    expect(await counterValue()).toBe(1);
  });

  it("APIを通さず入れた行や、まとめた削除でも、トリガーが数える", async () => {
    await seed([{}, {}, {}, {}, {}]);
    expect(await counterValue()).toBe(5);
    await env.DB.prepare("DELETE FROM players WHERE level = 1").run();
    expect(await counterValue()).toBe(0);
    expect(await dbCount()).toBe(0);
  });
});

describe("マイグレーション0003（登録人数のカウンタ）", () => {
  /** テスト用に読み込んだマイグレーションのSQLを、本物と同じ文の区切りで流す。 */
  async function runMigration(fragment: string): Promise<void> {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes(fragment));
    expect(migration, `${fragment}のマイグレーションが読み込まれている`).toBeDefined();
    if (migration === undefined) return;
    await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
  }

  it("すでに行があるDBに適用すると、既存の人数で初期化し、そのあとはトリガーが増減させる", async () => {
    try {
      // 0003を適用する前の状態（カウンタなし）に戻して、行を入れる
      await env.DB.batch([
        env.DB.prepare("DROP TRIGGER players_ai"),
        env.DB.prepare("DROP TRIGGER players_ad"),
        env.DB.prepare("DROP TABLE player_count"),
      ]);
      await seed([{}, {}, {}, {}]);

      await runMigration("0003_player_count");
      expect(await counterValue()).toBe(4);

      // 適用後は、APIの新規登録と削除に合わせて増減する
      const creds = newCredentials();
      await postScore(creds);
      expect(await counterValue()).toBe(5);
      await deleteScore(creds);
      expect(await counterValue()).toBe(4);
    } finally {
      // 途中で失敗しても、あとのテストのためにカウンタとトリガーが揃った状態に戻す
      const exists = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'player_count'").first();
      if (exists === null) await runMigration("0003_player_count");
    }
  });
});
