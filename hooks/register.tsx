import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Focus, Game, LogKind, Ranking, RankBy, RankEntry } from '../types'
import {
  armorName,
  biomeAt,
  buyArmor,
  buyWeapon,
  encountersOn,
  expNeed,
  fmt,
  heroStats,
  isBossFloor,
  loadGame,
  moveFloor,
  newGame,
  playTime,
  setAuto,
  setFocus,
  startRun,
  tick,
  TICK_MS,
  upgradeCost,
  weaponName,
} from './game'
import {
  BOARD_LIMIT,
  endpoint,
  failureText,
  loadPlayer,
  newPlayer,
  normalizeName,
  parseBoard,
  RANK_LABEL,
  scoreBody,
  SUBMIT_INTERVAL_MS,
} from './ranking'
import type { Player } from './ranking'
import { artFor, blankArt, heroRecolor, rasterCells, svgSource } from './sprites'
import type { SpriteOptions } from './sprites'

const PANE = 'tomoshibi'
const TITLE = '灯火迷宮'
const SAVE_KEY = 'save'
/** 応答待ちが長いときも、この間隔(tick数)で途中保存する */
const SAVE_EVERY = 20

const GAME_REF = { plugin: 'tomoshibi', key: 'game' } as const
const GAME = atom(GAME_REF, newGame(1))
const BAND_HIDDEN = atom({ plugin: 'tomoshibi', key: 'isBandHidden' } as const, false)
const LIT = atom({ plugin: 'tomoshibi', key: 'isLit' } as const, false)
const INITIAL_RANKING: Ranking = { isJoined: false, name: '', by: 'level', board: null, error: null, isBusy: false }
const RANKING = atom({ plugin: 'tomoshibi', key: 'ranking' } as const, INITIAL_RANKING)
const PLAYER_KEY = 'player'
const USER_AGENT = 'tomoshibi-mod/0.3.0'
const RANK_ORDER: readonly RankBy[] = ['level', 'deepest', 'exp']

// ランキングサーバーのURL。設定(userConfig)から読み、モジュールが読み直されるたびに入れ直す
let rankingUrl = ''

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** ドット絵の描き先。端末は半角ブロックのRaster、それ以外の面はSvg */
type Canvas =
  | { kind: 'raster'; Raster: Elements['terminal']['Raster'] }
  | { kind: 'svg'; Svg: Elements['desktop']['Svg']; px: number }

const KIND_COLOR: Record<LogKind, string | undefined> = {
  info: undefined,
  gain: undefined,
  level: 'success',
  boss: 'warning',
  loss: 'error',
}

const FOCUS_LABEL: readonly (readonly [Focus, string])[] = [
  ['atk', '攻撃'],
  ['def', '防御'],
  ['hp', '体力'],
  ['even', '均等'],
]

// 応答待ちの間だけ動くタイマー。リロードで消えるのでモジュール変数でよい
let ticker: Timer | undefined

/** 保存する。ストアに別セッションの新しいセーブがあれば、上書きせずにそちらへ乗り換える */
async function save($: EngineInterface): Promise<void> {
  const stored = loadGame(await $.store.get(SAVE_KEY))
  let isBehind = false
  const game = await update($, GAME, g => {
    isBehind = stored !== null && stored.rev > g.rev
    return isBehind && stored !== null ? stored : { ...g, rev: g.rev + 1 }
  })
  if (!isBehind) await $.store.set(SAVE_KEY, game)
}

async function advance($: EngineInterface): Promise<void> {
  const game = await update($, GAME, tick)
  if (game.ticks % SAVE_EVERY === 0) await save($)
}

function light($: EngineInterface): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => {
    advance($).catch((error: unknown) => {
      $.ui.log(`tomoshibi: 探索を進められなかった: ${String(error)}`, { to: 'debug' })
    })
  })
}

function douse(): void {
  ticker?.cancel()
  ticker = undefined
}

