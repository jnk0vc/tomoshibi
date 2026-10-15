import { describe, expect, it } from "vitest";
import {
  ageUpdatedAt,
  assertNoLeaksInSeenBodies,
  call,
  dbCount,
  dbRow,
  deleteScore,
  expectError,
  leaderboard,
  newCredentials,
  newPlayerId,
  newToken,
  postScore,
  score,
  seed,
  sendJson,
  sendRaw,
  setReachTimes,
  setupPerTest,
  sha256Hex,
} from "./helpers";

setupPerTest();

describe("POST /v1/scoresの新規登録", () => {
  it("初めてのplayerIdは登録して、3つのボードの順位を返す", async () => {
    const creds = newCredentials();
    const res = await postScore(creds);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body).toEqual({ ok: true, rank: { level: 1, deepest: 1, exp: 1 } });
    expect(await dbCount()).toBe(1);
  });

  it("DBにはトークンそのものではなくSHA-256の16進だけを保存する", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "ミナト", level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 }));

    const row = await dbRow(creds.playerId);
    expect(row).not.toBeNull();
    expect(row?.token_hash).toBe(await sha256Hex(creds.token));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // どの列にもトークンが入っていない
    expect(JSON.stringify(row)).not.toContain(creds.token);
    expect(row).toMatchObject({ name: "ミナト", level: 10, deepest: 12, total_exp: 500, kills: 40, ticks: 100 });
    expect(row?.created_at).toBe(row?.updated_at);
    // 登録した時点で3つのボードの指標に到達したことになる
    expect(row?.level_at).toBe(row?.created_at);
    expect(row?.deepest_at).toBe(row?.created_at);
    expect(row?.exp_at).toBe(row?.created_at);
  });

  it("順位は「自分より厳密に大きい人数に1を足した値」で、同値は同順位になる", async () => {
    await seed([
      { level: 30, deepest: 5, totalExp: 100 },
      { level: 20, deepest: 50, totalExp: 100 },
      { level: 20, deepest: 50, totalExp: 9999 },
    ]);
    const res = await postScore(
      newCredentials(),
      score({ level: 20, deepest: 40, totalExp: 100, kills: 0, ticks: 100 }),
    );

    // levelは30が1人で2位、deepestは50が2人で3位、expは9999が1人で2位
    expect(res.body).toEqual({ ok: true, rank: { level: 2, deepest: 3, exp: 2 } });
  });

  it("安全な整数の上限までそのまま保存して返せる", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const creds = newCredentials();
    const res = await postScore(
      creds,
      score({ level: 1_000_000_000_000_000, deepest: 1_000_000_000_000_000, totalExp: max, kills: max, ticks: max }),
    );
    expect(res.status).toBe(200);

    const row = await dbRow(creds.playerId);
    expect(row).toMatchObject({ total_exp: max, kills: max, ticks: max });
    const board = await leaderboard("?by=exp&limit=1");
    expect(board.body.entries[0].totalExp).toBe(max);
  });

  it("更新でも大きな整数のMAXが精度を落とさない", async () => {
    const creds = newCredentials();
    const big = 2 ** 52 + 1;
    const max = Number.MAX_SAFE_INTEGER;
    await postScore(creds, score({ totalExp: big, kills: 0, ticks: 100 }));

    await ageUpdatedAt(creds.playerId);
    await postScore(creds, score({ totalExp: max, kills: 0, ticks: 100 }));
    expect((await dbRow(creds.playerId))?.total_exp).toBe(max);

    // 小さい値を送っても下がらない
    await ageUpdatedAt(creds.playerId);
    await postScore(creds, score({ totalExp: big, kills: 0, ticks: 100 }));
    expect((await dbRow(creds.playerId))?.total_exp).toBe(max);
  });

  it("契約にないフィールドは無視する", async () => {
    const res = await sendJson("POST", "/v1/scores", { ...newCredentials(), ...score(), extra: "ignored" });
    expect(res.status).toBe(200);
  });

  it("クエリ文字列が付いていても同じパスとして扱う", async () => {
    const res = await sendJson("POST", "/v1/scores?x=1", { ...newCredentials(), ...score() });
    expect(res.status).toBe(200);
  });

  it("名前の前後の空白を除き、途中の空白の連続を半角スペース1つにする", async () => {
    const cases: [string, string][] = [
      ["  ミナト  ", "ミナト"],
      ["a \t\n  b", "a b"],
      ["ア　　イ", "ア イ"],
      ["  x  y ", "x y"],
    ];
    for (const [sent, expected] of cases) {
      const creds = newCredentials();
      expect((await postScore(creds, score({ name: sent }))).status).toBe(200);
      expect((await dbRow(creds.playerId))?.name).toBe(expected);
    }
  });

  it("名前の長さはコードポイントで数え、12まで許す", async () => {
    const ok12 = ["あ".repeat(12), "𠮷".repeat(12), "🔥".repeat(12), "abcdefghijkl"];
    for (const name of ok12) {
      const res = await postScore(newCredentials(), score({ name }));
      expect(res.status, name).toBe(200);
    }
    // 空白を詰めたあとの長さで判定する（詰める前は13文字でも通る）
    expect((await postScore(newCredentials(), score({ name: "a  b  c  d  e  f" }))).status).toBe(200);

    for (const name of ["あ".repeat(13), "𠮷".repeat(13), "🔥".repeat(13)]) {
      expectError(await postScore(newCredentials(), score({ name })), 400, "invalid name");
    }
  });
});

