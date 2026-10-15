import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ageUpdatedAt,
  callWithDb,
  counterValue,
  dbCount,
  dbRow,
  expectError,
  instrumentDb,
  newCredentials,
  newToken,
  postScore,
  postScoreWithDb,
  score,
  seed,
  setupPerTest,
  sha256Hex,
} from "./helpers";

setupPerTest();

/**
 * 同時リクエストの競合を、タイミング任せにせず決まった順で起こすテスト。
 *
 * D1を包んで、Workerが認証情報を読んだ（SQL.selectPlayerのfirst()が結果を返した）直後に、
 * 競合する相手の書き込みを本物のD1へ直接入れる。Workerには読んだ時点の結果を返すので、
 * 「読んだあと、書き込む前に、相手の書き込みが入った」状態になる。
 * 残りのSQLとbatchは本物のD1にそのまま渡す。
 *
 * 退行とこのテストの対応:
 * - 初回登録のINSERTをON CONFLICT DO UPDATE SET token_hash = ...にする → 「別トークン」の初回登録の競合が落ちる
 * - 書き込みの再試行回数(MAX_WRITE_ATTEMPTS)を1にする → 初回登録の競合2件が落ちる（429になる）
 * - UPDATEのWHEREから送信間隔の条件(updated_at <= ?)を外す → 更新の競合のうち間隔のテストが落ちる
 * - UPDATEのWHEREからtoken_hash = ?を外す → 更新の競合のうちトークンのテストが落ちる
 * - DELETEの結果(changes)を見ない → 削除の競合が落ちる
 */
describe("初回登録の競合（読んだ直後に、同じplayerIdが先に登録される）", () => {
  it("別のトークンで先に登録されたら、後から来た側は403で、トークンも名前も先の人のままになる", async () => {
    const creds = newCredentials();
    const rivalToken = newToken();
    const rivalHash = await sha256Hex(rivalToken);
    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        await seed([{ id: creds.playerId, tokenHash: rivalHash, name: "先に登録した人", updatedAt: Date.now() }]);
      },
    });

    const res = await postScoreWithDb(db, creds, score({ name: "後から来た人" }));

    expectError(res, 403, "invalid token");
    expect(await dbRow(creds.playerId)).toMatchObject({ token_hash: rivalHash, name: "先に登録した人" });
    // 先を越されて挿入されなかった側は、登録人数を増やさない
    expect(await dbCount()).toBe(1);
    expect(await counterValue()).toBe(1);
  });

  it("同じトークンで先に登録されたら、後から来た側は429（間隔内の再送信）になり、先の行は変わらない", async () => {
    const creds = newCredentials();
    const hash = await sha256Hex(creds.token);
    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        // 先の登録は、いま受理されたところ（送信間隔の内側）
        await seed([{ id: creds.playerId, tokenHash: hash, name: "先に登録した送信", level: 3, updatedAt: Date.now() }]);
      },
    });

    const res = await postScoreWithDb(db, creds, score({ name: "後から来た送信", level: 15, ticks: 400 }));

    expectError(res, 429, "too many requests");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await dbRow(creds.playerId)).toMatchObject({ name: "先に登録した送信", level: 3 });
    expect(await dbCount()).toBe(1);
    expect(await counterValue()).toBe(1);
  });
});

