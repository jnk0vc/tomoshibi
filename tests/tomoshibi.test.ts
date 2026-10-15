import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Game } from '../types'
import { buyWeapon, expNeed, loadGame, moveFloor, newGame, tick, TICK_MS, upgradeCost } from '../hooks/game'

/** エンジンの下層をテスト側で受け持つ。ストアと状態の書き込みを覗けるように返す */
function world(on: On, saved?: Game) {
  const store = new Map<string, unknown>(saved === undefined ? [] : [['save', saved]])
  const state = new Map<string, unknown>()
  const commands: unknown[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('state.set', ($, e, next) => {
    state.set(e.key, e.value)
    return next(e)
  })
  on('command.register', ($, e) => {
    commands.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return {
    commands,
    game: () => state.get('game') as Game | undefined,
    isLit: () => state.get('isLit') as boolean | undefined,
    saved: () => loadGame(store.get('save')),
    /** 別のセッションがストアに書いたことにする */
    put: (key: string, value: unknown) => store.set(key, value),
  }
}

function play(g: Game, ticks: number): Game {
  let game = g
  for (let i = 0; i < ticks; i++) game = tick(game)
  return game
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
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

describe('ゲームの進み方', () => {
  test('探索を続けるとレベルも到達階も伸び続ける', () => {
    const early = play(newGame(7), 2400) // 応答待ち1時間ぶん
    const later = play(early, 7200) // さらに3時間
    expect(early.level).toBeGreaterThan(20)
    expect(later.level).toBeGreaterThan(early.level)
    expect(later.deepest).toBeGreaterThan(early.deepest)
    expect(later.totalExp).toBeGreaterThan(early.totalExp)
  })

  test('敗れても経験値と金は失わず、2階上へ退いて休むだけ', () => {
    let g: Game = { ...newGame(3), floor: 40, deepest: 40, gold: 123, exp: 5, totalExp: 99 }
    while (g.defeats === 0) g = tick(g)
    expect(g.floor).toBe(38)
    expect(g.phase).toBe('rest')
    expect(g.gold).toBeGreaterThanOrEqual(123)
    expect(g.totalExp).toBeGreaterThanOrEqual(99)
    expect(g.level).toBe(1)
  })

  test('経験値が貯まるとレベルが上がり、育成方針どおりに振られる', () => {
    let g: Game = { ...newGame(5), focus: 'atk' }
    while (g.level === 1) g = tick(g)
    expect(g.points).toEqual({ atk: 3, def: 0, hp: 0 })
    expect(g.exp).toBeLessThan(expNeed(2))
  })

  test('金が足りなければ鍛えられず、足りれば鍛えた分だけ減る', () => {
    const poor = newGame(1)
    expect(buyWeapon(poor)).toBeNull()
    const rich = buyWeapon({ ...poor, gold: 1000 })
    expect(rich?.weapon).toBe(1)
    expect(rich?.gold).toBe(1000 - upgradeCost(0))
  })

  test('最深階より深くへは移れない', () => {
    const g = { ...newGame(1), floor: 5, deepest: 5 }
    expect(moveFloor(g, 1)).toBe(g)
    expect(moveFloor(g, -1).floor).toBe(4)
  })

  test('壊れたセーブは読み込まず、正しいセーブはそのまま戻る', () => {
    expect(loadGame(undefined)).toBeNull()
    expect(loadGame({ v: 2 })).toBeNull()
    expect(loadGame({ ...newGame(1), level: -1 })).toBeNull()
    expect(loadGame({ ...newGame(1), points: null })).toBeNull()
    const saved = JSON.parse(JSON.stringify(play(newGame(11), 300))) as unknown
    expect(loadGame(saved)).toEqual(saved)
  })
})

describe('セッションでの動き', () => {
  test('保存したゲームを読み込み、応答待ちの間だけ進めて、終わったら保存する', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on, { ...newGame(9), level: 5, rev: 3 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.game()?.level).toBe(5)

    await clock.advance(TICK_MS * 5)
    expect(w.game()?.ticks).toBe(0)

    await $.turn.start({ text: 'テストを直して', turnId: 't1' })
    expect(w.isLit()).toBe(true)
    await clock.advance(TICK_MS * 10)
    expect(w.game()?.ticks).toBe(10)

    await $.turn.complete(TURN_END)
    expect(w.isLit()).toBe(false)
    await clock.advance(TICK_MS * 10)
    expect(w.game()?.ticks).toBe(10)

    const stored = w.saved()
    expect(stored?.level).toBe(5)
    expect(stored?.ticks).toBe(10)
    expect(stored?.run.ticks).toBe(10)
    expect(stored?.rev).toBeGreaterThan(3)
  })

  test('放置していたセッションを閉じても、別セッションの新しいセーブを上書きしない', async ($, on) => {
    mock.clock(on)
    const w = world(on, { ...newGame(4), level: 3, rev: 15 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.game()?.rev).toBe(15)
    // 別のセッションがこの間に遊んで保存した
    w.put('save', { ...newGame(4), level: 40, rev: 300 })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } })
    expect(w.saved()?.rev).toBe(300)
    expect(w.saved()?.level).toBe(40)
    expect(w.game()?.level).toBe(40)
  })

  test('/tomoshibiは応答中でもすぐ動くように登録する', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.commands).toContainEqual(expect.objectContaining({ name: 'tomoshibi', immediate: true }))
  })

  test('サブエージェントのターン終了では灯が消えない', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: '調べて', turnId: 't1' })
    await $.turn.complete({ ...TURN_END, turnId: 'sub', agentId: 'agent-1' })
    await clock.advance(TICK_MS * 4)
    expect(w.game()?.ticks).toBe(4)
    await $.turn.complete(TURN_END)
  })
})

describe('描画', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 待っていない間は1行、待っている間は戦況を出す`, async ($, on) => {
      const clock = mock.clock(on)
      world(on)
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

      const idle = await $.ui.mount({ plugin: 'tomoshibi', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await idle.find({ key: 'open' })).toBeDefined()
      expect(await idle.find({ text: /灯火迷宮/ })).toBeDefined()
      await idle.unmount()

      await $.turn.start({ text: 'ビルドして', turnId: 't1' })
      await clock.advance(TICK_MS * 3)
      const lit = await $.ui.mount({
        plugin: 'tomoshibi',
        surface,
        component: 'AbovePrompt',
        props: { ...BAND_PROPS, isWorking: true },
      })
      expect(await lit.find({ text: /地下1階/ })).toBeDefined()
      expect(await lit.find({ text: '@' })).toBeDefined()
      await lit.unmount()
      await $.turn.complete(TURN_END)
    })

    test(`${surface}: ペインで武器を鍛えると金が減って武器が強くなる`, async ($, on) => {
      mock.clock(on)
      const w = world(on, { ...newGame(2), gold: 500 })
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

      const pane = await $.ui.mount({
        plugin: 'tomoshibi',
        surface,
        component: 'Pane',
        requestId: 'tomoshibi',
        props: PANE_PROPS,
      })
      await pane.press({ key: 'weapon' })
      const g = w.game()
      expect(g?.weapon).toBe(1)
      expect(g?.gold).toBe(500 - upgradeCost(0))
      expect(await pane.find({ text: /木の棒\+1/ })).toBeDefined()

      await pane.press({ key: 'focus-def' })
      expect(w.game()?.focus).toBe('def')
      await pane.unmount()
    })
  }
})