/** 別のセッションで進んだセーブがあれば、そちらに乗り換える */
async function adoptNewerSave($: EngineInterface): Promise<void> {
  const saved = loadGame(await $.store.get(SAVE_KEY))
  if (saved === null) return
  await update($, GAME, g => (saved.rev > g.rev ? saved : g))
}

async function act($: EngineInterface, change: (g: Game) => Game | null, failure?: (g: Game) => string): Promise<void> {
  // 操作は最新のセーブの上に積む(放置していたセッションの古い状態に積まない)
  await adoptNewerSave($)
  let refused: Game | undefined
  // update は版が食い違うとやり直すので、判定も毎回やり直す
  await update($, GAME, g => {
    refused = undefined
    const next = change(g)
    if (next !== null) return next
    refused = g
    return g
  })
  if (refused !== undefined && failure !== undefined) {
    $.ui.toast(failure(refused))
    return
  }
  await save($)
}

// ---- 描画 ----

function bar(T: Ui, ratio: number, width: number, color: string): RenderElement {
  const { Box, Text } = T
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return (
    <Box flexDirection="row">
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(width - filled)}</Text>
    </Box>
  )
}

/** 階の通路。@が勇者、◦がまだ会っていない敵、◆が階の主、▼が下り階段 */
function corridor(T: Ui, g: Game, isLit: boolean): RenderElement {
  const { Box, Text } = T
  const total = encountersOn()
  const cells: RenderElement[] = [<Text dimColor>▕ </Text>]
  const hero = <Text color={isLit ? 'claude' : undefined} bold={isLit}>@</Text>
  for (let i = 0; i < total; i++) {
    const isBossSlot = isBossFloor(g.floor) && i === total - 1
    if (i === g.step) {
      cells.push(hero)
      if (g.foe !== null) {
        cells.push(<Text color={g.foe.isBoss ? 'warning' : 'error'} bold>{g.foe.glyph}</Text>)
        cells.push(<Text> </Text>)
        continue
      }
    }
    if (i < g.step) cells.push(<Text dimColor>· </Text>)
    else if (isBossSlot) cells.push(<Text color="warning">◆ </Text>)
    else cells.push(<Text dimColor>◦ </Text>)
  }
  if (g.step >= total) cells.push(hero)
  cells.push(<Text>▼</Text>)
  cells.push(<Text dimColor> ▏</Text>)
  return <Box flexDirection="row">{cells}</Box>
}

function encounter(T: Ui, g: Game): RenderElement {
  const { Box, Text } = T
  if (g.phase === 'rest') return <Text dimColor>灯の下で休んでいる</Text>
  if (g.foe === null) return <Text dimColor>通路を進んでいる</Text>
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={g.foe.isBoss ? 'warning' : undefined} bold={g.foe.isBoss} wrap="truncate">
        {g.foe.name}
      </Text>
      <Text dimColor>Lv{g.foe.level}</Text>
      {bar(T, g.foe.hp / g.foe.maxHp, 8, 'error')}
    </Box>
  )
}

function lastLines(T: Ui, g: Game, count: number): RenderElement[] {
  const { Text } = T
  const lines = g.log.slice(-count)
  if (lines.length === 0) return [<Text dimColor> </Text>]
  return lines.map(line => (
    <Text color={KIND_COLOR[line.kind]} dimColor={line.kind === 'info'} wrap="truncate">
      › {line.text}
    </Text>
  ))
}

function sprite(canvas: Canvas, key: string, rows: readonly string[], options: SpriteOptions, alt: string): RenderElement {
  if (canvas.kind === 'raster') {
    const { Raster } = canvas
    return <Raster key={key} columns={16} rows={8} cells={rasterCells(rows, options)} />
  }
  const { Svg } = canvas
  return <Svg source={svgSource(rows, options)} alt={alt} width={canvas.px} height={canvas.px} />
}