describe("POST /v1/scoresの更新", () => {
  it("各指標は保存値と送信値のMAXで保存し、名前は置き換える", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "初代", level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 }));
    const before = await dbRow(creds.playerId);
    await ageUpdatedAt(creds.playerId);

    // 古いクライアントを模して、levelとexpは下がり、deepestとticksだけ上がる送信
    const res = await postScore(
      creds,
      score({ name: "二代目", level: 5, deepest: 30, totalExp: 100, kills: 10, ticks: 400 }),
    );
    expect(res.status).toBe(200);

    const after = await dbRow(creds.playerId);
    expect(after).toMatchObject({
      name: "二代目",
      level: 10,
      deepest: 30,
      total_exp: 500,
      kills: 40,
      ticks: 400,
      created_at: before?.created_at,
    });
    expect(after?.updated_at).toBeGreaterThan(before?.updated_at ?? Infinity);

    // 次は全指標が上がる送信
    await ageUpdatedAt(creds.playerId);
    await postScore(creds, score({ name: "三代目", level: 11, deepest: 31, totalExp: 600, kills: 50, ticks: 500 }));
    expect(await dbRow(creds.playerId)).toMatchObject({
      name: "三代目",
      level: 11,
      deepest: 31,
      total_exp: 600,
      kills: 50,
      ticks: 500,
    });
  });

  it("返す順位は書き込み後の保存値（MAX後）で決まる", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 }));
    await seed([{ level: 5, deepest: 50, totalExp: 100 }]);
    await ageUpdatedAt(creds.playerId);

    // levelを1で送っても、保存値は10のままなのでlevelボードでは1位
    const res = await postScore(creds, score({ level: 1, deepest: 1, totalExp: 0, kills: 0, ticks: 0 }));
    expect(res.status).toBe(200);
    expect(res.body.rank).toEqual({ level: 1, deepest: 2, exp: 1 });
    // 全指標を下げて送ったので、5指標すべてでMAXが効いて保存値が変わらないことを確かめる
    expect(await dbRow(creds.playerId)).toMatchObject({ level: 10, deepest: 12, total_exp: 500, kills: 40, ticks: 100 });
  });

  it("指標が厳密に伸びたボードの到達時刻だけが進み、同値や下がった送信では進まない", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 }));
    // 到達時刻を、今より十分に古い決まった値にしておく
    await setReachTimes(creds.playerId, { levelAt: 100, deepestAt: 200, expAt: 300 });
    await ageUpdatedAt(creds.playerId);
    const before = await dbRow(creds.playerId);

    // levelは伸びる、deepestは同値、expは下がる
    await postScore(creds, score({ level: 11, deepest: 12, totalExp: 100, kills: 40, ticks: 100 }));
    const after = await dbRow(creds.playerId);
    expect(after?.level_at).toBe(after?.updated_at);
    expect(after?.level_at).toBeGreaterThan(before?.updated_at ?? Infinity);
    expect(after?.deepest_at).toBe(200);
    expect(after?.exp_at).toBe(300);

    // 次はdeepestとexpだけが伸びる
    await setReachTimes(creds.playerId, { levelAt: 100 });
    await ageUpdatedAt(creds.playerId);
    await postScore(creds, score({ level: 11, deepest: 13, totalExp: 501, kills: 40, ticks: 100 }));
    const third = await dbRow(creds.playerId);
    expect(third?.level_at).toBe(100);
    expect(third?.deepest_at).toBe(third?.updated_at);
    expect(third?.exp_at).toBe(third?.updated_at);
  });

  it("指標が1つも伸びない送信でも、名前、kills、ticks、最終送信時刻は更新する", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "前", level: 10, kills: 10, ticks: 100 }));
    await setReachTimes(creds.playerId, { levelAt: 100, deepestAt: 200, expAt: 300 });
    await ageUpdatedAt(creds.playerId);
    const before = await dbRow(creds.playerId);

    await postScore(creds, score({ name: "後", level: 10, deepest: 12, totalExp: 500, kills: 11, ticks: 101 }));
    const after = await dbRow(creds.playerId);
    expect(after).toMatchObject({ name: "後", kills: 11, ticks: 101, level_at: 100, deepest_at: 200, exp_at: 300 });
    expect(after?.updated_at).toBeGreaterThan(before?.updated_at ?? Infinity);
  });

  it("別のプレイヤーの送信間隔には影響されない", async () => {
    expect((await postScore(newCredentials())).status).toBe(200);
    expect((await postScore(newCredentials())).status).toBe(200);
  });
});

