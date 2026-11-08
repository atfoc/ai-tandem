// Experiments 1-4 of the sync spike (notes/sync.md): a TLSocketRoom, the agent's headless Editor as a sync peer with
// presence, and a plain TLSyncClient (a window's stand-in), all in one process over the in-process socket pair.
// Run: node dev/sync.ts
import { installPage } from '../src/dom.ts'
import { captureConsole, docRecords, ms, sameDocs, shapeIds, sleep, stubMeasure, waitFor } from './common.ts'

installPage()
const con = captureConsole()
const { createRoom, connectEditor, connectClient } = await import('../src/room.ts')
const { buildBoard } = await import('../src/board.ts')
const { toRichText } = await import('tldraw')

const log = (...a: any[]) => console.log(...a)
let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) failures++
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

// ------------------------------------------------------------------------------------------- 1. room + editor + client
log('\n1. Room, headless editor (agent) and a plain client (window)')
let dataChanges = 0
const room = createRoom({ onDataChange: () => dataChanges++ })
let t = performance.now()
const agent = await connectEditor(room, { userId: 'agent', userName: 'Claude (agent)' })
log(`  editor connected and ready in ${ms(performance.now() - t)}`)
stubMeasure(agent.editor)
t = performance.now()
const win = await connectClient(room, { userId: 'alice', userName: 'Alice' })
log(`  plain client connected in ${ms(performance.now() - t)}`)

t = performance.now()
const ids = buildBoard(agent.editor)
const nShapes = shapeIds(agent.store).length
const nBindings = Object.keys(docRecords(agent.store)).filter((k) => k.startsWith('binding:')).length
const tBoard = await waitFor('board at client', () => sameDocs(agent.store, win.store).equal && shapeIds(win.store).length === nShapes)
log(`  buildBoard: ${nShapes} shapes, ${nBindings} bindings; client equal after ${ms(tBoard)} (from start of buildBoard: ${ms(performance.now() - t)})`)
check('client has every record of the board', sameDocs(agent.store, win.store).equal)

const latencies: Record<string, number> = {}
async function timed(name: string, change: () => void, arrived: () => boolean) {
  const t0 = performance.now()
  change()
  await waitFor(name, arrived)
  latencies[name] = performance.now() - t0
}

const winGet = (id: string) => win.store.get(id as any) as any
await timed('update text', () => agent.editor.updateShape({ id: ids.note, type: 'note', props: { richText: toRichText('Changed by the agent') } } as any),
  () => JSON.stringify(winGet(ids.note)?.props.richText).includes('Changed by the agent'))
check('update reaches client', JSON.stringify(winGet(ids.note).props.richText).includes('Changed by the agent'))

await timed('delete', () => agent.editor.deleteShape(ids.draw), () => !winGet(ids.draw))
check('delete reaches client', !winGet(ids.draw))

const arrowBefore = JSON.stringify(agent.editor.getShapePageBounds(ids.arrow))
const ellipseX = (agent.editor.getShape(ids.ellipse) as any).x
await timed('move bound geo', () => agent.editor.updateShape({ id: ids.ellipse, type: 'geo', x: ellipseX + 200, y: 500 } as any),
  () => winGet(ids.ellipse)?.x === ellipseX + 200)
const arrowAfter = JSON.stringify(agent.editor.getShapePageBounds(ids.arrow))
check('moved geo reaches client', winGet(ids.ellipse).x === ellipseX + 200)
check('arrow follows the moved geo (in the editor; bindings unchanged on the client)', arrowBefore !== arrowAfter &&
  sameDocs(agent.store, win.store).equal, `arrow page bounds ${arrowBefore} -> ${arrowAfter}`)

// the window changes a record: the editor sees it
const geo = winGet(ids.geo)
await timed('client -> editor', () => win.store.put([{ ...geo, props: { ...geo.props, color: 'orange' } }]),
  () => (agent.editor.getShape(ids.geo) as any)?.props.color === 'orange')
check('client change reaches editor', (agent.editor.getShape(ids.geo) as any).props.color === 'orange')
await waitFor('stores equal', () => sameDocs(agent.store, win.store).equal)

// a few more for a distribution
const samples: number[] = []
for (let i = 0; i < 20; i++) {
  const t0 = performance.now()
  agent.editor.updateShape({ id: ids.geo, type: 'geo', x: i * 3 } as any)
  await waitFor('sample', () => winGet(ids.geo).x === i * 3)
  samples.push(performance.now() - t0)
  await sleep(i % 2 ? 0 : 50) // half right after the previous, half after a pause (the 30 fps throttle)
}
samples.sort((a, b) => a - b)
log('  latency editor change -> client store (in-process):', Object.entries(latencies).map(([k, v]) => `${k} ${ms(v)}`).join(', '))
log(`  20 moves: min ${ms(samples[0])}, median ${ms(samples[10])}, max ${ms(samples[19])}`)

