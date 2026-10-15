import { describe, expect, it } from "vitest";
import {
  ageUpdatedAt,
  call,
  deleteScore,
  expectError,
  leaderboard,
  newCredentials,
  postScore,
  score,
  seed,
  setReachTimes,
  setupPerTest,
  sha256Hex,
  type SeedRow,
} from "./helpers";

setupPerTest();

interface Entry {
  rank: number;
  name: string;
  level: number;
  deepest: number;
  totalExp: number;
  isYou: boolean;
}

const names = (entries: Entry[]) => entries.map((e) => e.name);
const ranks = (entries: Entry[]) => entries.map((e) => e.rank);

describe("GET /v1/leaderboardの形", () => {
  it("誰もいなければ空の配列とnullと0を返す", async () => {
    const res = await leaderboard();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body).toEqual({ by: "level", entries: [], me: null, players: 0 });
  });

  it("既定はby=level、limit=20で、各エントリのキーは契約どおり", async () => {
    await seed(Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, level: 100 - i })));
    const res = await leaderboard();

    expect(res.status).toBe(200);
    expect(res.body.by).toBe("level");
    expect(res.body.entries).toHaveLength(20);
    expect(res.body.players).toBe(25);
    expect(res.body.me).toBeNull();
    expect(Object.keys(res.body).sort()).toEqual(["by", "entries", "me", "players"]);
    for (const entry of res.body.entries) {
      expect(Object.keys(entry).sort()).toEqual(["deepest", "isYou", "level", "name", "rank", "totalExp"]);
      expect(entry.isYou).toBe(false);
    }
  });

  it("byはそのまま応答に返る", async () => {
    for (const by of ["level", "deepest", "exp"]) {
      expect((await leaderboard(`?by=${by}`)).body.by).toBe(by);
    }
  });

  it("meの形はrank、name、level、deepest、totalExpだけ", async () => {
    const [id] = await seed([{ name: "自分", level: 7, deepest: 8, totalExp: 9 }]);
    const res = await leaderboard(`?me=${id}`);
    expect(res.body.me).toEqual({ rank: 1, name: "自分", level: 7, deepest: 8, totalExp: 9 });
  });
});

describe("GET /v1/leaderboardの並び順", () => {
  const trio: SeedRow[] = [
    { name: "A", level: 30, deepest: 5, totalExp: 100 },
    { name: "B", level: 20, deepest: 50, totalExp: 300 },
    { name: "C", level: 10, deepest: 20, totalExp: 900 },
  ];

  it("by=levelはlevelの降順", async () => {
    await seed(trio);
    expect(names((await leaderboard("?by=level")).body.entries)).toEqual(["A", "B", "C"]);
  });

  it("by=deepestはdeepestの降順", async () => {
    await seed(trio);
    expect(names((await leaderboard("?by=deepest")).body.entries)).toEqual(["B", "C", "A"]);
  });

  it("by=expはtotalExpの降順", async () => {
    await seed(trio);
    expect(names((await leaderboard("?by=exp")).body.entries)).toEqual(["C", "B", "A"]);
  });

  it("同値のときは到達時刻の昇順、それも同じならrowidの昇順", async () => {
    await seed([
      { name: "遅い", level: 10, levelAt: 5000 },
      { name: "早い", level: 10, levelAt: 1000 },
      { name: "同時A", level: 10, levelAt: 3000 },
      { name: "同時B", level: 10, levelAt: 3000 },
      { name: "首位", level: 11, levelAt: 9000 },
    ]);
    const res = await leaderboard();
    expect(names(res.body.entries)).toEqual(["首位", "早い", "同時A", "同時B", "遅い"]);
    expect(ranks(res.body.entries)).toEqual([1, 2, 2, 2, 2]);
  });

  it("最終送信時刻(updated_at)は並びに使わない", async () => {
    // 到達は「先」が早いが、最後に送信したのも「先」のほうが新しい
    await seed([
      { name: "先", level: 10, levelAt: 1000, updatedAt: 90_000 },
      { name: "後", level: 10, levelAt: 2000, updatedAt: 3_000 },
    ]);
    expect(names((await leaderboard()).body.entries)).toEqual(["先", "後"]);
  });

  it("同値の並びはボードごとに、そのボードの到達時刻で決まる", async () => {
    await seed([
      { name: "X", level: 5, deepest: 9, totalExp: 1, levelAt: 300, deepestAt: 300, expAt: 300 },
      { name: "Y", level: 5, deepest: 9, totalExp: 2, levelAt: 100, deepestAt: 400, expAt: 100 },
      { name: "Z", level: 6, deepest: 8, totalExp: 2, levelAt: 200, deepestAt: 200, expAt: 200 },
    ]);
    // levelは6のZが先頭で、5同士はYのほうが早い
    expect(names((await leaderboard("?by=level")).body.entries)).toEqual(["Z", "Y", "X"]);
    // deepestは9同士で、Xのほうが早い（level側ではYが早いのと逆になる）。8のZは最後
    expect(names((await leaderboard("?by=deepest")).body.entries)).toEqual(["X", "Y", "Z"]);
    // expは2同士で、Yのほうが早い。1のXは最後
    expect(names((await leaderboard("?by=exp")).body.entries)).toEqual(["Y", "Z", "X"]);
  });

  it("APIで登録した順にも、同値なら先に登録した人が上になる", async () => {
    const first = newCredentials();
    const second = newCredentials();
    const third = newCredentials();
    await postScore(first, score({ name: "一番手", level: 10 }));
    await postScore(second, score({ name: "二番手", level: 10 }));
    await postScore(third, score({ name: "三番手", level: 10 }));
    const res = await leaderboard();
    expect(names(res.body.entries)).toEqual(["一番手", "二番手", "三番手"]);
  });

  it("更新後の値で並び替わる", async () => {
    const low = newCredentials();
    const high = newCredentials();
    await postScore(low, score({ name: "低い", level: 5, ticks: 100 }));
    await postScore(high, score({ name: "高い", level: 8, ticks: 100 }));
    expect(names((await leaderboard()).body.entries)).toEqual(["高い", "低い"]);

    await ageUpdatedAt(low.playerId);
    await postScore(low, score({ name: "低い", level: 9, ticks: 100 }));
    expect(names((await leaderboard()).body.entries)).toEqual(["低い", "高い"]);
  });
});