describe("POST /v1/scoresのトークン認証", () => {
  it("別のトークンで送ると403で、保存済みの値は変わらない", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "本人", level: 10 }));
    const before = await dbRow(creds.playerId);
    await ageUpdatedAt(creds.playerId);

    const res = await postScore(
      { playerId: creds.playerId, token: newToken() },
      score({ name: "なりすまし", level: 15, ticks: 1000 }),
    );
    expectError(res, 403, "invalid token");

    const after = await dbRow(creds.playerId);
    expect(after).toMatchObject({ name: "本人", level: 10, token_hash: before?.token_hash });
  });

  it("トークンが違えば送信間隔の内側でも429ではなく403を返す", async () => {
    const creds = newCredentials();
    await postScore(creds);
    const res = await postScore({ playerId: creds.playerId, token: newToken() });
    expectError(res, 403, "invalid token");
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("トークンは最初に送ったものに固定され、あとから差し替えられない", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await ageUpdatedAt(creds.playerId);
    const otherToken = newToken();
    expectError(await postScore({ playerId: creds.playerId, token: otherToken }), 403);
    // 元のトークンならまだ送れる
    expect((await postScore(creds)).status).toBe(200);
  });
});

describe("POST /v1/scoresの送信間隔(20秒)", () => {
  it("間隔内の再送信は429とRetry-After（秒）を返し、値は変わらない", async () => {
    const creds = newCredentials();
    await postScore(creds, score({ name: "最初", level: 10 }));
    const before = await dbRow(creds.playerId);

    const res = await postScore(creds, score({ name: "二回目", level: 12, ticks: 400 }));
    expectError(res, 429, "too many requests");
    // 直後なので残りはほぼ20秒。切り上げて20になる
    expect(res.headers.get("retry-after")).toBe("20");

    expect(await dbRow(creds.playerId)).toEqual(before);
  });

  it("Retry-Afterは残りの待ち時間を切り上げた秒数になる", async () => {
    const creds = newCredentials();
    await postScore(creds);
    // 4.5秒前に送信したことにする（残りは15.5秒より少しだけ短い。切り上げなら16、切り捨てなら15）
    await ageUpdatedAt(creds.playerId, 4_500);

    const res = await postScore(creds);
    expectError(res, 429, "too many requests");
    expect(res.headers.get("retry-after")).toBe("16");
  });

  it("間隔の境界は20秒ちょうど（19秒では429、20秒なら受け付ける）", async () => {
    const creds = newCredentials();
    await postScore(creds);

    // 19秒前の送信は、まだ1秒足りない
    await ageUpdatedAt(creds.playerId, 19_000);
    const early = await postScore(creds);
    expectError(early, 429, "too many requests");
    expect(early.headers.get("retry-after")).toBe("1");

    // ここからさらに1秒進めて、ちょうど20秒前にすると受け付ける
    await ageUpdatedAt(creds.playerId, 1_000);
    expect((await postScore(creds)).status).toBe(200);
  });

  it("20秒たてば再び送れる", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await ageUpdatedAt(creds.playerId, 20_000);
    expect((await postScore(creds)).status).toBe(200);
    // 受理した直後はまた429
    expect((await postScore(creds)).status).toBe(429);
  });

  it("検証や不正対策で断った送信は間隔を延ばさない", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await ageUpdatedAt(creds.playerId);
    const before = await dbRow(creds.playerId);

    expect((await postScore(creds, score({ name: "" }))).status).toBe(400);
    expect((await postScore(creds, score({ level: 99, ticks: 0 }))).status).toBe(422);
    expect((await postScore({ playerId: creds.playerId, token: newToken() })).status).toBe(403);
    expect(await dbRow(creds.playerId)).toEqual(before);

    expect((await postScore(creds)).status).toBe(200);
  });
});