/** 左に主人公、右に敵(休息中は焚き火、通路を進む間は空き)。灯がともっている間は交互に1ドット揺れる */
function scene(T: Ui, canvas: Canvas, g: Game, isLit: boolean): RenderElement | null {
  const heroArt = artFor('@')
  if (heroArt === undefined) return null
  const { Box } = T
  const isOdd = isLit && g.ticks % 2 === 1
  const hero = sprite(
    canvas,
    'hero',
    heroArt,
    { recolor: heroRecolor(g.weapon, g.armor), isLifted: isOdd && g.phase !== 'rest' },
    `勇者(${weaponName(g.weapon)}、${armorName(g.armor)})`,
  )
  const foe =
    g.phase === 'rest'
      ? sprite(canvas, 'foe', artFor('焚') ?? blankArt(), { isMirrored: isOdd }, '焚き火')
      : g.foe === null
        ? sprite(canvas, 'foe', blankArt(), {}, '誰もいない通路')
        : sprite(canvas, 'foe', artFor(g.foe.glyph) ?? blankArt(), { isLifted: isLit && !isOdd }, g.foe.name)
  return (
    <Box flexDirection="row" gap={1}>
      {hero}
      {foe}
    </Box>
  )
}

/** 「攻撃 120」のようなラベルと値の組。間はレイアウトの間隔で空ける */
function stat(T: Ui, label: string, value: string, color?: string): RenderElement {
  const { Box, Text } = T
  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{label}</Text>
      <Text color={color} wrap="truncate">
        {value}
      </Text>
    </Box>
  )
}

function runSummary(g: Game): string {
  if (g.run.kills === 0) return '前回の待ち時間では、まだ敵を倒していない'
  const parts = [`前回の待ち時間で撃破${fmt(g.run.kills)}`, `経験+${fmt(g.run.exp)}`, `金+${fmt(g.run.gold)}`]
  if (g.run.levels > 0) parts.push(`Lv+${g.run.levels}`)
  if (g.run.floorsDown > 0) parts.push(`${g.run.floorsDown}階降りた`)
  return parts.join('・')
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  if (!opened.isPlaced) {
    $.ui.toast(`灯火迷宮を開けなかった: ${opened.reason}`)
    return
  }
  await fetchBoard($)
}

// ---- ランキング ----

/** フックの外で走らせたい通信を、時計の発火として切り離して動かす */
function later($: EngineInterface, what: string, work: () => Promise<void>): void {
  $.clock.after(0, () => {
    work().catch((error: unknown) => {
      $.ui.log(`tomoshibi: ${what}に失敗した: ${String(error)}`, { to: 'debug' })
    })
  })
}

async function request(
  $: EngineInterface,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: string,
): Promise<{ status: number; ok: boolean; text: string } | string> {
  const url = endpoint(rankingUrl, path)
  if (url === null) return 'ランキングサーバーのURLが正しくない(https://で始まるURLにする)。'
  try {
    // User-Agentを付けないと、CloudflareのBrowser Integrity Checkに弾かれることがある(error code 1010)
    const headers: Record<string, string> = { 'user-agent': USER_AGENT }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const init = body === undefined ? { method, headers } : { method, headers, body }
    return await $.http.fetch(url, init)
  } catch (error) {
    $.ui.log(`tomoshibi: ${method} ${path}: ${String(error)}`, { to: 'debug' })
    return 'ランキングサーバーにつながらない。通信できる状態で更新する。'
  }
}

async function readPlayer($: EngineInterface): Promise<Player> {
  return loadPlayer(await $.store.get(PLAYER_KEY)) ?? newPlayer()
}

