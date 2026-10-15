// 灯火迷宮のゲームロジック。$に触れない純粋関数だけを置き、register.tsxから呼ぶ。
import type { Focus, Foe, Game, LogKind, RunSummary } from '../types'

export const TICK_MS = 1500
const LOG_LIMIT = 40
const ENCOUNTERS_PER_FLOOR = 4
const RETREAT_FLOORS = 2
const POINTS_PER_LEVEL = 3
/** 敵と敵の合間にこれを下回っていたら、先へ進む前に休む */
const LOW_HP_RATIO = 0.35

type Species = { glyph: string; name: string }
type Biome = { name: string; foes: readonly [Species, Species, Species, Species]; boss: Species }

// 10階ごとに景色が変わる。100階を越えると同じ並びを「弐」「参」…の深さで巡り直す。
const BIOMES: readonly Biome[] = [
  {
    name: '苔むす石段',
    foes: [
      { glyph: '鼠', name: '大ネズミ' },
      { glyph: '蝠', name: '洞窟コウモリ' },
      { glyph: '粘', name: '苔スライム' },
      { glyph: '蜘', name: '穴グモ' },
    ],
    boss: { glyph: '王', name: 'ネズミの王' },
  },
  {
    name: '骨の回廊',
    foes: [
      { glyph: '骸', name: '骸骨兵' },
      { glyph: '霊', name: '鬼火' },
      { glyph: '屍', name: 'さまよう屍' },
      { glyph: '鴉', name: '墓守ガラス' },
    ],
    boss: { glyph: '冠', name: '骨冠の騎士' },
  },
  {
    name: '地下水脈',
    foes: [
      { glyph: '蛙', name: '盲目ガエル' },
      { glyph: '蛭', name: '大ヒル' },
      { glyph: '蟹', name: '鉄甲ガニ' },
      { glyph: '鰐', name: '水路ワニ' },
    ],
    boss: { glyph: '蛇', name: '水脈の大蛇' },
  },
  {
    name: '打ち捨てられた坑道',
    foes: [
      { glyph: '坑', name: '亡霊坑夫' },
      { glyph: '蟲', name: '岩喰い虫' },
      { glyph: '石', name: '石像兵' },
      { glyph: '土', name: '大モグラ' },
    ],
    boss: { glyph: '巨', name: '坑道の巨人' },
  },
  {
    name: '菌糸の森',
    foes: [
      { glyph: '茸', name: '歩く茸' },
      { glyph: '蛾', name: '燐光蛾' },
      { glyph: '胞', name: '胞子袋' },
      { glyph: '蔦', name: '絞め蔦' },
    ],
    boss: { glyph: '母', name: '菌糸の母' },
  },
  {
    name: '溶岩の裂け目',
    foes: [
      { glyph: '蜥', name: '火トカゲ' },
      { glyph: '炎', name: '炎の精' },
      { glyph: '亀', name: '熔岩ガメ' },
      { glyph: '灰', name: '灰の獣' },
    ],
    boss: { glyph: '竜', name: '赤竜の仔' },
  },
  {
    name: '凍てつく書庫',
    foes: [
      { glyph: '書', name: '呪われた書' },
      { glyph: '氷', name: '氷霊' },
      { glyph: '司', name: '書庫の番人' },
      { glyph: '狼', name: '霜狼' },
    ],
    boss: { glyph: '賢', name: '凍れる賢者' },
  },
  {
    name: '鏡の迷路',
    foes: [
      { glyph: '鏡', name: '鏡像' },
      { glyph: '影', name: '影法師' },
      { glyph: '面', name: '仮面兵' },
      { glyph: '幻', name: '幻術師' },
    ],
    boss: { glyph: '双', name: '双子の鏡像' },
  },
  {
    name: '鎖の牢獄',
    foes: [
      { glyph: '鎖', name: '鎖の亡者' },
      { glyph: '獄', name: '獄卒' },
      { glyph: '牢', name: '牢鬼' },
      { glyph: '刑', name: '処刑人' },
    ],
    boss: { glyph: '典', name: '典獄長' },
  },
  {
    name: '星なき大空洞',
    foes: [
      { glyph: '虚', name: '虚ろなもの' },
      { glyph: '眼', name: '浮かぶ眼' },
      { glyph: '触', name: '這い寄る触手' },
      { glyph: '翼', name: '堕ちた翼' },
    ],
    boss: { glyph: '淵', name: '深淵の目' },
  },
]