// このテスト環境ではPromise.allの5リクエストが実質的に順番に処理され、2件目以降は普通の403/429の経路を通る。
// そのため「並べて送っても結果が矛盾しない」ことだけを確かめる。
// 書き込みの直前に相手の書き込みが入る本当の競合は、race.spec.tsで順序を決めて起こしている。
describe("POST /v1/scoresを並べて送っても結果が矛盾しない", () => {
  it("同じplayerIdの初回登録を並べて送っても、受理は1つだけでトークンは勝者のものになる", async () => {
    const playerId = newPlayerId();
    const contenders = Array.from({ length: 5 }, () => ({ playerId, token: newToken() }));
    const results = await Promise.all(contenders.map((creds) => postScore(creds)));

    const winners = contenders.filter((_, index) => results[index]?.status === 200);
    expect(winners).toHaveLength(1);
    for (const [index, res] of results.entries()) {
      if (res.status !== 200) expectError(res, 403, "invalid token");
      else expect(contenders[index]).toBe(winners[0]);
    }
    expect(await dbCount()).toBe(1);
    expect((await dbRow(playerId))?.token_hash).toBe(await sha256Hex(winners[0]?.token ?? ""));
  });

  it("同じトークンの初回登録を並べて送っても、受理は1回だけで残りは429になる", async () => {
    const creds = newCredentials();
    const results = await Promise.all(Array.from({ length: 5 }, () => postScore(creds)));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    for (const res of results) {
      if (res.status !== 200) expectError(res, 429, "too many requests");
    }
    expect(await dbCount()).toBe(1);
  });

  it("送信間隔を過ぎた更新を並べて送っても、受理は1回だけ", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await ageUpdatedAt(creds.playerId);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postScore(creds, score({ name: `n${i}`, level: 10 + i, ticks: 400 }))),
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    for (const res of results) {
      if (res.status !== 200) expectError(res, 429, "too many requests");
    }
  });
});