async function fetchBoard($: EngineInterface): Promise<void> {
  if (rankingUrl === '') return
  const player = await readPlayer($)
  const { by } = await read($, RANKING)
  await update($, RANKING, r => ({ ...r, isBusy: true }))
  const me = player.isJoined ? `&me=${player.id}` : ''
  const res = await request($, 'GET', `/v1/leaderboard?by=${by}&limit=${BOARD_LIMIT}${me}`)
  if (typeof res === 'string') {
    await update($, RANKING, r => ({ ...r, isBusy: false, error: res }))
    return
  }
  const board = res.ok ? parseBoard(res.text) : null
  const error = board !== null ? null : res.ok ? 'ランキングの応答が読めなかった。' : failureText(res.status)
  await update($, RANKING, r => ({ ...r, isBusy: false, board: board ?? r.board, error }))
}

/** 記録を送る。isForcedでなければ、前回からSUBMIT_INTERVAL_MS経っていないときは送らない */
async function submitScore($: EngineInterface, isForced: boolean): Promise<void> {
  if (rankingUrl === '') return
  const player = loadPlayer(await $.store.get(PLAYER_KEY))
  if (player === null || !player.isJoined) return
  const now = await $.clock.now()
  if (!isForced && now - player.lastSentAt < SUBMIT_INTERVAL_MS) return
  const res = await request($, 'POST', '/v1/scores', scoreBody(player, await read($, GAME)))
  if (typeof res === 'string') {
    await update($, RANKING, r => ({ ...r, error: res }))
    return
  }
  if (res.ok || res.status === 429) {
    const latest = loadPlayer(await $.store.get(PLAYER_KEY)) ?? player
    await $.store.set(PLAYER_KEY, { ...latest, lastSentAt: now })
  }
  await update($, RANKING, r => ({ ...r, error: res.ok ? null : failureText(res.status) }))
  if (res.ok) await fetchBoard($)
}

/** 名前を決めて参加する。参加中なら名前を変える */
async function join($: EngineInterface, raw: string): Promise<void> {
  const name = normalizeName(raw)
  if (name === null) {
    await update($, RANKING, r => ({ ...r, error: '名前は1〜12文字にする(制御文字は使えない)。' }))
    return
  }
  const player = await readPlayer($)
  await $.store.set(PLAYER_KEY, { ...player, name, isJoined: true })
  await update($, RANKING, r => ({ ...r, isJoined: true, name, error: null }))
  await submitScore($, true)
}

/** ランキングから抜ける。サーバーの記録も消す */
async function leave($: EngineInterface): Promise<void> {
  const player = loadPlayer(await $.store.get(PLAYER_KEY))
  if (player === null) return
  if (rankingUrl !== '') {
    const res = await request($, 'DELETE', '/v1/scores', JSON.stringify({ playerId: player.id, token: player.token }))
    if (typeof res === 'string' || (!res.ok && res.status !== 404)) {
      const error = typeof res === 'string' ? res : failureText(res.status)
      await update($, RANKING, r => ({ ...r, error }))
      return
    }
  }
  await $.store.set(PLAYER_KEY, { ...player, isJoined: false })
  await update($, RANKING, r => ({ ...r, isJoined: false, board: null, error: null }))
}

async function chooseBoard($: EngineInterface, by: RankBy): Promise<void> {
  await update($, RANKING, r => ({ ...r, by }))
  await fetchBoard($)
}

function statText(by: RankBy, entry: RankEntry): string {
  if (by === 'deepest') return `地下${fmt(entry.deepest)}階`
  if (by === 'exp') return `経験${fmt(entry.totalExp)}`
  return `Lv${fmt(entry.level)}`
}

