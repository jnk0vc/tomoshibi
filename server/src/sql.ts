/**
 * D1に投げるSQLをここにまとめる。
 * 文は固定文字列で、値はすべてbind()で渡す（入力から文字列連結でSQLを組み立てない）。
 * updatePlayerだけは、固定の断片をモジュールの読み込み時につなげた8本を持つ。
 * テストがこの定数をそのままEXPLAIN QUERY PLANに通し、全件走査になっていないことを確かめる。
 *
 * 列の使い分け:
 * - updated_at: 最後に受理した送信の時刻。送信間隔(20秒)の判定にだけ使い、インデックスには入れない。
 * - level_at / deepest_at / exp_at: そのボードの指標に最後に到達した時刻。指標が厳密に増えたときだけ進め、
 *   同値のときの並び（先に到達した人が上）に使う。
 */

/** 更新のSET句のうち、ボード1つぶん（指標のMAXと、到達時刻の更新）。 */
const BOARD_SET = [
  "level = MAX(level, ?), level_at = CASE WHEN ? > level THEN ? ELSE level_at END",
  "deepest = MAX(deepest, ?), deepest_at = CASE WHEN ? > deepest THEN ? ELSE deepest_at END",
  "total_exp = MAX(total_exp, ?), exp_at = CASE WHEN ? > total_exp THEN ? ELSE exp_at END",
] as const;

/**
 * 指標が伸びるボードの組み合わせ（maskのbit0がlevel、bit1がdeepest、bit2がexp）ごとのUPDATE文。
 * 実行時の入力から組み立てているのではなく、モジュールの読み込み時に固定の断片をつなげた8本だけがある。
 */
const UPDATE_PLAYER_VARIANTS: readonly string[] = Array.from({ length: 1 << BOARD_SET.length }, (_, mask) => {
  const boardSets = BOARD_SET.filter((_set, bit) => (mask & (1 << bit)) !== 0);
  return (
    ["UPDATE players SET name = ?, kills = MAX(kills, ?), ticks = MAX(ticks, ?), updated_at = ?", ...boardSets].join(
      ", ",
    ) + " WHERE id = ? AND token_hash = ? AND updated_at <= ?"
  );
});

/** 指標が保存値より伸びるボードを示す。 */
export interface RaisedBoards {
  level: boolean;
  deepest: boolean;
  exp: boolean;
}

/** 指標が伸びるボードの組み合わせに合ったUPDATE文を返す。引数の並びはSQL.updatePlayerのコメントのとおり。 */
export function updatePlayerSql(raised: RaisedBoards): string {
  const mask = (raised.level ? 1 : 0) | (raised.deepest ? 2 : 0) | (raised.exp ? 4 : 0);
  const sql = UPDATE_PLAYER_VARIANTS[mask];
  if (sql === undefined) throw new Error(`no update statement for mask ${mask}`);
  return sql;
}

/** 順位は「指標が自分より厳密に大きい人数に1を足した値」で求める（同値は同順位の標準競技順位）。 */
export const SQL = {
  /**
   * 1人分の認証情報、最終送信時刻、保存済みの指標（引数はid）。
   * 保存済みの指標は、更新で書き換えるインデックスを絞るために読む。
   * 読んだあとに指標が伸びていても、UPDATE側のMAXが守るので、スコアが下がることはない。
   */
  selectPlayer: "SELECT token_hash, updated_at, level, deepest, total_exp FROM players WHERE id = ?",

  /**
   * 新規登録。引数は順にid, token_hash, name, level, deepest, total_exp, kills, ticks, created_at, updated_at,
   * level_at, deepest_at, exp_at（最後の3つは登録時刻）。
   * 同時リクエストで先に登録された場合は何もしない（changesが0になり、登録人数のトリガーも動かない）。
   */
  insertPlayer:
    "INSERT INTO players (id, token_hash, name, level, deepest, total_exp, kills, ticks, created_at, updated_at, " +
    "level_at, deepest_at, exp_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",

  /**
   * 更新。指標が伸びるボードの組み合わせごとに1本ずつ、全8本を用意する（添字はupdatePlayerSqlのmask）。
   * 引数は順に次のとおり。
   * 1. name, kills, ticks, updated_at
   * 2. 伸びるボードごとに、指標の送信値、到達時刻の判定に使う同じ送信値、到達時刻（level、deepest、expの順）
   * 3. id, token_hash, 送信間隔を空けた境界時刻（WHERE）
   * SQLiteのUPDATEは、SETに書いた列を含むインデックスを、値が同じでも書き換える。
   * 指標が伸びないボードの列をSETに入れないことで、そのボードのインデックスには触れず、
   * 指標が変わらない送信の書き込みを行本体の1行だけにする。
   * 各指標は保存値と送信値のMAXにして、古いクライアントがスコアを下げられないようにする。
   * 到達時刻は、送信値が保存値を厳密に上回ったときだけ進める
   * （SQLiteのUPDATEでは、右辺の列は更新前の値を指すので、MAXと並べて書いても判定がずれない）。
   * 送信間隔の判定をWHEREに入れ、同時リクエストでも間隔を破る書き込みが通らないようにする。
   */
  updatePlayer: UPDATE_PLAYER_VARIANTS,

  /** 書き込み直後の3ボードの順位（引数はid） */
  rankAll:
    "SELECT " +
    "1 + (SELECT COUNT(*) FROM players WHERE level > p.level) AS level_rank, " +
    "1 + (SELECT COUNT(*) FROM players WHERE deepest > p.deepest) AS deepest_rank, " +
    "1 + (SELECT COUNT(*) FROM players WHERE total_exp > p.total_exp) AS exp_rank " +
    "FROM players AS p WHERE p.id = ?",

  /** 脱退。引数は順にid, token_hash。登録人数はトリガーが減らす。 */
  deletePlayer: "DELETE FROM players WHERE id = ? AND token_hash = ?",

  /** 登録人数。カウンタ行を1行読むだけで済ませる（playersの全件を数えない）。 */
  countPlayers: "SELECT n FROM player_count WHERE id = 1",

  /** ボードごとの上位N件（引数はlimit）。並びは「指標の降順、到達時刻の昇順、rowidの昇順」 */
  leaderboard: {
    level:
      "SELECT id, name, level, deepest, total_exp FROM players " +
      "ORDER BY level DESC, level_at ASC, rowid ASC LIMIT ?",
    deepest:
      "SELECT id, name, level, deepest, total_exp FROM players " +
      "ORDER BY deepest DESC, deepest_at ASC, rowid ASC LIMIT ?",
    exp:
      "SELECT id, name, level, deepest, total_exp FROM players " +
      "ORDER BY total_exp DESC, exp_at ASC, rowid ASC LIMIT ?",
  },

  /** ボードごとの「自分」の行と順位（引数はid） */
  me: {
    level:
      "SELECT p.name, p.level, p.deepest, p.total_exp, " +
      "1 + (SELECT COUNT(*) FROM players WHERE level > p.level) AS rank " +
      "FROM players AS p WHERE p.id = ?",
    deepest:
      "SELECT p.name, p.level, p.deepest, p.total_exp, " +
      "1 + (SELECT COUNT(*) FROM players WHERE deepest > p.deepest) AS rank " +
      "FROM players AS p WHERE p.id = ?",
    exp:
      "SELECT p.name, p.level, p.deepest, p.total_exp, " +
      "1 + (SELECT COUNT(*) FROM players WHERE total_exp > p.total_exp) AS rank " +
      "FROM players AS p WHERE p.id = ?",
  },
} as const;