/** 検証を通る標準の本文に、1つだけ手を加えた本文を作る。 */
function payload(change: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { ...newCredentials(), ...score() };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

describe("POST /v1/scoresの入力検証(400)", () => {
  const badValues: [string, Record<string, unknown>][] = [
    // playerId
    ["playerIdがない", { playerId: undefined }],
    ["playerIdがnull", { playerId: null }],
    ["playerIdが数値", { playerId: 123 }],
    ["playerIdが大文字のUUID", { playerId: crypto.randomUUID().toUpperCase() }],
    ["playerIdがUUID v1", { playerId: "123e4567-e89b-12d3-a456-426614174000" }],
    ["playerIdのバリアントが不正", { playerId: "123e4567-e89b-42d3-c456-426614174000" }],
    ["playerIdがUUIDでない", { playerId: "not-a-uuid" }],
    ["playerIdの前後に空白", { playerId: ` ${crypto.randomUUID()} ` }],
    ["playerIdがハイフンなし", { playerId: crypto.randomUUID().replaceAll("-", "") }],
    // token
    ["tokenがない", { token: undefined }],
    ["tokenが31文字", { token: "a".repeat(31) }],
    ["tokenが129文字", { token: "a".repeat(129) }],
    ["tokenに使えない文字(+)", { token: `${"a".repeat(31)}+` }],
    ["tokenに空白", { token: `${"a".repeat(31)} ` }],
    ["tokenに日本語", { token: `${"a".repeat(31)}あ` }],
    ["tokenが数値", { token: 12345678901234567890123456789012 }],
    // name
    ["nameがない", { name: undefined }],
    ["nameが数値", { name: 123 }],
    ["nameがnull", { name: null }],
    ["nameが空", { name: "" }],
    ["nameが空白だけ", { name: "   " }],
    ["nameが改行とタブだけ", { name: "\n\t" }],
    ["nameが13コードポイント", { name: "あ".repeat(13) }],
    ["nameにNUL(Cc)", { name: "a\u0000b" }],
    ["nameにDEL(Cc)", { name: "a\u007fb" }],
    ["nameにNEL(Cc)", { name: "a\u0085b" }],
    ["nameにゼロ幅スペース(Cf)", { name: "a​b" }],
    ["nameに右から左への上書き(Cf)", { name: "‮abc" }],
    ["nameにゼロ幅接合子(Cf)", { name: "👨‍👩" }],
    ["nameに対になっていないサロゲート", { name: "a\ud800b" }],
    // 数値
    ["levelが0", { level: 0 }],
    ["levelが負", { level: -1 }],
    ["levelが小数", { level: 1.5 }],
    ["levelが文字列", { level: "10" }],
    ["levelがnull", { level: null }],
    ["levelがない", { level: undefined }],
    ["levelが安全な整数を超える", { level: Number.MAX_SAFE_INTEGER + 1 }],
    ["deepestが0", { deepest: 0 }],
    ["deepestが負", { deepest: -5 }],
    ["deepestが小数", { deepest: 2.5 }],
    ["deepestがない", { deepest: undefined }],
    ["totalExpが負", { totalExp: -1 }],
    ["totalExpが小数", { totalExp: 0.1 }],
    ["totalExpが文字列", { totalExp: "500" }],
    ["totalExpがない", { totalExp: undefined }],
    ["totalExpが安全な整数を超える", { totalExp: 2 ** 53 }],
    ["killsが負", { kills: -1 }],
    ["killsが小数", { kills: 1.1 }],
    ["killsが真偽値", { kills: true }],
    ["killsがない", { kills: undefined }],
    ["ticksが負", { ticks: -1 }],
    ["ticksが小数", { ticks: 99.5 }],
    ["ticksがない", { ticks: undefined }],
  ];

  it.each(badValues)("%s → 400", async (_label, change) => {
    const res = await sendJson("POST", "/v1/scores", payload(change));
    expect(res.status).toBe(400);
    expectError(res, 400);
    expect(await dbCount()).toBe(0);
  });

  it("理由はどのフィールドが不正かを示す", async () => {
    expectError(await sendJson("POST", "/v1/scores", payload({ playerId: "x" })), 400, "invalid playerId");
    expectError(await sendJson("POST", "/v1/scores", payload({ token: "x" })), 400, "invalid token");
    expectError(await sendJson("POST", "/v1/scores", payload({ name: "" })), 400, "invalid name");
    expectError(await sendJson("POST", "/v1/scores", payload({ level: 0 })), 400, "invalid level");
    expectError(await sendJson("POST", "/v1/scores", payload({ totalExp: -1 })), 400, "invalid totalExp");
  });

  const badBodies: [string, string][] = [
    ["空のボディ", ""],
    ["壊れたJSON", "{"],
    ["JSONでない文字列", "not json"],
    ["配列", "[]"],
    ["null", "null"],
    ["数値", "123"],
    ["文字列", '"str"'],
    ["オーバーフローする数値(1e999)", `{"playerId":"${crypto.randomUUID()}","token":"${"a".repeat(32)}","name":"x","level":1e999,"deepest":1,"totalExp":0,"kills":0,"ticks":0}`],
  ];

  it.each(badBodies)("本文が%s → 400", async (_label, raw) => {
    expectError(await sendRaw("POST", "/v1/scores", raw), 400);
  });

  it("不正なUTF-8の本文は400", async () => {
    const res = await call("/v1/scores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expectError(res, 400, "invalid json");
  });

  it("先頭にBOMが付いたUTF-8のJSONは受け付ける", async () => {
    const text = JSON.stringify({ ...newCredentials(), ...score() });
    const res = await call("/v1/scores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]),
    });
    expect(res.status).toBe(200);
  });

  /** 本文がちょうどbytesバイトになるよう、無視されるフィールドで詰める。 */
  function bodyOfSize(bytes: number): string {
    const base = { ...newCredentials(), ...score(), pad: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    base.pad = "x".repeat(bytes - overhead);
    const text = JSON.stringify(base);
    expect(new TextEncoder().encode(text).byteLength).toBe(bytes);
    return text;
  }

  it("本文が4096バイトちょうどなら受け付け、4097バイトなら400", async () => {
    expect((await sendRaw("POST", "/v1/scores", bodyOfSize(4096))).status).toBe(200);
    expectError(await sendRaw("POST", "/v1/scores", bodyOfSize(4097)), 400, "body too large");
  });

  // 読み取りを途中でやめるため、workerdが「pipe was aborted」とstderrに出すが想定どおりの動作
  it("Content-Lengthが無いストリームでも、4096バイトを超えた時点で400にする", async () => {
    const chunk = new TextEncoder().encode(`{"pad":"${"x".repeat(2000)}`);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent <= 4) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await call("/v1/scores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expectError(res, 400, "body too large");
    // 上限を超えた時点で読み取りをやめている（最後まで読んでいない）
    expect(sent).toBeLessThan(5);
  });

  it("検証エラーは不正対策(422)より先に判定する", async () => {
    // levelは不正対策でも断られる値だが、nameが不正なので400
    expectError(await sendJson("POST", "/v1/scores", payload({ name: "", level: 99, ticks: 0 })), 400);
  });
});

describe("POST /v1/scoresの不正対策(422)", () => {
  // [説明、ticks、level、deepest、kills、期待するステータス]
  const rows: [string, number, number, number, number, number][] = [
    ["levelの上限(ticks=0)", 0, 20, 1, 0, 200],
    ["levelが上限+1(ticks=0)", 0, 21, 1, 0, 422],
    ["levelの上限(ticks=7)", 7, 20, 1, 0, 200],
    ["levelが上限+1(ticks=7)", 7, 21, 1, 0, 422],
    ["levelの上限(ticks=8)", 8, 21, 1, 0, 200],
    ["levelが上限+1(ticks=8)", 8, 22, 1, 0, 422],
    ["levelの上限(ticks=15)", 15, 21, 1, 0, 200],
    ["levelの上限(ticks=16)", 16, 22, 1, 0, 200],
    ["levelが上限+1(ticks=16)", 16, 23, 1, 0, 422],
    ["deepestの上限(ticks=3)", 3, 1, 20, 0, 200],
    ["deepestが上限+1(ticks=3)", 3, 1, 21, 0, 422],
    ["deepestの上限(ticks=4)", 4, 1, 21, 0, 200],
    ["deepestが上限+1(ticks=4)", 4, 1, 22, 0, 422],
    ["deepestの上限(ticks=7)", 7, 1, 21, 0, 200],
    ["deepestの上限(ticks=8)", 8, 1, 22, 0, 200],
    ["deepestが上限+1(ticks=8)", 8, 1, 23, 0, 422],
    ["killsがticksと同じ", 10, 1, 1, 10, 200],
    ["killsがticks+1", 10, 1, 1, 11, 422],
    ["ticks=0でkills=1", 0, 1, 1, 1, 422],
    ["ticks=0でkills=0", 0, 1, 1, 0, 200],
  ];
  const cases = rows.map(([label, ticks, level, deepest, kills, status]) => ({ label, ticks, level, deepest, kills, status }));

  it.each(cases)("$label → $status", async ({ ticks, level, deepest, kills, status }) => {
    const creds = newCredentials();
    const res = await postScore(creds, score({ ticks, level, deepest, kills }));
    expect(res.status).toBe(status);
    if (status === 422) {
      expectError(res, 422);
      // 断った送信では登録されない
      expect(await dbRow(creds.playerId)).toBeNull();
    }
  });

  it("理由はどの指標が不自然かを示す", async () => {
    expectError(await postScore(newCredentials(), score({ ticks: 0, level: 21, deepest: 1, kills: 0 })), 422, "implausible level");
    expectError(await postScore(newCredentials(), score({ ticks: 0, level: 1, deepest: 21, kills: 0 })), 422, "implausible deepest");
    expectError(await postScore(newCredentials(), score({ ticks: 0, level: 1, deepest: 1, kills: 1 })), 422, "implausible kills");
  });

  it("既存プレイヤーの不自然な送信は断り、保存済みの値を変えない", async () => {
    const creds = newCredentials();
    await postScore(creds);
    const before = await dbRow(creds.playerId);
    await ageUpdatedAt(creds.playerId);
    const aged = await dbRow(creds.playerId);

    expectError(await postScore(creds, score({ level: 500, ticks: 8 })), 422);
    expect(await dbRow(creds.playerId)).toEqual(aged);
    expect(aged?.level).toBe(before?.level);
  });
});

describe("POST/DELETE /v1/scoresのContent-Type(415)", () => {
  const wrongTypes = ["text/plain", "application/x-www-form-urlencoded", "text/json", "application/jsonp", "application/octet-stream"];

  it.each(wrongTypes)("POSTのContent-Typeが%sなら415", async (contentType) => {
    const body = JSON.stringify({ ...newCredentials(), ...score() });
    expectError(await sendRaw("POST", "/v1/scores", body, contentType), 415, "unsupported media type");
    expect(await dbCount()).toBe(0);
  });

  it.each(wrongTypes)("DELETEのContent-Typeが%sなら415", async (contentType) => {
    const body = JSON.stringify(newCredentials());
    expectError(await sendRaw("DELETE", "/v1/scores", body, contentType), 415, "unsupported media type");
  });

  it("Content-Typeが無ければ415", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ...newCredentials(), ...score() }));
    expectError(await call("/v1/scores", { method: "POST", body }), 415);
    expectError(await call("/v1/scores", { method: "DELETE", body }), 415);
  });

  it("本文が不正でもContent-Typeの判定が先で415", async () => {
    expectError(await sendRaw("POST", "/v1/scores", "not json", "text/plain"), 415);
  });

  it("application/jsonならパラメータや大文字小文字が違っても受け付ける", async () => {
    for (const contentType of ["application/json; charset=utf-8", "Application/JSON", "application/json;charset=UTF-8", " application/json "]) {
      const body = JSON.stringify({ ...newCredentials(), ...score() });
      const res = await sendRaw("POST", "/v1/scores", body, contentType);
      expect(res.status, contentType).toBe(200);
    }
  });
});