function rankingSection(
  $: EngineInterface,
  T: Ui,
  Input: Elements['terminal']['Input'] | null,
  ranking: Ranking,
): RenderElement {
  const { Box, Text, Button } = T
  const board = ranking.board !== null && ranking.board.by === ranking.by ? ranking.board : null
  const nameField = (key: string, label: string, submitLabel: string) =>
    Input === null ? (
      <Text dimColor>名前の入力はターミナルかデスクトップでできる。</Text>
    ) : (
      <Input
        key={key}
        label={label}
        placeholder="12文字まで"
        value={ranking.isJoined ? ranking.name : undefined}
        submitLabel={submitLabel}
        onSubmit={value => join($, value)}
      />
    )

  let body: RenderElement
  if (rankingUrl === '') {
    body = <Text dimColor>ランキングサーバーが設定されていない。プラグイン設定のrankingUrlにURLを入れると参加できる。</Text>
  } else if (!ranking.isJoined) {
    body = (
      <Box flexDirection="column">
        <Text dimColor>参加すると、名前・Lv・最深階・総経験値・撃破数・探索時間をランキングサーバーへ送る。</Text>
        {nameField('rank-join', '名前', '参加する')}
      </Box>
    )
  } else {
    const isMeShown = board?.entries.some(entry => entry.isYou) ?? false
    body = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {RANK_ORDER.map(by => (
            <Button
              key={`rank-${by}`}
              label={RANK_LABEL[by]}
              variant={ranking.by === by ? 'primary' : 'secondary'}
              dimColor={ranking.by !== by}
              onPress={() => chooseBoard($, by)}
            />
          ))}
          <Button key="rank-refresh" label="更新" onPress={() => fetchBoard($)} />
        </Box>
        {board === null ? (
          <Text dimColor>{ranking.isBusy ? '読み込み中' : '「更新」で最新の順位を読み込む。'}</Text>
        ) : (
          <Box flexDirection="column">
            {board.entries.map(entry => (
              <Box flexDirection="row" gap={1}>
                <Text color={entry.isYou ? 'claude' : undefined} bold={entry.isYou}>
                  {`${entry.rank}位`.padStart(4)}
                </Text>
                <Text color={entry.isYou ? 'claude' : undefined} bold={entry.isYou} wrap="truncate">
                  {entry.name}
                </Text>
                <Text dimColor>{statText(board.by, entry)}</Text>
              </Box>
            ))}
            <Text dimColor>
              {board.me !== null && !isMeShown
                ? `${ranking.name}は${board.me.rank}位(${fmt(board.players)}人中)`
                : `${fmt(board.players)}人が参加中`}
            </Text>
          </Box>
        )}
        {nameField('rank-rename', '名前を変える', '変える')}
        <Button key="rank-leave" plain dimColor label="ランキングから抜ける(記録も消す)" onPress={() => leave($)} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>ランキング</Text>
        {ranking.isBusy && <Text dimColor>通信中</Text>}
      </Box>
      {body}
      {ranking.error !== null && <Text color="error">{ranking.error}</Text>}
    </Box>
  )
}