// [体力, 攻撃, 防御]の倍率。0:標準、1:素早いが脆い、2:硬い、3:力自慢
const SLOT_SHAPE: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [0.75, 1.2, 0.7],
  [1.4, 0.75, 1.3],
  [1, 1.25, 0.95],
]

const KANJI_DIGITS = ['', '', '弐', '参', '肆', '伍', '陸', '漆', '捌', '玖', '拾']

const WEAPONS = ['木の棒', '錆びた剣', '鉄の剣', '鋼の剣', '銀の剣', '魔鋼の剣', '竜骨の剣', '星鉄の剣', '灯火の剣']
const ARMORS = ['布の服', '革の鎧', '鎖帷子', '鉄の鎧', '鋼の鎧', '銀の鎧', '竜鱗の鎧', '星鉄の鎧', '灯火の衣']

export function emptyRun(): RunSummary {
  return { ticks: 0, kills: 0, exp: 0, gold: 0, levels: 0, floorsDown: 0 }
}

export function newGame(seed: number): Game {
  return {
    v: 1,
    rev: 0,
    seed: seed >>> 0 || 1,
    level: 1,
    exp: 0,
    totalExp: 0,
    gold: 0,
    hp: heroBase(1).maxHp,
    points: { atk: 0, def: 0, hp: 0 },
    focus: 'even',
    weapon: 0,
    armor: 0,
    floor: 1,
    deepest: 1,
    step: 0,
    phase: 'walk',
    foe: null,
    isAuto: true,
    kills: 0,
    defeats: 0,
    ticks: 0,
    run: emptyRun(),
    log: [{ text: '灯を手に、苔むす石段を下りはじめた。', kind: 'info' }],
  }
}

// ---- 数値 ----

function heroBase(level: number): { maxHp: number; atk: number; def: number } {
  const l = level - 1
  return { maxHp: 50 + 14 * l, atk: 8 + 2.4 * l, def: 3 + 1.1 * l }
}

export function weaponAtk(w: number): number {
  return 3 * w + Math.floor((w * w) / 25)
}

export function armorDef(a: number): number {
  return 2 * a + Math.floor((a * a) / 40)
}

export function armorHp(a: number): number {
  return 8 * a + Math.floor((a * a) / 8)
}

export function heroStats(g: Game): { maxHp: number; atk: number; def: number } {
  const base = heroBase(g.level)
  return {
    maxHp: Math.round(base.maxHp + 8 * g.points.hp + armorHp(g.armor)),
    atk: Math.round(base.atk + 2 * g.points.atk + weaponAtk(g.weapon)),
    def: Math.round(base.def + 1.5 * g.points.def + armorDef(g.armor)),
  }
}

export function expNeed(level: number): number {
  return Math.round(10 + 6 * level ** 1.6)
}

export function upgradeCost(level: number): number {
  return Math.round(25 * 1.15 ** level)
}

export function biomeAt(floor: number): { name: string; index: number } {
  const zone = Math.floor((floor - 1) / 10)
  const index = zone % BIOMES.length
  const lap = Math.floor(zone / BIOMES.length) + 1
  const biome = BIOMES[index] ?? BIOMES[0]!
  const suffix = lap === 1 ? '' : ` ${KANJI_DIGITS[lap] ?? String(lap)}`
  return { name: biome.name + suffix, index }
}

export function isBossFloor(floor: number): boolean {
  return floor % 10 === 0
}

export function encountersOn(): number {
  return ENCOUNTERS_PER_FLOOR
}

export function makeFoe(floor: number, slot: number, isBoss: boolean): Foe {
  const biome = BIOMES[biomeAt(floor).index] ?? BIOMES[0]!
  const species = isBoss ? biome.boss : (biome.foes[slot] ?? biome.foes[0])
  const [hpK, atkK, defK] = isBoss ? [4, 1.35, 1.2] : (SLOT_SHAPE[slot] ?? SLOT_SHAPE[0]!)
  const m = floor
  const maxHp = Math.round((18 + 9 * m + 0.06 * m * m) * hpK)
  const reward = isBoss ? 8 : (hpK + atkK) / 2
  return {
    name: species.name,
    glyph: species.glyph,
    level: floor,
    hp: maxHp,
    maxHp,
    atk: Math.round((5 + 2 * m + 0.012 * m * m) * atkK),
    def: Math.round((2 + m + 0.008 * m * m) * defK),
    exp: Math.round((4 + 2.2 * m + 0.02 * m * m) * reward),
    gold: Math.round((2 + 1.2 * m + 0.01 * m * m) * reward * (isBoss ? 1.25 : 1)),
    isBoss,
  }
}

