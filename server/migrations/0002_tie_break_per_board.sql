-- 同値のときの並び順を、ボードごとの「その指標に最後に到達した時刻」で決めるようにする。
-- updated_atは送信間隔(20秒)の判定にだけ使う「最終送信時刻」にして、どのインデックスにも入れない。
-- 指標が厳密に増えたときだけ*_atを進めるので、同じ値のまま送信を続けても並びは動かず、
-- 指標が変わらない送信ではインデックスの行を書き換えずにすむ。
ALTER TABLE players ADD COLUMN level_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN deepest_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN exp_at INTEGER NOT NULL DEFAULT 0;

-- 既存の行は、これまでの並び（updated_at）をそのまま引き継ぐ。
UPDATE players SET level_at = updated_at, deepest_at = updated_at, exp_at = updated_at;

-- 並び順に使うインデックスを、到達時刻の列で作り直す。
DROP INDEX idx_players_level;
DROP INDEX idx_players_deepest;
DROP INDEX idx_players_total_exp;

CREATE INDEX idx_players_level ON players (level DESC, level_at ASC);

CREATE INDEX idx_players_deepest ON players (deepest DESC, deepest_at ASC);

CREATE INDEX idx_players_total_exp ON players (total_exp DESC, exp_at ASC);
