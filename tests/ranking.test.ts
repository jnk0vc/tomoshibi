import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Game, Ranking } from '../types'
import { newGame, TICK_MS } from '../hooks/game'
import { endpoint, loadPlayer, normalizeName, parseBoard, SUBMIT_INTERVAL_MS } from '../hooks/ranking'

const URL_OPTIONS = { options: { rankingUrl: 'https://rank.example.workers.dev/' } }

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }

/** エンジンの下層と、ランキングサーバーの代わりをテスト側で受け持つ */
function world(on: On, saved?: Game) {
  const store = new Map<string, unknown>(saved === undefined ? [] : [['save', saved]])
  const state = new Map<string, unknown>()
  const calls: Call[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('state.set', ($, e, next) => {
    state.set(e.key, e.value)
    return next(e)
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body === undefined ? undefined : (JSON.parse(e.init.body) as Record<string, unknown>)
    calls.push({ method, url: e.url, body })
    const json = (status: number, data: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) } })
    if (method === 'POST') return json(200, { ok: true, rank: { level: 2, deepest: 2, exp: 2 } })
    if (method === 'DELETE') return json(200, { ok: true })
    const me = { rank: 30, name: '灯の勇者', level: 3, deepest: 2, totalExp: 40 }
    return json(200, {
      by: new URL(e.url).searchParams.get('by'),
      entries: [{ rank: 1, name: 'ほかの冒険者', level: 99, deepest: 80, totalExp: 123456, isYou: false }],
      me,
      players: 31,
    })
  })
  return {
    calls,
    ranking: () => state.get('ranking') as Ranking | undefined,
    player: () => loadPlayer(store.get('player')),
  }
}

const PANE_PROPS = {
  title: '灯火迷宮',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const TURN_END = { answer: '', durationMs: 15000, isAborted: false, turnId: 't1', reason: 'answer' as const }

describe('ランキングの部品', () => {
  test('名前は前後の空白を除いて詰め、1〜12文字で制御文字なしに限る', () => {
    expect(normalizeName('  灯の   勇者 ')).toBe('灯の 勇者')
    expect(normalizeName('')).toBeNull()
    expect(normalizeName('   ')).toBeNull()
    expect(normalizeName('あいうえおかきくけこさしす')).toBeNull()
    expect(normalizeName('右から左‮')).toBeNull()
    expect(normalizeName('🗡'.repeat(12))).toBe('🗡'.repeat(12))
  })

  test('URLはhttps:か手元のhttp:だけ通し、末尾の/を重ねない', () => {
    expect(endpoint('https://rank.example.workers.dev/', '/v1/scores')).toBe('https://rank.example.workers.dev/v1/scores')
    expect(endpoint('http://localhost:8787', '/v1/scores')).toBe('http://localhost:8787/v1/scores')
    expect(endpoint('http://rank.example.com', '/v1/scores')).toBeNull()
    expect(endpoint('javascript:alert(1)', '/v1/scores')).toBeNull()
    expect(endpoint('not a url', '/v1/scores')).toBeNull()
  })

  test('順位表の応答は形を確かめ、名前の制御文字を落とす', () => {
    expect(parseBoard('not json')).toBeNull()
    expect(parseBoard(JSON.stringify({ by: 'level', entries: [{ rank: 'x' }], players: 1 }))).toBeNull()
    const board = parseBoard(
      JSON.stringify({
        by: 'deepest',
        entries: [{ rank: 1, name: 'a\u0007b‮c', level: 5, deepest: 9, totalExp: 100, isYou: true }],
        me: null,
        players: 1,
      }),
    )
    expect(board?.entries[0]?.name).toBe('abc')
    expect(board?.me).toBeNull()
  })
})

describe('ランキングへの参加と送信', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 名前を入れて参加すると記録を送り、順位表を出す`, URL_OPTIONS, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      const w = world(on, { ...newGame(3), level: 3, deepest: 2, totalExp: 40, kills: 6, ticks: 50 })
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
      const pane = await $.ui.mount({ plugin: 'tomoshibi', surface, component: 'Pane', requestId: 'tomoshibi', props: PANE_PROPS })

      expect(await pane.find({ text: /ランキングサーバーへ送る/ })).toBeDefined()
      await pane.input({ key: 'rank-join', text: '  灯の   勇者 ' })

      const post = w.calls.find(call => call.method === 'POST')
      expect(post?.url).toBe('https://rank.example.workers.dev/v1/scores')
      expect(post?.body).toMatchObject({ name: '灯の 勇者', level: 3, deepest: 2, totalExp: 40, kills: 6, ticks: 50 })
      expect(post?.body?.playerId).toBe(w.player()?.id)
      expect(w.calls.some(call => call.method === 'GET' && call.url.includes(`me=${w.player()?.id}`))).toBe(true)
      expect(w.ranking()?.isJoined).toBe(true)

      expect(await pane.find({ text: /ほかの冒険者/ })).toBeDefined()
      expect(await pane.find({ text: /30位\(31人中\)/ })).toBeDefined()

      await pane.press({ key: 'rank-deepest' })
      expect(w.calls.at(-1)?.url).toContain('by=deepest')
      await pane.unmount()
    })
  }

  test('応答待ちが終わるたびに送るが、前回から60秒未満なら送らない', URL_OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: 5_000_000 })
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'tomoshibi', surface: 'terminal', component: 'Pane', requestId: 'tomoshibi', props: PANE_PROPS })
    await pane.input({ key: 'rank-join', text: '勇者' })
    await pane.unmount()
    const posts = () => w.calls.filter(call => call.method === 'POST').length
    expect(posts()).toBe(1)

    await $.turn.start({ text: 'a', turnId: 't1' })
    await clock.advance(TICK_MS * 4)
    await $.turn.complete(TURN_END)
    await clock.settle()
    expect(posts()).toBe(1)

    await $.turn.start({ text: 'b', turnId: 't2' })
    await clock.advance(SUBMIT_INTERVAL_MS)
    await $.turn.complete({ ...TURN_END, turnId: 't2' })
    await clock.settle()
    expect(posts()).toBe(2)
    expect(w.calls.filter(call => call.method === 'POST').at(-1)?.body?.ticks).toBeGreaterThan(4)
  })

  test('ランキングから抜けるとサーバーの記録を消し、参加前の表示に戻る', URL_OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'tomoshibi', surface: 'desktop', component: 'Pane', requestId: 'tomoshibi', props: PANE_PROPS })
    await pane.input({ key: 'rank-join', text: '勇者' })
    const id = w.player()?.id
    await pane.press({ key: 'rank-leave' })
    const del = w.calls.find(call => call.method === 'DELETE')
    expect(del?.body).toEqual({ playerId: id, token: w.player()?.token })
    expect(w.ranking()?.isJoined).toBe(false)
    expect(w.player()?.isJoined).toBe(false)
    expect(await pane.find({ key: 'rank-join' })).toBeDefined()
    await pane.unmount()
  })

  test('URLが設定されていなければ通信せず、設定方法を出す', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ plugin: 'tomoshibi', surface: 'terminal', component: 'Pane', requestId: 'tomoshibi', props: PANE_PROPS })
    expect(await pane.find({ text: /rankingUrl/ })).toBeDefined()
    expect(await pane.find({ key: 'rank-join' })).toBeUndefined()
    await $.turn.start({ text: 'a', turnId: 't1' })
    await $.turn.complete(TURN_END)
    expect(w.calls).toHaveLength(0)
    await pane.unmount()
  })
})