describe("DELETE /v1/scores", () => {
  it("トークンが合えば削除して200を返し、ランキングからも消える", async () => {
    const creds = newCredentials();
    const other = newCredentials();
    await postScore(creds, score({ name: "去る人", level: 20, ticks: 200 }));
    await postScore(other, score({ name: "残る人", level: 10 }));

    const res = await deleteScore(creds);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body).toEqual({ ok: true });

    expect(await dbRow(creds.playerId)).toBeNull();
    expect(await dbRow(other.playerId)).not.toBeNull();
    const board = await leaderboard(`?me=${creds.playerId}`);
    expect(board.body.players).toBe(1);
    expect(board.body.me).toBeNull();
    expect(board.body.entries.map((e: { name: string }) => e.name)).toEqual(["残る人"]);
  });

  it("削除したあとは、同じplayerIdを別のトークンで登録し直せる（送信間隔も残らない）", async () => {
    const creds = newCredentials();
    await postScore(creds);
    await deleteScore(creds);

    const again = { playerId: creds.playerId, token: newToken() };
    const res = await postScore(again, score({ name: "出直し", level: 2, deepest: 2, kills: 0, ticks: 0 }));
    expect(res.status).toBe(200);
    expect((await dbRow(creds.playerId))?.token_hash).toBe(await sha256Hex(again.token));
    // 古いトークンはもう使えない
    await ageUpdatedAt(creds.playerId);
    expectError(await postScore(creds), 403);
  });

  it("トークンが違えば403で、行は残る", async () => {
    const creds = newCredentials();
    await postScore(creds);
    const res = await deleteScore({ playerId: creds.playerId, token: newToken() });
    expectError(res, 403, "invalid token");
    expect(await dbRow(creds.playerId)).not.toBeNull();
  });

  it("登録のないplayerIdは404", async () => {
    expectError(await deleteScore(newCredentials()), 404, "player not found");
  });

  it("二度目の削除は404", async () => {
    const creds = newCredentials();
    await postScore(creds);
    expect((await deleteScore(creds)).status).toBe(200);
    expectError(await deleteScore(creds), 404);
  });

  it("他のプレイヤーの行は消さない", async () => {
    const creds = newCredentials();
    await seed([{}, {}, {}]);
    await postScore(creds);
    await deleteScore(creds);
    expect(await dbCount()).toBe(3);
  });

  const badDeletes: [string, Record<string, unknown>][] = [
    ["playerIdがない", { token: "a".repeat(32) }],
    ["tokenがない", { playerId: crypto.randomUUID() }],
    ["playerIdがUUIDでない", { playerId: "x", token: "a".repeat(32) }],
    ["playerIdが大文字", { playerId: crypto.randomUUID().toUpperCase(), token: "a".repeat(32) }],
    ["tokenが短い", { playerId: crypto.randomUUID(), token: "short" }],
    ["tokenに使えない文字", { playerId: crypto.randomUUID(), token: `${"a".repeat(31)}!` }],
    ["空のオブジェクト", {}],
  ];

  it.each(badDeletes)("%s → 400", async (_label, body) => {
    expectError(await sendJson("DELETE", "/v1/scores", body), 400);
  });

  it("本文が壊れたJSON・配列・空なら400", async () => {
    expectError(await sendRaw("DELETE", "/v1/scores", "{"), 400);
    expectError(await sendRaw("DELETE", "/v1/scores", "[]"), 400);
    expectError(await sendRaw("DELETE", "/v1/scores", ""), 400);
  });
});