// ---- 乱数(セーブに種を持つので、同じセーブからは同じ展開になる) ----

function nextRandom(d: Game): number {
  let t = (d.seed = (d.seed + 0x6d2b79f5) >>> 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function damage(atk: number, def: number, roll: number): number {
  return Math.max(1, Math.round(((atk * atk) / (atk + def)) * (0.9 + 0.2 * roll)))
}

// ---- 進行 ----

function draft(g: Game): Game {
  return {
    ...g,
    points: { ...g.points },
    run: { ...g.run },
    foe: g.foe === null ? null : { ...g.foe },
    log: [...g.log],
  }
}

function say(d: Game, text: string, kind: LogKind): void {
  d.log.push({ text, kind })
  if (d.log.length > LOG_LIMIT) d.log.splice(0, d.log.length - LOG_LIMIT)
}

function spendPoints(d: Game, focus: Focus): void {
  if (focus === 'even') {
    d.points.atk += 1
    d.points.def += 1
    d.points.hp += 1
    return
  }
  d.points[focus] += POINTS_PER_LEVEL
}

function gainExp(d: Game, amount: number): void {
  d.exp += amount
  d.totalExp += amount
  d.run.exp += amount
  while (d.exp >= expNeed(d.level)) {
    d.exp -= expNeed(d.level)
    d.level += 1
    d.run.levels += 1
    spendPoints(d, d.focus)
    d.hp = heroStats(d).maxHp
    say(d, `Lv${d.level}に上がった。傷がふさがった。`, 'level')
  }
}

function descend(d: Game): void {
  const before = biomeAt(d.floor).name
  d.floor += 1
  d.step = 0
  d.run.floorsDown += 1
  if (d.floor > d.deepest) d.deepest = d.floor
  const after = biomeAt(d.floor).name
  say(d, after === before ? `地下${d.floor}階へ降りた。` : `地下${d.floor}階、${after}に出た。`, 'info')
}

function walk(d: Game): void {
  if (d.hp < heroStats(d).maxHp * LOW_HP_RATIO) {
    d.phase = 'rest'
    say(d, '灯の下で息を整える。', 'info')
    return
  }
  if (d.step >= ENCOUNTERS_PER_FLOOR) {
    if (d.isAuto) {
      descend(d)
    } else {
      d.step = 0
      say(d, `地下${d.floor}階をもう一巡する。`, 'info')
    }
    return
  }
  const isBoss = isBossFloor(d.floor) && d.step === ENCOUNTERS_PER_FLOOR - 1
  const slot = Math.floor(nextRandom(d) * 4)
  d.foe = makeFoe(d.floor, slot, isBoss)
  d.phase = 'fight'
  say(d, isBoss ? `階の主、${d.foe.name}が立ちはだかる。` : `${d.foe.name}が現れた。`, isBoss ? 'boss' : 'info')
}

function fight(d: Game, foe: Foe): void {
  const hero = heroStats(d)
  const isCritical = nextRandom(d) < 0.08
  const dealt = Math.round(damage(hero.atk, foe.def, nextRandom(d)) * (isCritical ? 1.8 : 1))
  foe.hp = Math.max(0, foe.hp - dealt)

  if (foe.hp === 0) {
    d.kills += 1
    d.run.kills += 1
    d.gold += foe.gold
    d.run.gold += foe.gold
    d.step += 1
    d.foe = null
    d.phase = 'walk'
    d.hp = Math.min(hero.maxHp, d.hp + Math.round(hero.maxHp * 0.08))
    say(d, `${foe.name}を倒した。経験+${fmt(foe.exp)}、金+${fmt(foe.gold)}`, foe.isBoss ? 'boss' : 'gain')
    gainExp(d, foe.exp)
    return
  }

  d.hp -= damage(foe.atk, hero.def, nextRandom(d))
  if (d.hp > 0) return

  d.defeats += 1
  d.hp = 1
  d.foe = null
  d.phase = 'rest'
  d.step = 0
  d.floor = Math.max(1, d.floor - RETREAT_FLOORS)
  say(d, `${foe.name}に敗れた。地下${d.floor}階まで退いて休む。`, 'loss')
}

function rest(d: Game): void {
  const { maxHp } = heroStats(d)
  d.hp = Math.min(maxHp, d.hp + Math.ceil(maxHp * 0.25))
  if (d.hp < maxHp) return
  d.phase = 'walk'
  say(d, '灯を掲げ直し、探索を再開した。', 'info')
}

/** 1tick進める。Claudeの応答待ちの間だけTICK_MSごとに呼ばれる */
export function tick(g: Game): Game {
  const d = draft(g)
  d.ticks += 1
  d.run.ticks += 1
  if (d.phase === 'rest') rest(d)
  else if (d.phase === 'fight' && d.foe !== null) fight(d, d.foe)
  else walk(d)
  return d
}

// ---- プレイヤーの操作 ----

export function buyWeapon(g: Game): Game | null {
  const cost = upgradeCost(g.weapon)
  if (g.gold < cost) return null
  const d = draft(g)
  d.gold -= cost
  d.weapon += 1
  say(d, `武器を鍛えた。${weaponName(d.weapon)}`, 'gain')
  return d
}

export function buyArmor(g: Game): Game | null {
  const cost = upgradeCost(g.armor)
  if (g.gold < cost) return null
  const d = draft(g)
  const before = heroStats(d).maxHp
  d.gold -= cost
  d.armor += 1
  d.hp += heroStats(d).maxHp - before
  say(d, `防具を鍛えた。${armorName(d.armor)}`, 'gain')
  return d
}

export function setFocus(g: Game, focus: Focus): Game {
  return { ...g, focus }
}

export function setAuto(g: Game, isAuto: boolean): Game {
  return { ...g, isAuto }
}

/** 浅い階・深い階へ移る。深い側は到達済みの最深階まで */
export function moveFloor(g: Game, delta: number): Game {
  const floor = Math.min(g.deepest, Math.max(1, g.floor + delta))
  if (floor === g.floor) return g
  const d = draft(g)
  d.floor = floor
  d.step = 0
  d.foe = null
  if (d.phase === 'fight') d.phase = 'walk'
  say(d, `地下${floor}階へ移った。`, 'info')
  return d
}

export function startRun(g: Game): Game {
  return { ...g, run: emptyRun() }
}

// ---- 表示用 ----

const UNITS: readonly (readonly [number, string])[] = [
  [1e20, '垓'],
  [1e16, '京'],
  [1e12, '兆'],
  [1e8, '億'],
  [1e4, '万'],
]

/** 1万未満は桁区切り、それ以上は12.3万や4.56億のように縮める */
export function fmt(n: number): string {
  const value = Math.floor(n)
  for (const [size, unit] of UNITS) {
    if (value >= size) {
      const scaled = value / size
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return `${Number(scaled.toFixed(digits))}${unit}`
    }
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function gear(names: readonly string[], level: number): string {
  const tier = Math.min(names.length - 1, Math.floor(level / 10))
  const plus = level - tier * 10
  return plus === 0 ? names[tier]! : `${names[tier]!}+${plus}`
}

export function weaponName(level: number): string {
  return gear(WEAPONS, level)
}

export function armorName(level: number): string {
  return gear(ARMORS, level)
}

/** 遊んだ時間を「3時間12分」の形で */
export function playTime(ticks: number): string {
  const minutes = Math.floor((ticks * TICK_MS) / 60000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}時間${m}分` : `${m}分`
}

// ---- 保存データの読み込み ----

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** $.storeから読んだ値を検証する。壊れていればnull(呼び出し側で新規ゲームにする) */
export function loadGame(saved: unknown): Game | null {
  if (typeof saved !== 'object' || saved === null) return null
  const s = saved as Partial<Game>
  if (s.v !== 1) return null
  const counts = [s.rev, s.seed, s.level, s.exp, s.totalExp, s.gold, s.hp, s.weapon, s.armor, s.floor, s.deepest, s.step, s.kills, s.defeats, s.ticks]
  if (!counts.every(isCount)) return null
  if (typeof s.points !== 'object' || s.points === null || ![s.points.atk, s.points.def, s.points.hp].every(isCount)) return null
  if (!Array.isArray(s.log)) return null
  const fresh = newGame(1)
  return {
    ...fresh,
    ...s,
    focus: s.focus === 'atk' || s.focus === 'def' || s.focus === 'hp' ? s.focus : 'even',
    phase: s.phase === 'fight' || s.phase === 'rest' ? s.phase : 'walk',
    foe: s.phase === 'fight' && typeof s.foe === 'object' ? (s.foe ?? null) : null,
    isAuto: s.isAuto !== false,
    run: { ...emptyRun(), ...(s.run ?? {}) },
  } as Game
}
