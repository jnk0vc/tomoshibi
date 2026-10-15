import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SQL, updatePlayerSql } from "../src/sql";
import { counterValue, setupPerTest } from "./helpers";

setupPerTest();

/** SQLの?の数だけダミー値を束ねて、EXPLAIN QUERY PLANのdetail列を返す。 */
async function plan(sql: string): Promise<string[]> {
  const placeholders = sql.split("?").length - 1;
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...Array.from({ length: placeholders }, () => 1))
    .all<{ detail: string }>();
  return result.results.map((row) => row.detail);
}

/**
 * 全件走査と一時ソートが無いことを確かめる。
 * 「SCAN」で始まる行はすべて断る。表の全件走査（SCAN players）だけでなく、
 * 範囲指定のないインデックスの全件走査（SCAN players USING COVERING INDEX ...）も含む。
 * 主キーやインデックスで絞る行は「SEARCH」と表示されるので、許可されるのはSEARCHだけになる。
 */
function expectNoFullScanOrSort(details: string[]): void {
  for (const detail of details) {
    expect(detail, "表やインデックスの全件走査").not.toMatch(/^SCAN /);
    expect(detail, "一時ソート").not.toMatch(/TEMP B-TREE/);
  }
}

/**
 * ORDER BY ... LIMITの問い合わせは、並びを満たすインデックスを先頭から順にたどって、LIMITで止まる。
 * プラン上は範囲指定のないSCANに見えるので、指定のインデックスを使う1行だけを許し、一時ソートが無いことを確かめる。
 * 実際に読む行数がLIMITで止まることは、rows-read.spec.tsで確かめる。
 */
function expectOrderedIndexScanOnly(details: string[], index: string): void {
  expect(details).toEqual([`SCAN players USING INDEX ${index}`]);
}

describe("スキーマ", () => {
  it("playersの列が仕様どおりで、idが主キー", async () => {
    const info = await env.DB.prepare("PRAGMA table_info(players)").all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>();
    const columns = Object.fromEntries(info.results.map((c) => [c.name, c]));
    expect(Object.keys(columns)).toEqual([
      "id",
      "token_hash",
      "name",
      "level",
      "deepest",
      "total_exp",
      "kills",
      "ticks",
      "created_at",
      "updated_at",
      "level_at",
      "deepest_at",
      "exp_at",
    ]);
    expect(columns.id).toMatchObject({ type: "TEXT", pk: 1 });
    expect(columns.token_hash).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(columns.name).toMatchObject({ type: "TEXT", notnull: 1 });
    const integerColumns = [
      "level",
      "deepest",
      "total_exp",
      "kills",
      "ticks",
      "created_at",
      "updated_at",
      "level_at",
      "deepest_at",
      "exp_at",
    ];
    for (const name of integerColumns) {
      expect(columns[name], name).toMatchObject({ type: "INTEGER", notnull: 1 });
    }
  });

  /** インデックスのキー列を、定義の順に、列名と並び方向（ASCかDESC）をつなげた文字列で返す（暗黙のrowidは含めない）。 */
  async function indexKeys(index: string): Promise<string[]> {
    const info = await env.DB.prepare(`PRAGMA index_xinfo(${index})`).all<{
      seqno: number;
      name: string | null;
      desc: number;
      key: number;
    }>();
    return info.results
      .filter((column) => column.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => `${column.name} ${column.desc === 1 ? "DESC" : "ASC"}`);
  }

  it("各ボード用のインデックスは「指標の降順、到達時刻の昇順」で、updated_atを含まない", async () => {
    expect(await indexKeys("idx_players_level")).toEqual(["level DESC", "level_at ASC"]);
    expect(await indexKeys("idx_players_deepest")).toEqual(["deepest DESC", "deepest_at ASC"]);
    expect(await indexKeys("idx_players_total_exp")).toEqual(["total_exp DESC", "exp_at ASC"]);

    // updated_atは送信間隔の判定にだけ使うので、どのインデックスにも入れない（入れると送信のたびに書き込みが増える）
    const list = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'players'").all<{
      name: string;
    }>();
    for (const { name } of list.results) {
      expect(await indexKeys(name), name).not.toContain("updated_at ASC");
    }
  });

  it("登録人数のカウンタは1行だけで、idは1に限る", async () => {
    const info = await env.DB.prepare("PRAGMA table_info(player_count)").all<{ name: string; pk: number }>();
    expect(info.results.map((column) => column.name)).toEqual(["id", "n"]);
    await expect(env.DB.prepare("INSERT INTO player_count (id, n) VALUES (2, 0)").run()).rejects.toThrow();
    expect(await counterValue()).toBe(0);
  });

  it("CHECK制約が範囲外の値を拒否する（アプリの検証をすり抜けた場合の最後の砦）", async () => {
    const insert = (level: number, deepest: number, totalExp: number) =>
      env.DB.prepare(
        "INSERT INTO players (id, token_hash, name, level, deepest, total_exp, kills, ticks, created_at, updated_at) " +
          "VALUES (?, 'h', 'n', ?, ?, ?, 0, 0, 0, 0)",
      )
        .bind(crypto.randomUUID(), level, deepest, totalExp)
        .run();
    await expect(insert(0, 1, 0)).rejects.toThrow();
    await expect(insert(1, 0, 0)).rejects.toThrow();
    await expect(insert(1, 1, -1)).rejects.toThrow();
    await expect(insert(1, 1, 0)).resolves.toBeDefined();
  });
});

