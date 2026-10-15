// ランキングサーバーとのやり取りに使う純粋関数。通信そのものはregister.tsxが$.http.fetchで行う。
import type { Board, Game, RankBy, RankEntry } from '../types'

/** 応答待ちが終わるたびに送るが、この間隔より短ければ送らない(サーバー側は20秒) */
export const SUBMIT_INTERVAL_MS = 60_000
export const BOARD_LIMIT = 10
const NAME_MAX = 12

export const RANK_LABEL: Readonly<Record<RankBy, string>> = { level: 'Lv', deepest: '最深階', exp: '総経験' }

/** $.storeに置くプレイヤー情報。tokenは記録を書き換えるための秘密で、$.stateには出さない */
export type Player = { id: string; token: string; name: string; isJoined: boolean; lastSentAt: number }

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += alphabet[(buffer >> bits) & 63]
    }
  }
  if (bits > 0) out += alphabet[(buffer << (6 - bits)) & 63]
  return out
}

export function newPlayer(): Player {
  return { id: crypto.randomUUID().toLowerCase(), token: base64Url(randomBytes(32)), name: '', isJoined: false, lastSentAt: 0 }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/

/** $.storeから読んだ値を検証する。壊れていればnull */
export function loadPlayer(saved: unknown): Player | null {
  if (typeof saved !== 'object' || saved === null) return null
  const p = saved as Partial<Player>
  if (typeof p.id !== 'string' || !UUID.test(p.id)) return null
  if (typeof p.token !== 'string' || !TOKEN.test(p.token)) return null
  return {
    id: p.id,
    token: p.token,
    name: typeof p.name === 'string' ? p.name : '',
    isJoined: p.isJoined === true,
    lastSentAt: typeof p.lastSentAt === 'number' && Number.isFinite(p.lastSentAt) ? p.lastSentAt : 0,
  }
}

/** サーバーと同じ規則で名前を整える。前後の空白を除き、空白の連続を1つにし、1〜12文字で制御文字なし。不正ならnull */
export function normalizeName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ')
  const chars = [...name]
  if (chars.length < 1 || chars.length > NAME_MAX) return null
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return null
  return name
}

/** http:は手元で動かすサーバー(localhost)にだけ許し、それ以外はhttps:に限る */
export function endpoint(base: string, path: string): string | null {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return null
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${path}`
}

export function scoreBody(player: Player, game: Game): string {
  return JSON.stringify({
    playerId: player.id,
    token: player.token,
    name: player.name,
    level: game.level,
    deepest: game.deepest,
    totalExp: Math.floor(game.totalExp),
    kills: game.kills,
    ticks: game.ticks,
  })
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseEntry(value: unknown): RankEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isCount(v.rank) || !isCount(v.level) || !isCount(v.deepest) || !isCount(v.totalExp)) return null
  if (typeof v.name !== 'string') return null
  // 表示前に制御文字を落とし、長さも抑える(サーバーが壊れていても画面を崩さない)
  const name = [...v.name.replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, NAME_MAX).join('')
  return { rank: v.rank, name, level: v.level, deepest: v.deepest, totalExp: v.totalExp, isYou: v.isYou === true }
}

/** GET /v1/leaderboard の応答を検証する。形が違えばnull */
export function parseBoard(text: string): Board | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.by !== 'level' && d.by !== 'deepest' && d.by !== 'exp') return null
  if (!Array.isArray(d.entries) || !isCount(d.players)) return null
  const entries = d.entries.map(parseEntry)
  if (entries.some(entry => entry === null)) return null
  const me = d.me === null || d.me === undefined ? null : parseEntry({ ...(d.me as object), isYou: true })
  return { by: d.by, entries: entries as RankEntry[], me, players: d.players }
}

/** 通信の失敗を、プレイヤーが次に何をすればよいか分かる文にする */
export function failureText(status: number): string {
  if (status === 403) return 'この記録は別の端末で登録されたもので、書き換えられない。'
  if (status === 422) return '記録が不自然と判定され、受け付けられなかった。'
  if (status === 429) return '送信の間隔が短すぎる。少し待ってから更新する。'
  if (status === 400 || status === 415) return '送った内容が受け付けられなかった。名前を見直す。'
  if (status === 404) return 'ランキングに記録が見つからない。'
  if (status >= 500) return 'ランキングサーバーで問題が起きている。時間をおいて更新する。'
  return `ランキングサーバーが想定外の応答を返した(${status})。`
}