describe("GET /v1/leaderboardの同値の並びは、送信を続けても動かない", () => {
  /** idとトークンが分かる行を作る（送信できる行にするため、トークンのハッシュを入れる）。 */
  async function seedPlayer(row: SeedRow) {
    const creds = newCredentials();
    await seed([{ ...row, id: creds.playerId, tokenHash: await sha256Hex(creds.token) }]);
    return { creds };
  }

  it("同値の人が指標を変えずに再送信しても、そのボードの並びは変わらない", async () => {
    const first = newCredentials();
    const second = newCredentials();
    const same = score({ level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 });
    await postScore(first, { ...same, name: "先着" });
    await postScore(second, { ...same, name: "後着" });
    // 到達時刻を決まった値にする。先着が先で、後着が後
    await setReachTimes(first.playerId, { levelAt: 1_000, deepestAt: 1_000, expAt: 1_000 });
    await setReachTimes(second.playerId, { levelAt: 2_000, deepestAt: 2_000, expAt: 2_000 });
    expect(names((await leaderboard("?by=level")).body.entries)).toEqual(["先着", "後着"]);

    // 先着は、levelとdeepestを変えないまま、expとkillsとticksだけ増やして送信を続ける（後着は放置）
    for (let i = 1; i <= 3; i++) {
      await ageUpdatedAt(first.playerId);
      const res = await postScore(first, { ...same, name: "先着", totalExp: 500 + i, kills: 40 + i, ticks: 100 + i });
      expect(res.status).toBe(200);
    }

    // level（とdeepest）では先着のほうが上のまま。updated_atで並べていると、ここで入れ替わる
    expect(names((await leaderboard("?by=level")).body.entries)).toEqual(["先着", "後着"]);
    expect(names((await leaderboard("?by=deepest")).body.entries)).toEqual(["先着", "後着"]);
    expect(ranks((await leaderboard("?by=level")).body.entries)).toEqual([1, 1]);
  });

  it("後着の人が指標を変えずに再送信し続けても、先着を追い越さない", async () => {
    const first = newCredentials();
    const second = newCredentials();
    const same = score({ level: 10, deepest: 12, totalExp: 500, kills: 40, ticks: 100 });
    await postScore(first, { ...same, name: "先着" });
    await postScore(second, { ...same, name: "後着" });
    await setReachTimes(first.playerId, { levelAt: 2_000 });
    await setReachTimes(second.playerId, { levelAt: 1_000 });
    // 先着のほうが到達時刻が遅くなるよう入れ替えてある。送信しなかった側が上
    expect(names((await leaderboard()).body.entries)).toEqual(["後着", "先着"]);

    await ageUpdatedAt(first.playerId);
    await postScore(first, { ...same, name: "先着" });
    expect(names((await leaderboard()).body.entries)).toEqual(["後着", "先着"]);
  });

  it("指標が上がった人は、そのボードの同値グループで後ろにつく", async () => {
    // A: level 10, B: level 11(2000に到達), C: level 11(3000に到達)。deepestは3人とも5で、A、B、Cの順に到達
    const a = await seedPlayer({ name: "A", level: 10, deepest: 5, levelAt: 1_000, deepestAt: 1_000 });
    await seed([
      { name: "B", level: 11, deepest: 5, levelAt: 2_000, deepestAt: 2_000 },
      { name: "C", level: 11, deepest: 5, levelAt: 3_000, deepestAt: 3_000 },
    ]);
    expect(names((await leaderboard("?by=level")).body.entries)).toEqual(["B", "C", "A"]);

    // Aがlevelを11に伸ばす。levelの同値グループ(11)には最後に入るので、BとCの後ろ
    await ageUpdatedAt(a.creds.playerId);
    const res = await postScore(a.creds, score({ name: "A", level: 11, deepest: 5, totalExp: 0, kills: 0, ticks: 100 }));
    expect(res.status).toBe(200);

    const level = await leaderboard("?by=level");
    expect(names(level.body.entries)).toEqual(["B", "C", "A"]);
    expect(ranks(level.body.entries)).toEqual([1, 1, 1]);
    // levelだけが伸びたので、deepestボードの並びは変わらない（Aは最初に5へ到達したまま先頭）
    expect(names((await leaderboard("?by=deepest")).body.entries)).toEqual(["A", "B", "C"]);
  });

  it("指標が上がってグループを抜けた人は、新しい値のグループの末尾から数える", async () => {
    // Xは先に10へ到達。Yは10の後で11に到達。Xが11に上がると、11の中ではYの後ろ
    const x = await seedPlayer({ name: "X", level: 10, levelAt: 1_000 });
    await seed([{ name: "Y", level: 11, levelAt: 5_000 }]);
    await ageUpdatedAt(x.creds.playerId);
    await postScore(x.creds, score({ name: "X", level: 11, deepest: 1, totalExp: 0, kills: 0, ticks: 100 }));
    expect(names((await leaderboard()).body.entries)).toEqual(["Y", "X"]);
  });
});