export const register: Register = (on, options) => {
  rankingUrl = typeof options.rankingUrl === 'string' ? options.rankingUrl.trim() : ''

  on('session.start', async ($, e, next) => {
    const held = await $.state.get(GAME_REF)
    if (held.version === 0) {
      const saved = loadGame(await $.store.get(SAVE_KEY))
      const game = saved ?? newGame(await $.clock.now())
      await update($, GAME, () => game)
    }
    await $.command.register({
      name: 'tomoshibi',
      description: '灯火迷宮(Claudeの応答待ちに進むダンジョンRPG)を開く・閉じる',
      // 探索が進むのは応答中なので、応答中に打ってもすぐ開けるようにする
      immediate: true,
    })
    const player = loadPlayer(await $.store.get(PLAYER_KEY))
    await update($, RANKING, r => ({ ...r, isJoined: player?.isJoined ?? false, name: player?.name ?? '', isBusy: false }))
    // 応答中にモジュールが読み直されたときは、灯をともし直す
    if (await read($, LIT)) light($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await adoptNewerSave($)
    await update($, GAME, startRun)
    await update($, LIT, () => true)
    light($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // サブエージェントのターン終了では消さない(turn.startもメインにしか来ない)
    if (e.agentId === undefined) {
      douse()
      await update($, LIT, () => false)
      await save($)
      later($, 'ランキングへの送信', () => submitScore($, false))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    douse()
    await save($)
    return next(e)
  })

  on('command.run', { command: 'tomoshibi' }, async $ => {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isShown === true) {
      await $.ui.close({ id: PANE })
      return {}
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (opened.isPlaced) later($, 'ランキングの読み込み', () => fetchBoard($))
    return opened.isPlaced ? {} : { text: `灯火迷宮を開けなかった: ${opened.reason}` }
  })

  // 入力欄の上の帯: 応答待ちの間はドット絵の戦闘と戦況を、待っていない間は1行で前回の成果を出す
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, BAND_HIDDEN))) return next(e)
    const g = await read($, GAME)
    const isLit = await read($, LIT)
    const T = $.ui.resolve(e)
    const { Box, Text, Button } = T
    const { maxHp } = heroStats(g)
    // 端末はドット絵が16列x8行を取るので、幅と高さに余裕があるときだけ出す
    const canvas: Canvas | null =
      e.surface === 'terminal'
        ? e.props.bodyColumns >= 84 && e.props.maxRows >= 8
          ? { kind: 'raster', Raster: $.ui.resolve(e).Raster }
          : null
        : e.props.bodyColumns >= 60
          ? { kind: 'svg', Svg: $.ui.resolve(e).Svg, px: 64 }
          : null
    const battle = canvas === null ? null : scene(T, canvas, g, isLit)
    const textColumns = e.props.bodyColumns - (battle === null ? 0 : 36)
    const isWide = textColumns >= 80

    if (!isLit) {
      // 幅が足りないときは成果の文だけを切り詰め、ほかは縮めない
      return (
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            <Text dimColor>灯</Text>
            {e.props.bodyColumns >= 50 && <Text bold>{TITLE}</Text>}
            <Text dimColor>
              地下{g.floor}階・Lv{g.level}
            </Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text dimColor wrap="truncate">
              {g.run.ticks > 0 ? runSummary(g) : 'Claudeの応答を待つ間、灯がともって探索が進む'}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Button key="open" label="開く" plain onPress={() => openPane($)} />
          </Box>
        </Box>
      )
    }

    const status = (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text color="claude" bold>灯</Text>
            <Text bold>地下{g.floor}階</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text dimColor wrap="truncate">
              {biomeAt(g.floor).name}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text bold>Lv{g.level}</Text>
            <Text dimColor>経</Text>
            {bar(T, g.exp / expNeed(g.level), 8, 'suggestion')}
            <Text dimColor>体</Text>
            {bar(T, g.hp / maxHp, 8, 'error')}
            <Text dimColor>
              {fmt(g.hp)}/{fmt(maxHp)}
            </Text>
            {isWide && <Text color="warning">金{fmt(g.gold)}</Text>}
          </Box>
        </Box>
        <Box flexDirection="row" gap={2}>
          <Box flexShrink={0}>{corridor(T, g, true)}</Box>
          <Box flexShrink={1} flexGrow={1}>
            {encounter(T, g)}
          </Box>
          <Box flexShrink={0}>
            <Button key="open" label="開く" plain dimColor onPress={() => openPane($)} />
          </Box>
        </Box>
        {lastLines(T, g, battle === null ? 1 : e.surface === 'terminal' ? 6 : 2)}
      </Box>
    )
    if (battle === null) return status
    return (
      <Box flexDirection="row" gap={2}>
        {battle}
        {status}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const g = await read($, GAME)
    const isLit = await read($, LIT)
    const isBandHidden = await read($, BAND_HIDDEN)
    const ranking = await read($, RANKING)
    const T = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const { Box, Text, Button } = T
    const hero = heroStats(g)
    const canvas: Canvas =
      e.surface === 'terminal'
        ? { kind: 'raster', Raster: $.ui.resolve(e).Raster }
        : { kind: 'svg', Svg: $.ui.resolve(e).Svg, px: 96 }
    const battle = scene(T, canvas, g, isLit)
    const need = expNeed(g.level)
    const barWidth = Math.max(10, Math.min(40, e.props.bodyColumns - 4))
    const weaponCost = upgradeCost(g.weapon)
    const armorCost = upgradeCost(g.armor)
    const shortBy = (cost: number) => (game: Game) => `金が足りない(あと${fmt(cost - game.gold)})`
    // 記録は戦況のすぐ下に置くので、ペインが低くても最新の数行は見える
    const LOG_ROWS = 5

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={isLit ? 'claude' : undefined} dimColor={!isLit} bold={isLit}>
              灯
            </Text>
            <Text bold>地下{g.floor}階</Text>
            <Text dimColor wrap="truncate">
              {biomeAt(g.floor).name}・最深は地下{g.deepest}階
            </Text>
          </Box>
          {battle}
          <Box flexDirection="row" gap={2}>
            {corridor(T, g, isLit)}
            {encounter(T, g)}
          </Box>
          {!isLit && <Text dimColor>灯は消えている。Claudeが応答を作っている間だけ探索が進む。</Text>}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text bold>Lv{g.level}</Text>
            {stat(T, '経験', `${fmt(g.exp)}/${fmt(need)}`)}
          </Box>
          {bar(T, g.exp / need, barWidth, 'suggestion')}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {stat(T, '体力', `${fmt(g.hp)}/${fmt(hero.maxHp)}`, 'error')}
            {stat(T, '攻撃', fmt(hero.atk))}
            {stat(T, '防御', fmt(hero.def))}
            {stat(T, '金', fmt(g.gold), 'warning')}
          </Box>
          <Text dimColor>
            撃破{fmt(g.kills)}・敗走{fmt(g.defeats)}・探索{playTime(g.ticks)}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>記録</Text>
          {g.log.slice(-LOG_ROWS).map(line => (
            <Text color={KIND_COLOR[line.kind]} dimColor={line.kind === 'info'} wrap="truncate">
              › {line.text}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>装備</Text>
          <Box flexDirection="row" gap={1}>
            {stat(T, '武器', weaponName(g.weapon))}
            <Button
              key="weapon"
              hotkey="w"
              dimColor={g.gold < weaponCost}
              label={`鍛える(${fmt(weaponCost)}金)`}
              onPress={() => act($, buyWeapon, shortBy(weaponCost))}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            {stat(T, '防具', armorName(g.armor))}
            <Button
              key="armor"
              hotkey="a"
              dimColor={g.gold < armorCost}
              label={`鍛える(${fmt(armorCost)}金)`}
              onPress={() => act($, buyArmor, shortBy(armorCost))}
            />
          </Box>
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>育成方針</Text>
            <Text dimColor>レベルが上がるたびに3ポイント振る</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {FOCUS_LABEL.map(([focus, label]) => (
              <Button
                key={`focus-${focus}`}
                label={label}
                variant={g.focus === focus ? 'primary' : 'secondary'}
                dimColor={g.focus !== focus}
                onPress={() => act($, game => setFocus(game, focus))}
              />
            ))}
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text bold>進路</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="up" hotkey="u" label="浅い階へ" dimColor={g.floor <= 1} onPress={() => act($, game => moveFloor(game, -1))} />
            <Button
              key="down"
              hotkey="d"
              label="深い階へ"
              dimColor={g.floor >= g.deepest}
              onPress={() => act($, game => moveFloor(game, 1))}
            />
            <Button
              key="auto"
              hotkey="m"
              label={g.isAuto ? '階段を見つけたら降りる' : 'この階で稼ぐ'}
              onPress={() => act($, game => setAuto(game, !game.isAuto))}
            />
            <Button
              key="band"
              plain
              dimColor
              label={isBandHidden ? '入力欄の上に戦況を出す' : '入力欄の上の戦況を隠す'}
              onPress={() => update($, BAND_HIDDEN, hidden => !hidden)}
            />
          </Box>
        </Box>

        {rankingSection($, T, Input, ranking)}
      </Box>
    )
  })
}
