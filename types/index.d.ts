/** レベルアップ時のステータスポイントの振り先 */
export type Focus = 'atk' | 'def' | 'hp' | 'even'

/** walk:通路を進む、fight:交戦中、rest:敗走後の休息 */
export type Phase = 'walk' | 'fight' | 'rest'

export type Foe = {
  name: string
  /** 通路に描く1文字(漢字) */
  glyph: string
  level: number
  hp: number
  maxHp: number
  atk: number
  def: number
  exp: number
  gold: number
  isBoss: boolean
}

export type LogKind = 'gain' | 'level' | 'loss' | 'boss' | 'info'

export type LogLine = { text: string; kind: LogKind }

/** 直近の待ち時間(1ターン)で得たもの */
export type RunSummary = {
  ticks: number
  kills: number
  exp: number
  gold: number
  levels: number
  floorsDown: number
}

export type Game = {
  v: 1
  /** 保存のたびに増える。別セッションの新しいセーブを見分けるのに使う */
  rev: number
  seed: number
  level: number
  /** 現在レベル内で貯まった経験値 */
  exp: number
  /** 累計経験値 */
  totalExp: number
  gold: number
  hp: number
  points: { atk: number; def: number; hp: number }
  focus: Focus
  weapon: number
  armor: number
  floor: number
  deepest: number
  /** 階内で何体目の敵まで進んだか */
  step: number
  phase: Phase
  foe: Foe | null
  /** true:階段を見つけたら次の階へ、false:同じ階で稼ぐ */
  isAuto: boolean
  kills: number
  defeats: number
  /** 探索した総tick数(遊んだ時間) */
  ticks: number
  run: RunSummary
  log: LogLine[]
}

/** ランキングの並べ方。level:レベル、deepest:最深階、exp:総経験値 */
export type RankBy = 'level' | 'deepest' | 'exp'

export type RankEntry = {
  rank: number
  name: string
  level: number
  deepest: number
  totalExp: number
  isYou: boolean
}

export type Board = { by: RankBy; entries: RankEntry[]; me: RankEntry | null; players: number }

/** ペインに描くランキングの状態。秘密のtokenは$.storeにだけ置き、ここには入れない */
export type Ranking = {
  isJoined: boolean
  name: string
  by: RankBy
  board: Board | null
  /** 直近の失敗。成功すると消える */
  error: string | null
  isBusy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    tomoshibi: { game: Game; isBandHidden: boolean; isLit: boolean; ranking: Ranking }
  }
}