describe("クエリプラン（順位集計と並び順がインデックス走査になる）", () => {
  const boards = [
    { by: "level", index: "idx_players_level", column: "level" },
    { by: "deepest", index: "idx_players_deepest", column: "deepest" },
    { by: "exp", index: "idx_players_total_exp", column: "total_exp" },
  ] as const;

  it.each(boards)("by=$byの上位N件は$indexを順にたどり、一時ソートをしない", async ({ by, index }) => {
    expectOrderedIndexScanOnly(await plan(SQL.leaderboard[by]), index);
  });

  it.each(boards)("by=$byの「自分」の順位集計は主キーの検索と$indexの範囲走査になる", async ({ by, index, column }) => {
    const details = await plan(SQL.me[by]);
    const text = details.join("\n");
    expect(text).toContain("USING INDEX sqlite_autoindex_players_1 (id=?)");
    expect(text).toContain(`SEARCH players USING COVERING INDEX ${index} (${column}>?)`);
    expectNoFullScanOrSort(details);
  });

  it("書き込み後の3ボードの順位集計は、それぞれのインデックスの範囲走査になる", async () => {
    const details = await plan(SQL.rankAll);
    const text = details.join("\n");
    expect(text).toContain("USING INDEX sqlite_autoindex_players_1 (id=?)");
    expect(text).toContain("SEARCH players USING COVERING INDEX idx_players_level (level>?)");
    expect(text).toContain("SEARCH players USING COVERING INDEX idx_players_deepest (deepest>?)");
    expect(text).toContain("SEARCH players USING COVERING INDEX idx_players_total_exp (total_exp>?)");
    expectNoFullScanOrSort(details);
  });

  it("登録人数の取得は、カウンタ行の主キー検索になる（playersは読まない）", async () => {
    const details = await plan(SQL.countPlayers);
    expect(details).toEqual(["SEARCH player_count USING INTEGER PRIMARY KEY (rowid=?)"]);
    expectNoFullScanOrSort(details);
  });

  it("認証情報の取得・更新（全8通り）・削除は主キーの検索になる", async () => {
    for (const sql of [SQL.selectPlayer, ...SQL.updatePlayer, SQL.deletePlayer]) {
      const details = await plan(sql);
      expect(details.join("\n"), sql).toContain("USING INDEX sqlite_autoindex_players_1 (id=?)");
      expectNoFullScanOrSort(details);
    }
  });

  it("全件走査の検出が働いている（範囲指定のないインデックス走査も断る）", async () => {
    // 検出の抜けを見つけるための確認。countPlayersを元の全件数えるSQLにすると検出されるはず
    const covering = await plan("SELECT COUNT(*) AS n FROM players");
    expect(covering.join("\n")).toMatch(/^SCAN players USING COVERING INDEX/);
    expect(() => expectNoFullScanOrSort(covering)).toThrow();
    expect(() => expectNoFullScanOrSort(["SCAN players"])).toThrow();
    expect(() => expectNoFullScanOrSort(["SCAN players USING INDEX idx_players_level"])).toThrow();
    expect(() => expectNoFullScanOrSort(["USE TEMP B-TREE FOR ORDER BY"])).toThrow();
    expect(() => expectNoFullScanOrSort(["SEARCH players USING INDEX idx_players_level (level>?)"])).not.toThrow();
  });
});

describe("更新SQLの選び方", () => {
  it("指標が伸びるボードの組み合わせごとに、SETへ入れる列が変わる", () => {
    const columns = (raised: { level: boolean; deepest: boolean; exp: boolean }) => {
      const sql = updatePlayerSql(raised);
      return ["level", "deepest", "total_exp"].filter((column) => sql.includes(`${column} = MAX(`));
    };
    expect(columns({ level: false, deepest: false, exp: false })).toEqual([]);
    expect(columns({ level: true, deepest: false, exp: false })).toEqual(["level"]);
    expect(columns({ level: false, deepest: true, exp: false })).toEqual(["deepest"]);
    expect(columns({ level: false, deepest: false, exp: true })).toEqual(["total_exp"]);
    expect(columns({ level: true, deepest: true, exp: true })).toEqual(["level", "deepest", "total_exp"]);
  });

  it("8通りのSQLはすべて異なり、updated_atは常に更新して、WHEREに送信間隔の条件が入る", () => {
    expect(new Set(SQL.updatePlayer).size).toBe(8);
    for (const sql of SQL.updatePlayer) {
      expect(sql).toContain("updated_at = ?");
      expect(sql).toMatch(/WHERE id = \? AND token_hash = \? AND updated_at <= \?$/);
    }
  });
});

describe("SQLの組み立て", () => {
  it("すべてのSQLは固定文字列で、値はプレースホルダ(?)で受ける", () => {
    const all = [
      SQL.selectPlayer,
      SQL.insertPlayer,
      ...SQL.updatePlayer,
      SQL.rankAll,
      SQL.deletePlayer,
      SQL.countPlayers,
      ...Object.values(SQL.leaderboard),
      ...Object.values(SQL.me),
    ];
    for (const sql of all) {
      // 値を直接埋め込むための引用符や、ユーザー入力を差し込む隙間が無い
      expect(sql).not.toMatch(/'|"|\$\{|;/);
    }
  });
});