describe("GET /v1/leaderboardの順位（標準競技順位）", () => {
  const boards = [
    { by: "level", key: "level" },
    { by: "deepest", key: "deepest" },
    { by: "exp", key: "totalExp" },
  ] as const;

  // 1位, 2位(2人), 4位(3人), 7位 の形
  const pattern = [50, 40, 40, 30, 30, 30, 20];
  const expected = [1, 2, 2, 4, 4, 4, 7];

  it.each(boards)("by=$byの同値は同じ順位で、次の順位は人数分だけ飛ぶ", async ({ by, key }) => {
    await seed(pattern.map((value, index) => ({ name: `p${index}`, [key]: value })));
    const res = await leaderboard(`?by=${by}`);
    expect(ranks(res.body.entries)).toEqual(expected);
  });

  it("limitで打ち切っても、順位は全体の中での順位のまま", async () => {
    await seed([5, 5, 5, 4].map((level, index) => ({ name: `p${index}`, level })));
    const res = await leaderboard("?limit=2");
    expect(ranks(res.body.entries)).toEqual([1, 1]);
    expect(res.body.players).toBe(4);
  });

  it("limitで同順位の途中を切ると、後ろの人は次の順位に繰り上がらない", async () => {
    await seed([9, 8, 8, 8, 7].map((level, index) => ({ name: `p${index}`, level })));
    expect(ranks((await leaderboard("?limit=3")).body.entries)).toEqual([1, 2, 2]);
    expect(ranks((await leaderboard("?limit=5")).body.entries)).toEqual([1, 2, 2, 2, 5]);
  });
});

describe("GET /v1/leaderboard limit", () => {
  it("limitの件数だけ返し、最大50件まで", async () => {
    await seed(Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, level: 1000 - i })));
    expect((await leaderboard("?limit=1")).body.entries).toHaveLength(1);
    expect((await leaderboard("?limit=7")).body.entries).toHaveLength(7);
    expect((await leaderboard("?limit=50")).body.entries).toHaveLength(50);
    expect((await leaderboard("?limit=50")).body.players).toBe(60);
    // 既定は20件
    expect((await leaderboard()).body.entries).toHaveLength(20);
  });

  it("人数がlimitより少なければ全員を返す", async () => {
    await seed([{}, {}, {}]);
    expect((await leaderboard("?limit=50")).body.entries).toHaveLength(3);
  });

  it("先頭にゼロが付いた数字も受け付ける", async () => {
    await seed(Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, level: 100 - i })));
    expect((await leaderboard("?limit=05")).body.entries).toHaveLength(5);
  });
});