describe("更新の競合（読んだ直後に、同じプレイヤーの別の書き込みが入る）", () => {
  it("読んだ直後に別の送信が受理されたら、間隔の条件で書き込みを止めて429にする", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "最初", level: 10 }));
    await ageUpdatedAt(creds.playerId); // 送信間隔を過ぎた状態にする

    let rivalAcceptedAt = 0;
    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        // 競合する相手の送信が、いま受理されたことにする
        rivalAcceptedAt = Date.now();
        await env.DB.prepare("UPDATE players SET updated_at = ? WHERE id = ?").bind(rivalAcceptedAt, creds.playerId).run();
      },
    });

    const res = await postScoreWithDb(db, creds, score({ name: "競合に負けた送信", level: 15, ticks: 400 }));

    expectError(res, 429, "too many requests");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(20);
    // 名前も指標も、競合に負けた送信では書き換わらない
    expect(await dbRow(creds.playerId)).toMatchObject({ name: "最初", level: 10, updated_at: rivalAcceptedAt });
  });

  it("読んだ直後に別のトークンで登録し直されたら、書き込みを止めて403にする", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "最初", level: 10 }));
    await ageUpdatedAt(creds.playerId);

    const rivalHash = await sha256Hex(newToken());
    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        // 同じplayerIdが脱退して、別のトークンで登録し直された
        await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(creds.playerId).run();
        await seed([{ id: creds.playerId, tokenHash: rivalHash, name: "登録し直した人", level: 2, updatedAt: 1_000 }]);
      },
    });

    const res = await postScoreWithDb(db, creds, score({ name: "古いトークンの送信", level: 15, ticks: 400 }));

    expectError(res, 403, "invalid token");
    expect(await dbRow(creds.playerId)).toMatchObject({ name: "登録し直した人", level: 2, token_hash: rivalHash });
    expect(await counterValue()).toBe(await dbCount());
  });
});

describe("更新の競合で、読んだあとに別の送信が成績を伸ばしていた場合", () => {
  /**
   * 既存プレイヤーを登録して送信間隔を過ぎた状態にし、読んだ直後にrivalの成績が書き込まれる状態で送信する。
   * rivalの書き込みはupdated_atに触れないので、送信間隔の条件は通る。
   * 送信は読んだ時点の保存値(10/12/500/40/100)より大きいので、3つのボードとも「伸びる」更新文になる。
   */
  async function sendAfterRivalRaised(
    rival: { level: number; deepest: number; totalExp: number; kills: number; ticks: number },
    sent: { level: number; deepest: number; totalExp: number; kills: number; ticks: number },
  ) {
    const creds = newCredentials();
    await postScore(creds, score({ name: "最初", level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 }));
    await ageUpdatedAt(creds.playerId);
    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        await env.DB.prepare(
          "UPDATE players SET level = ?, deepest = ?, total_exp = ?, kills = ?, ticks = ?, " +
            "level_at = 777, deepest_at = 777, exp_at = 777 WHERE id = ?",
        )
          .bind(rival.level, rival.deepest, rival.totalExp, rival.kills, rival.ticks, creds.playerId)
          .run();
      },
    });
    const res = await postScoreWithDb(db, creds, score({ name: "競合に遅れた送信", ...sent }));
    expect(res.status).toBe(200);
    return dbRow(creds.playerId);
  }

  it("相手が書いた値より小さい送信値では、MAXで保存値を下げず、到達時刻も進めない（5指標とも）", async () => {
    const row = await sendAfterRivalRaised(
      { level: 15, deepest: 30, totalExp: 900, kills: 80, ticks: 400 },
      { level: 11, deepest: 20, totalExp: 600, kills: 50, ticks: 300 },
    );
    expect(row).toMatchObject({
      name: "競合に遅れた送信",
      level: 15,
      deepest: 30,
      total_exp: 900,
      kills: 80,
      ticks: 400,
      level_at: 777,
      deepest_at: 777,
      exp_at: 777,
    });
  });

  it("相手が書いた値と同じ送信値では、指標は同じままで、到達時刻を進めない（厳密に上回ったときだけ進める）", async () => {
    const row = await sendAfterRivalRaised(
      { level: 11, deepest: 20, totalExp: 600, kills: 50, ticks: 300 },
      { level: 11, deepest: 20, totalExp: 600, kills: 50, ticks: 300 },
    );
    expect(row).toMatchObject({
      level: 11,
      deepest: 20,
      total_exp: 600,
      level_at: 777,
      deepest_at: 777,
      exp_at: 777,
    });
  });
});

describe("削除の競合（読んだ直後に、同じプレイヤーが先に削除される）", () => {
  it("先に削除されていたら、後から来た削除は404で、人数は二重に減らない", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await seed([{}, {}]); // 他の2人は残る

    const { db } = instrumentDb(env.DB, {
      afterSelectPlayer: async () => {
        await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(creds.playerId).run();
      },
    });
    const res = await callWithDb(db, "/v1/scores", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creds),
    });

    expectError(res, 404, "player not found");
    expect(await dbCount()).toBe(2);
    expect(await counterValue()).toBe(2);
  });
});