// ----------------------------------------------------------------------------------------------------- 2. presence
log('\n2. Presence: the agent as a peer')
agent.setCursor(123, 456)
agent.editor.select(ids.note, ids.geo)
const findAgentPresence = () => Object.values(win.store.serialize('presence') as Record<string, any>).find((p) => p.typeName === 'instance_presence' && p.userName === 'Claude (agent)')
const tPres = await waitFor('agent presence at client', () => {
  const p = findAgentPresence()
  return !!p && p.cursor.x === 123 && p.cursor.y === 456 && p.selectedShapeIds.length === 2
})
const p = findAgentPresence()
log(`  client got instance_presence after ${ms(tPres)}: id ${p.id}, userId ${p.userId}, userName "${p.userName}", color ${p.color}, cursor (${p.cursor.x}, ${p.cursor.y}) ${p.cursor.type}, selected ${JSON.stringify(p.selectedShapeIds)}, page ${p.currentPageId}`)
check('presence has name, cursor and selection', !!p)
// the window's own presence reaches the editor too
const winPres = await waitFor('window presence at editor', () => agent.editor.getCollaborators().some((c: any) => c.userName === 'Alice'))
log(`  editor sees the window as a collaborator after ${ms(winPres)}: ${agent.editor.getCollaborators().map((c: any) => c.userName).join(', ')}`)
// moving the cursor
const moves: number[] = []
for (let i = 0; i < 10; i++) {
  const t0 = performance.now()
  agent.setCursor(200 + i * 10, 300)
  await waitFor('cursor move', () => findAgentPresence()?.cursor.x === 200 + i * 10)
  moves.push(performance.now() - t0)
}
moves.sort((a, b) => a - b)
log(`  10 cursor moves: min ${ms(moves[0])}, median ${ms(moves[5])}, max ${ms(moves[9])}`)
check('presence is not a document record (not in snapshots of documents)', !JSON.stringify(room.getCurrentSnapshot()).includes('instance_presence:'))

// --------------------------------------------------------------------------------------------------- 3. concurrency
log('\n3. Concurrency')
// same shape, same moment
const baseNote = winGet(ids.note2)
agent.editor.updateShape({ id: ids.note2, type: 'note', props: { richText: toRichText('agent wins?') } } as any)
win.store.put([{ ...baseNote, props: { ...baseNote.props, richText: toRichText('window wins?') } }])
await sleep(300)
await waitFor('converged (same shape)', () => sameDocs(agent.store, win.store).equal)
const finalText = JSON.stringify(winGet(ids.note2).props.richText).match(/"text":"([^"]+)"/)?.[1]
const roomText = JSON.stringify(room.getRecord(ids.note2).props.richText).match(/"text":"([^"]+)"/)?.[1]
check('same shape, same moment: both stores equal and equal to the room', sameDocs(agent.store, win.store).equal && finalText === roomText, `final text "${finalText}" (last push to reach the room wins, per record property)`)
// same shape, different props
const g2 = winGet(ids.geo)
agent.editor.updateShape({ id: ids.geo, type: 'geo', x: 999 } as any)
win.store.put([{ ...g2, props: { ...g2.props, color: 'green' } }])
await sleep(300)
await waitFor('converged (props)', () => sameDocs(agent.store, win.store).equal)
const g3 = winGet(ids.geo)
check('same shape, different properties at once: both kept (patches are per property)', g3.x === 999 && g3.props.color === 'green', `x ${g3.x}, color ${g3.props.color}`)
// different shapes
const t1 = winGet(ids.text)
agent.editor.updateShape({ id: ids.inFrame, type: 'geo', props: { color: 'red' } } as any)
win.store.put([{ ...t1, x: t1.x + 77 }])
await sleep(300)
await waitFor('converged (different)', () => sameDocs(agent.store, win.store).equal)
check('different shapes at once: both kept', (agent.editor.getShape(ids.inFrame) as any).props.color === 'red' && (agent.editor.getShape(ids.text) as any).x === t1.x + 77)
// a burst: 50 interleaved edits from both sides
for (let i = 0; i < 50; i++) {
  if (i % 2) agent.editor.updateShape({ id: ids.note, type: 'note', x: i } as any)
  else { const n = winGet(ids.note); win.store.put([{ ...n, y: i }]) }
  if (i % 7 === 0) await new Promise((r) => setImmediate(r))
}
await sleep(300)
await waitFor('converged (burst)', () => sameDocs(agent.store, win.store).equal)
check('burst of 50 interleaved edits: converged', sameDocs(agent.store, win.store).equal, `note at (${winGet(ids.note).x}, ${winGet(ids.note).y})`)

