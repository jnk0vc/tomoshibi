import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { newGame, TICK_MS } from '../hooks/game'
import { artFor, heroRecolor, rasterCells, svgSource } from '../hooks/sprites'

const DEFAULT = 0x01000000

/** Rasterのセル列(base64のu32三つ組)を[文字, 前景, 背景]の並びに戻す */
function decode(cells: string): [number, number, number][] {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const out: [number, number, number][] = []
  for (let i = 0; i < bytes.length; i += 12) {
    out.push([view.getUint32(i, true), view.getUint32(i + 4, true), view.getUint32(i + 8, true)])
  }
  return out
}

const blank = '.'.repeat(16)

describe('ドット絵の変換', () => {
  test('端末用は1セルに上下2ドットを詰め、透明は端末の既定色にする', () => {
    const rows = [`kw.${'.'.repeat(13)}`, `w.k${'.'.repeat(13)}`, ...Array.from({ length: 14 }, () => blank)]
    const cells = decode(rasterCells(rows))
    expect(cells).toHaveLength(16 * 8)
    expect(cells[0]).toEqual([0x2580, 0x1a1220, 0xfcfcfc])
    expect(cells[1]).toEqual([0x2580, 0xfcfcfc, DEFAULT])
    expect(cells[2]).toEqual([0x2584, 0x1a1220, DEFAULT])
    expect(cells[3]).toEqual([0x20, DEFAULT, DEFAULT])
  })

  test('主人公の剣と鎧は装備の段階で塗り替わる', () => {
    const hero = artFor('@')
    expect(hero).toBeDefined()
    const plain = svgSource(hero ?? [], { recolor: heroRecolor(0, 0) })
    const strong = svgSource(hero ?? [], { recolor: heroRecolor(85, 85) })
    expect(plain).not.toBe(strong)
    expect(strong).toContain('#f8b800')
  })

  test('持ち上げると1ドット上に、反転すると左右が入れ替わる', () => {
    const rows = [blank, ...Array.from({ length: 14 }, () => blank), `k${'.'.repeat(15)}`]
    expect(svgSource(rows)).toContain('<rect x="0" y="15"')
    expect(svgSource(rows, { isLifted: true })).toContain('<rect x="0" y="14"')
    expect(svgSource(rows, { isMirrored: true })).toContain('<rect x="15" y="15"')
  })
})

function world(on: On) {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

describe('戦闘の絵', () => {
  test('端末の帯は幅と高さが足りればRasterで主人公と敵を描き、足りなければ文字だけにする', async ($, on) => {
    const clock = mock.clock(on)
    world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'a', turnId: 't1' })
    await clock.advance(TICK_MS * 2)

    const wide = await $.ui.mount({ plugin: 'tomoshibi', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await wide.find({ type: 'Raster', key: 'hero' })).toBeDefined()
    expect(await wide.find({ type: 'Raster', key: 'foe' })).toBeDefined()
    await wide.unmount()

    const narrow = await $.ui.mount({
      plugin: 'tomoshibi',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND, bodyColumns: 70 },
    })
    expect(await narrow.find({ type: 'Raster' })).toBeUndefined()
    expect(await narrow.find({ text: /地下1階/ })).toBeDefined()
    await narrow.unmount()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  })

  test('デスクトップの帯とペインはSvgで描き、読み上げ用の説明を付ける', async ($, on) => {
    const clock = mock.clock(on)
    world(on)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'a', turnId: 't1' })
    await clock.advance(TICK_MS * 2)
    const band = await $.ui.mount({ plugin: 'tomoshibi', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const svg = await band.find({ type: 'Svg' })
    expect(svg?.props.alt).toMatch(/勇者/)
    await band.unmount()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

    const pane = await $.ui.mount({
      plugin: 'tomoshibi',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'tomoshibi',
      props: { title: '灯火迷宮', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect((await pane.findAll({ type: 'Svg' })).length).toBe(2)
    await pane.unmount()
    expect(newGame(1).level).toBe(1)
  })
})