describe("GET /v1/leaderboard me", () => {
  async function seedLadder(count: number) {
    // levelがすべて異なるcount人。ids[0]が1位
    return seed(Array.from({ length: count }, (_, i) => ({ name: `p${i}`, level: 1000 - i, deepest: 1 + i, totalExp: i })));
  }

  it("上位Nの外にいても、自分の順位と成績を返す", async () => {
    const ids = await seedLadder(30);
    const res = await leaderboard(`?limit=5&me=${ids[29]}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(5);
    expect(res.body.entries.every((e: Entry) => e.isYou === false)).toBe(true);
    expect(res.body.me).toEqual({ rank: 30, name: "p29", level: 971, deepest: 30, totalExp: 29 });
    expect(res.body.players).toBe(30);
  });

  it("上位Nの中にいれば、isYouが立ち、meにも同じ順位が入る", async () => {
    const ids = await seedLadder(10);
    const res = await leaderboard(`?limit=5&me=${ids[2]}`);

    const flags = res.body.entries.map((e: Entry) => e.isYou);
    expect(flags).toEqual([false, false, true, false, false]);
    expect(res.body.me.rank).toBe(3);
    expect(res.body.me.name).toBe("p2");
  });

  it("meの順位は選んだボードのもの", async () => {
    const ids = await seedLadder(10);
    // ids[0]はlevelでは1位、deepestでは10位、expでは10位
    expect((await leaderboard(`?by=level&me=${ids[0]}`)).body.me.rank).toBe(1);
    expect((await leaderboard(`?by=deepest&me=${ids[0]}`)).body.me.rank).toBe(10);
    expect((await leaderboard(`?by=exp&me=${ids[0]}`)).body.me.rank).toBe(10);
  });

  it("同値の人が複数いれば、meも同じ順位を共有する", async () => {
    const ids = await seed([{ level: 10 }, { level: 10 }, { level: 10 }, { level: 5 }]);
    expect((await leaderboard(`?me=${ids[0]}`)).body.me.rank).toBe(1);
    expect((await leaderboard(`?me=${ids[2]}`)).body.me.rank).toBe(1);
    expect((await leaderboard(`?me=${ids[3]}`)).body.me.rank).toBe(4);
  });

  it("登録のないplayerIdを渡すとmeはnullで、entriesはそのまま", async () => {
    await seedLadder(3);
    const res = await leaderboard(`?me=${crypto.randomUUID()}`);
    expect(res.status).toBe(200);
    expect(res.body.me).toBeNull();
    expect(res.body.entries).toHaveLength(3);
  });

  it("meを付けなければmeはnull", async () => {
    await seedLadder(3);
    expect((await leaderboard()).body.me).toBeNull();
  });

  it("APIで登録した本人の順位が取れ、脱退するとnullに戻る", async () => {
    const mine = newCredentials();
    await seed([{ level: 50 }, { level: 40 }]);
    await postScore(mine, score({ name: "わたし", level: 20, ticks: 100 }));

    const res = await leaderboard(`?limit=1&me=${mine.playerId}`);
    expect(res.body.me).toMatchObject({ rank: 3, name: "わたし", level: 20 });
    expect(res.body.entries[0].isYou).toBe(false);

    await deleteScore(mine);
    expect((await leaderboard(`?me=${mine.playerId}`)).body.me).toBeNull();
  });
});

describe("GET /v1/leaderboardの入力検証(400)", () => {
  const badQueries = [
    "?by=score",
    "?by=",
    "?by=LEVEL",
    "?by=level&by=exp",
    "?by=level%20",
    "?limit=0",
    "?limit=51",
    "?limit=-1",
    "?limit=abc",
    "?limit=1.5",
    "?limit=",
    "?limit=%2B5",
    "?limit=1e1",
    "?limit=5&limit=6",
    "?limit=99999999999999999999999999",
    "?me=",
    "?me=not-a-uuid",
    `?me=${crypto.randomUUID().toUpperCase()}`,
    "?me=123e4567-e89b-12d3-a456-426614174000",
    `?me=${crypto.randomUUID()}&me=${crypto.randomUUID()}`,
    "?me=%27%20OR%201%3D1%20--",
  ];

  it.each(badQueries)("%s → 400", async (query) => {
    expectError(await leaderboard(query), 400);
  });

  it("理由はどのパラメータが不正かを示す", async () => {
    expectError(await leaderboard("?by=x"), 400, "invalid by");
    expectError(await leaderboard("?limit=0"), 400, "invalid limit");
    expectError(await leaderboard("?me=x"), 400, "invalid me");
  });

  it("知らないパラメータは無視する", async () => {
    expect((await leaderboard("?foo=bar&by=exp&limit=1")).status).toBe(200);
  });

  it("全パラメータが正しければ200", async () => {
    const [id] = await seed([{}]);
    expect((await leaderboard(`?by=exp&limit=50&me=${id}`)).status).toBe(200);
  });

  it("不正な指定は他の要因によらず、データがあっても400", async () => {
    await seed([{}, {}]);
    expectError(await call("/v1/leaderboard?by=bogus"), 400);
  });
});