// --------------------------------------------------------------------------------------------------- 4. persistence
log('\n4. Persistence')
const before = dataChanges
const tSettle = performance.now()
agent.editor.updateShape({ id: ids.text, type: 'text', x: 5 } as any)
await agent.whenSettled()
log(`  agent change acknowledged by the room (whenSettled) after ${ms(performance.now() - tSettle)}; room has it: ${room.getRecord(ids.text).x === 5}`)
await waitFor('onDataChange', () => dataChanges > before)
check('onDataChange fires on a change', dataChanges > before, `${dataChanges} calls so far`)
const presBefore = dataChanges
agent.setCursor(1, 1)
await sleep(200)
check('onDataChange does not fire on presence', dataChanges === presBefore)
const snap = room.getCurrentSnapshot()
const json = JSON.stringify(snap)
log(`  snapshot: ${json.length} bytes JSON, documentClock ${snap.documentClock}, tombstoneHistoryStartsAtClock ${snap.tombstoneHistoryStartsAtClock}, ${snap.documents.length} documents, tombstones ${JSON.stringify(snap.tombstones)}`)
const room2 = createRoom({ snapshot: JSON.parse(json) })
const snap2 = room2.getCurrentSnapshot()
const recs = (s: any) => JSON.stringify(Object.fromEntries(s.documents.map((d: any) => [d.state.id, d.state])))
check('a room from the JSON snapshot has the same records and clock', recs(snap) === recs(snap2) && snap2.documentClock === snap.documentClock)
const reader = await connectClient(room2, { userId: 'bob', userName: 'Bob' })
check('a client of the restored room gets the same records as the editor', sameDocs(reader.store, agent.store).equal)

// ------------------------------------------------------------------- 5. a lone window: solo mode and the agent's presence
log('\n5. A window alone with the agent: tldraw\'s solo mode (1 fps) vs the agent\'s presence')
// TLSyncClient throttles both its pushes and its applying of incoming diffs with an FpsScheduler: 30 fps when the
// window sees another instance_presence ('full'), 1 fps (frames of 900 ms) when it sees none ('solo', as useSync sets).
async function loneWindow(label: string, mutate: (room: any, peerAgent: any, i: number) => Promise<void> | void, withAgent: boolean, agentCursor: boolean) {
  const r = createRoom()
  const w = await connectClient(r, { userId: 'carol', userName: 'Carol' })
  const a = withAgent ? await connectEditor(r, { userId: 'agent', userName: 'Agent' }) : null
  if (a) stubMeasure(a.editor)
  if (a && agentCursor) {
    a.setCursor(0, 0)
    await waitFor('agent presence seen', () => Object.keys(w.store.serialize('presence')).some((k) => k.startsWith('instance_presence:')))
    await sleep(1000) // let the window leave its last solo frame
  }
  const lat: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    await mutate(r, a, i)
    await waitFor('arrival', () => (w.store.get('shape:lone' as any) as any)?.x === i * 10, 5000)
    lat.push(performance.now() - t0)
    await sleep(100)
  }
  log(`  ${label}: ${lat.map((x) => x.toFixed(0)).join(', ')} ms`)
  w.close(); a?.close(); r.close()
  return lat
}
const put = (i: number) => ({ id: 'shape:lone', type: 'geo', typeName: 'shape', x: i * 10, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, parentId: 'page:page', index: 'a1',
  props: { w: 100, h: 100, geo: 'rectangle', dash: 'draw', growY: 0, url: '', scale: 1, flipX: false, flipY: false, color: 'black', labelColor: 'black', fill: 'none', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: toRichText('') } })
const viaUpdateStore = await loneWindow('room.updateStore (short-lived editor style), no agent peer', async (r, _a, i) => { await r.updateStore((s: any) => s.put(put(i))) }, false, false)
const viaEditorNoCursor = await loneWindow('agent editor peer, its presence not yet derived/seen', (_r, a, i) => {
  if (a.editor.getShape('shape:lone')) a.editor.updateShape({ id: 'shape:lone', type: 'geo', x: i * 10 }); else a.editor.createShape({ ...put(i), typeName: undefined } as any)
}, true, false)
const viaEditorCursor = await loneWindow('agent editor peer with its cursor published first', (_r, a, i) => {
  if (a.editor.getShape('shape:lone')) a.editor.updateShape({ id: 'shape:lone', type: 'geo', x: i * 10 }); else a.editor.createShape({ ...put(i), typeName: undefined } as any)
}, true, true)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
check('a lone window sees updateStore changes at solo speed (~1 s)', median(viaUpdateStore) > 300, `median ${ms(median(viaUpdateStore))}`)
check('with the agent\'s presence seen, the lone window is at 30 fps', median(viaEditorCursor) < 100, `median ${ms(median(viaEditorCursor))} (no cursor yet: median ${ms(median(viaEditorNoCursor))})`)

const warn = con.take()
log(`\nconsole warnings/errors during the run: ${warn.length ? '\n  ' + warn.join('\n  ') : 'none'}`)
log(`messages agent<->room: ${JSON.stringify(agent.connection.stats)}; window<->room: ${JSON.stringify(win.connection.stats)}`)

reader.close(); win.close(); agent.close(); room.close(); room2.close()
log(`\n${failures ? `${failures} FAILED` : 'all ok'}`)
process.exit(failures ? 1 : 0)
