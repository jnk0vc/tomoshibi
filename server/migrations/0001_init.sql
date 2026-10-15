-- 灯火迷宮ランキングの初期スキーマ。
-- 1プレイヤー1行。トークンは平文で持たず、SHA-256の16進文字列だけを保存する。
-- 時刻はすべてエポックミリ秒。updated_atは最後に受理した送信の時刻。
CREATE TABLE players (
  id          TEXT    PRIMARY KEY,
  token_hash  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  level       INTEGER NOT NULL CHECK (level >= 1),
  deepest     INTEGER NOT NULL CHECK (deepest >= 1),
  total_exp   INTEGER NOT NULL CHECK (total_exp >= 0),
  kills       INTEGER NOT NULL CHECK (kills >= 0),
  ticks       INTEGER NOT NULL CHECK (ticks >= 0),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 各ボードの並び順は「指標の降順、updated_atの昇順、rowidの昇順」。
-- SQLiteのインデックスは末尾にrowidを暗黙で持つので、下の3本でORDER BYをそのまま満たせる。
-- 順位の集計（指標が自分より大きい人数のCOUNT）も同じインデックスの範囲走査で済む。
-- （0002で、同値の並びをボードごとの到達時刻（level_atなど）に変え、updated_atをインデックスから外した）
CREATE INDEX idx_players_level ON players (level DESC, updated_at ASC);

CREATE INDEX idx_players_deepest ON players (deepest DESC, updated_at ASC);

CREATE INDEX idx_players_total_exp ON players (total_exp DESC, updated_at ASC);