describe("応答の秘密情報", () => {
  it("どの応答にもplayerIdやトークン、そのハッシュが含まれない", async () => {
    const creds = newCredentials();
    const stranger = newCredentials();
    await postScore(creds); // 200（新規）
    await postScore(creds); // 429
    await postScore({ playerId: creds.playerId, token: newToken() }); // 403
    await postScore(stranger, score({ name: "" })); // 400
    await postScore(stranger, score({ level: 99, ticks: 0 })); // 422
    await sendRaw("POST", "/v1/scores", "x", "text/plain"); // 415
    await ageUpdatedAt(creds.playerId);
    await postScore(creds); // 200（更新）
    await leaderboard(`?me=${creds.playerId}`);
    await leaderboard("?by=exp&limit=50");
    await leaderboard("?me=bad"); // 400
    await call("/v1/nothing"); // 404
    await call("/v1/scores"); // 405
    await deleteScore({ playerId: creds.playerId, token: newToken() }); // 403
    await deleteScore(creds); // 200
    await deleteScore(creds); // 404
    assertNoLeaksInSeenBodies();
  });

  it("SQLの記号を含む名前は文字として保存し、そのまま返す", async () => {
    const creds = newCredentials();
    const name = "a'); DROP--";
    expect((await postScore(creds, score({ name }))).status).toBe(200);
    expect((await dbRow(creds.playerId))?.name).toBe(name);
    const board = await leaderboard();
    expect(board.body.entries[0].name).toBe(name);
    expect(await dbCount()).toBe(1);
  });
});
