// 16x16のドット絵と、その描画データ(端末のRaster用セル列、デスクトップのSvg)を作る。$には触れない。
import { ART } from './art'

export const SPRITE_SIZE = 16

/** ドット絵の1文字が指す色。nullは透明。W/A/aは主人公の装備段階で塗り替える */
const PALETTE: Readonly<Record<string, number | null>> = {
  '.': null,
  k: 0x1a1220,
  w: 0xfcfcfc,
  g: 0xbcbcbc,
  G: 0x7c7c7c,
  s: 0xfcbc94,
  S: 0xc8845c,
  r: 0xe83828,
  R: 0x881400,
  o: 0xf87858,
  y: 0xf8b800,
  Y: 0xfce0a8,
  b: 0xa0602c,
  B: 0x583010,
  e: 0x00a844,
  E: 0x005820,
  l: 0xb8f818,
  c: 0x3cbcfc,
  C: 0x0058f8,
  n: 0x0820a0,
  p: 0x9078fc,
  P: 0xd800cc,
  v: 0x4428bc,
  i: 0xa4e4fc,
  W: 0xbcbcbc,
  A: 0x4c6ccc,
  a: 0x283c88,
}

// 武器・防具の名前(game.ts)と同じ10段階ごとの並び。木の棒→錆→鉄→鋼→銀→魔鋼→竜骨→星鉄→灯火
const BLADE = [0xa0602c, 0xb86848, 0x9ca0a8, 0xd0d8e8, 0xfcfcfc, 0x9078fc, 0xfce0a8, 0x3cbcfc, 0xf8b800]
// 布の服→革→鎖帷子→鉄→鋼→銀→竜鱗→星鉄→灯火の衣。[地の色, 影の色]
const ARMOR: readonly (readonly [number, number])[] = [
  [0xb8a888, 0x887858],
  [0xa0602c, 0x583010],
  [0x9ca0a8, 0x5c6068],
  [0x7c8494, 0x484c58],
  [0x4c6ccc, 0x283c88],
  [0xd8dce8, 0x8c90a0],
  [0x00a844, 0x005820],
  [0x3c7cfc, 0x0820a0],
  [0xe83828, 0x881400],
]

export type Recolor = Readonly<Record<string, number>>

/** 装備の強化段階から、主人公の剣と鎧の塗り替えを決める */
export function heroRecolor(weapon: number, armor: number): Recolor {
  const blade = BLADE[Math.min(BLADE.length - 1, Math.floor(weapon / 10))]!
  const [main, shade] = ARMOR[Math.min(ARMOR.length - 1, Math.floor(armor / 10))]!
  return { W: blade, A: main, a: shade }
}

export type SpriteOptions = {
  /** 1ドット上に浮かせる(待機中の上下の揺れ) */
  isLifted?: boolean
  /** 左右反転(焚き火の揺らぎ) */
  isMirrored?: boolean
  recolor?: Recolor
}

const EMPTY: readonly string[] = Array.from({ length: SPRITE_SIZE }, () => '.'.repeat(SPRITE_SIZE))

export function artFor(glyph: string): readonly string[] | undefined {
  return ART[glyph]
}

export function blankArt(): readonly string[] {
  return EMPTY
}

function pixels(rows: readonly string[], options: SpriteOptions): (number | null)[][] {
  let grid = rows.map(row => [...row])
  if (options.isMirrored) grid = grid.map(row => [...row].reverse())
  if (options.isLifted) grid = [...grid.slice(1), [...'.'.repeat(SPRITE_SIZE)]]
  return grid.map(row =>
    row.map(key => {
      const recolored = options.recolor?.[key]
      if (recolored !== undefined) return recolored
      return PALETTE[key] ?? null
    }),
  )
}

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(n >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[n & 63]!
  }
  return out
}

/** 端末のRaster用。1セルに上下2ドットを半角ブロックで詰め、16列x8行にする */
export function rasterCells(rows: readonly string[], options: SpriteOptions = {}): string {
  const grid = pixels(rows, options)
  const cellRows = SPRITE_SIZE / 2
  const view = new DataView(new ArrayBuffer(SPRITE_SIZE * cellRows * 12))
  let offset = 0
  for (let y = 0; y < cellRows; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const top = grid[y * 2]?.[x] ?? null
      const bottom = grid[y * 2 + 1]?.[x] ?? null
      const cell =
        top === null && bottom === null
          ? [SPACE, DEFAULT_COLOR, DEFAULT_COLOR]
          : top === null
            ? [LOWER_HALF, bottom ?? DEFAULT_COLOR, DEFAULT_COLOR]
            : [UPPER_HALF, top, bottom ?? DEFAULT_COLOR]
      for (const word of cell) {
        view.setUint32(offset, word, true)
        offset += 4
      }
    }
  }
  return toBase64(new Uint8Array(view.buffer))
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** デスクトップなどのSvg用。同じ色が横に続くドットは1つの矩形にまとめる */
export function svgSource(rows: readonly string[], options: SpriteOptions = {}): string {
  const grid = pixels(rows, options)
  const rects: string[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const color = row[x] ?? null
      let end = x + 1
      while (end < row.length && row[end] === color) end++
      if (color !== null) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(color)}"/>`)
      x = end
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}
