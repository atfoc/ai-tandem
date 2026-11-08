// Risk 8.5: what a sync client does when it reconnects, to the same room or to a room restored from an older snapshot.
// Scenarios a-d of notes/sync.md, each for a plain client (a window) and for the headless editor (the agent), and each
// restored room both from the raw snapshot and from snapshotForRestore() (the clock jumped, history reset).
// Run: node dev/reconnect.ts   (VERBOSE=1 also prints tldraw's console output as it happens)
import { loadDom } from '../src/dom-pick.ts'
import { captureConsole, sameDocs, sleep, stubMeasure, waitFor } from './common.ts'

;(await loadDom()).installPage()
const con = captureConsole()
const { createRoom, connectEditor, connectClient, snapshotForRestore } = await import('../src/room.ts')
const { toRichText } = await import('tldraw')

const log = (...a: any[]) => console.log(...a)
type Kind = 'client' | 'editor'

// ------------------------------------------------------------------------------------------------------- helpers
function geo(id: string, x: number, color = 'black', index = 'a1') {
  return { id, type: 'geo', typeName: 'shape', x, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, parentId: 'page:page', index,
    props: { w: 100, h: 100, geo: 'rectangle', dash: 'draw', growY: 0, url: '', scale: 1, flipX: false, flipY: false, color, labelColor: 'black', fill: 'none', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: toRichText('') } }
}

interface Actor {
  name: string
  peer: any
  handshakes: any[]
  create(id: string, x: number, index: string): void
  update(id: string, patch: { x?: number; color?: string }): void
  del(id: string): void
}

function tapFor(list: any[]) {
  return (dir: string, data: string) => {
    if (dir !== 'toClient' || !data.startsWith('{"type":"connect"')) return
    const m = JSON.parse(data)
    list.push({ hydrationType: m.hydrationType, serverClock: m.serverClock, diffIds: Object.keys(m.diff).filter((k) => !k.startsWith('instance_presence')) })
  }
}

async function makeActor(room: any, kind: Kind, name: string): Promise<Actor> {
  const handshakes: any[] = []
  const opts = { userId: name.toLowerCase(), userName: name, connection: { tap: tapFor(handshakes) } }
  if (kind === 'editor') {
    const peer = await connectEditor(room, opts)
    stubMeasure(peer.editor)
    const ed = peer.editor
    return {
      name, peer, handshakes,
      create: (id, x, index) => { const r: any = geo(id, x, 'black', index); delete r.typeName; ed.createShape(r) },
      update: (id, p) => ed.updateShape({ id, type: 'geo', ...(p.x !== undefined ? { x: p.x } : {}), ...(p.color ? { props: { color: p.color } } : {}) } as any),
      del: (id) => ed.deleteShape(id as any),
    }
  }
  const peer = await connectClient(room, opts)
  const st = peer.store
  return {
    name, peer, handshakes,
    create: (id, x, index) => st.put([geo(id, x, 'black', index) as any]),
    update: (id, p) => { const r: any = st.get(id as any); st.put([{ ...r, ...(p.x !== undefined ? { x: p.x } : {}), props: { ...r.props, ...(p.color ? { color: p.color } : {}) } }]) },
    del: (id) => st.remove([id as any]),
  }
}

/** Waits until the client has nothing unsent or unacknowledged. */
async function settled(peer: any) {
  const c = peer.client as any
  await waitFor('acknowledged', () => c.isConnectedToRoom && c.pendingPushRequests.length === 0 && !c.unsentChanges.nextDiff, 3000)
  await sleep(80)
}

const roomView = (room: any) => ({ get: (id: string) => room.getRecord(id) })
function describe(src: any, ids: string[]) {
  return ids.map((id) => {
    const r = src.get(id)
    return r ? `${id.slice(6)}(x${r.x},${r.props.color})` : `${id.slice(6)}:—`
  }).join(' ')
}
function clockOf(peer: any) {
  return (peer.client as any).lastServerClock
}

const rows: string[] = []
async function report(title: string, ids: string[], parts: { actor: Actor; observer?: Actor; room: any; extra?: string }) {
  const { actor, observer, room } = parts
  // wait for convergence (up to 3 s): after a reconnect a client sees no other presence for a moment, drops to tldraw's
  // solo mode (1 fps) and applies or resends up to ~900 ms later
  const roomDocsNow = () => Object.fromEntries(room.getCurrentSnapshot().documents.map((d: any) => [d.state.id, d.state]))
  const eq = (p: any) => sameDocs({ serialize: () => p.store.serialize('document') }, { serialize: roomDocsNow }).equal
  const t0 = performance.now()
  let converged = true
  try { await waitFor('converged', () => eq(actor.peer) && (!observer || eq(observer.peer)), 3000) } catch { converged = false }
  const tConv = performance.now() - t0
  const a = actor.peer, roomDocs = room.getCurrentSnapshot()
  const roomStoreLike = { serialize: () => Object.fromEntries(roomDocs.documents.map((d: any) => [d.state.id, d.state])) }
  const actorVsRoom = sameDocs({ serialize: () => a.store.serialize('document') }, roomStoreLike)
  const obsVsRoom = observer ? sameDocs({ serialize: () => observer.peer.store.serialize('document') }, roomStoreLike) : null
  const hs = actor.handshakes.at(-1)
  const warns = con.take()
  log(`  ${actor.name}: ${describe(a.store, ids)}`)
  if (observer) log(`  ${observer.name}: ${describe(observer.peer.store, ids)}`)
  log(`  room: ${describe(roomView(room), ids)}   (room clock ${room.getCurrentDocumentClock()})`)
  log(`  last connect answer to ${actor.name}: ${hs ? `hydrationType ${hs.hydrationType}, serverClock ${hs.serverClock}, doc diff [${hs.diffIds.join(', ')}]` : 'none'}`)
  log(`  ${actor.name} status: socket ${a.connection.client.connectionStatus}, connected ${a.client.isConnectedToRoom}, lastServerClock ${clockOf(a)}, sync errors ${JSON.stringify(a.errors)}`)
  log(`  ${actor.name} == room: ${actorVsRoom.equal ? 'yes' : `NO, differs in ${actorVsRoom.diff.join(', ')}`}${obsVsRoom ? `;  ${observer!.name} == room: ${obsVsRoom.equal ? 'yes' : `NO, differs in ${obsVsRoom.diff.join(', ')}`}` : ''}`)
  log(`  console: ${warns.length ? warns.join(' | ') : 'nothing'}`)
  log(`  ${converged ? `converged ${tConv.toFixed(0)} ms after the reconnect settled` : 'NOT converged after 3 s'}`)
  if (parts.extra) log(`  ${parts.extra}`)
  rows.push(`${title} | ${actorVsRoom.equal && (!obsVsRoom || obsVsRoom.equal) ? 'consistent' : 'DIVERGED'} | ${hs?.hydrationType ?? '-'} | ${describe(a.store, ids)} | ${describe(roomView(room), ids)}`)
}

const IDS = ['shape:s1', 'shape:s2', 'shape:c1new', 'shape:c2new', 'shape:gone']

/** A room with the base shapes, the actor and an observer (another window) on it, everyone settled. */
async function setup(kind: Kind) {
  const room1 = createRoom()
  const actor = await makeActor(room1, kind, kind === 'editor' ? 'Agent' : 'A')
  const observer = await makeActor(room1, 'client', 'O')
  actor.create('shape:s1', 0, 'a1')
  actor.create('shape:s2', 200, 'a2')
  actor.create('shape:gone', 400, 'a3')
  await settled(actor.peer)
  await waitFor('observer has base', () => !!observer.peer.store.get('shape:gone'))
  return { room1, actor, observer }
}

async function reconnectBoth(actor: Actor, observer: Actor, room: any, observerFirst = false) {
  const go = async (p: Actor) => {
    const w = p.peer.whenConnected()
    p.peer.connection.restore(room)
    await w
  }
  if (observerFirst) { await go(observer); await go(actor) } else { await go(actor); await go(observer) }
  await sleep(300)
}

// ------------------------------------------------------------------------------------------------------ scenarios
async function scenarioA(kind: Kind, fix: boolean) {
  const title = `a ${kind} ${fix ? 'restored+jump' : 'restored raw'}`
  log(`\n[${title}] S1 saved; ${kind} makes C1 (acknowledged); room closed, new room from S1; reconnect`)
  const { room1, actor, observer } = await setup(kind)
  const S1 = JSON.parse(JSON.stringify(room1.getCurrentSnapshot()))
  actor.update('shape:s1', { x: 111 }) // C1
  actor.create('shape:c1new', 600, 'a4')
  actor.del('shape:gone')
  await settled(actor.peer)
  await waitFor('observer has C1', () => !!observer.peer.store.get('shape:c1new'))
  log(`  S1 clock ${S1.documentClock}; after C1: room clock ${room1.getCurrentDocumentClock()}, ${actor.name} lastServerClock ${clockOf(actor.peer)}`)
  room1.close()
  await sleep(50)
  const room2 = createRoom({ snapshot: fix ? snapshotForRestore(S1) : S1 })
  await reconnectBoth(actor, observer, room2)
  await report(title, IDS, { actor, observer, room: room2 })
  actor.peer.close(); observer.peer.close(); room2.close()
}

async function scenarioA2(kind: Kind, fix: boolean, equal = false) {
  const title = `${equal ? 'a3' : 'a2'} ${kind} ${fix ? 'restored+jump' : 'restored raw'}`
  log(`\n[${title}] as a, but the observer reconnects first and makes changes until the restored room's clock ${equal ? 'equals' : 'passes'} ${kind}'s`)
  const { room1, actor, observer } = await setup(kind)
  const S1 = JSON.parse(JSON.stringify(room1.getCurrentSnapshot()))
  actor.update('shape:s1', { x: 111 })
  actor.create('shape:c1new', 600, 'a4')
  actor.del('shape:gone')
  await settled(actor.peer)
  await waitFor('observer has C1', () => !!observer.peer.store.get('shape:c1new'))
  const actorClock = clockOf(actor.peer)
  room1.close()
  await sleep(50)
  const room2 = createRoom({ snapshot: fix ? snapshotForRestore(S1) : S1 })
  const w = observer.peer.whenConnected(); observer.peer.connection.restore(room2); await w
  await sleep(100)
  // the observer was hydrated with wipe_all (its clock is ahead of room2's) and so lost C1; it edits s2 a few times
  let n = 0
  while ((equal ? room2.getCurrentDocumentClock() < actorClock : room2.getCurrentDocumentClock() <= actorClock + 1) && n < 50) {
    observer.update('shape:s2', { x: 200 + ++n })
    await settled(observer.peer)
  }
  log(`  ${actor.name} lastServerClock ${actorClock}; room2 clock now ${room2.getCurrentDocumentClock()} after ${n} edits by O`)
  const w2 = actor.peer.whenConnected(); actor.peer.connection.restore(room2); await w2
  await sleep(300)
  await report(title, IDS, { actor, observer, room: room2 })
  actor.peer.close(); observer.peer.close(); room2.close()
}

async function scenarioB(kind: Kind, fix: boolean) {
  const title = `b ${kind} ${fix ? 'restored+jump' : 'restored raw'}`
  log(`\n[${title}] as a, and ${kind} makes C2 while disconnected (never acknowledged), then reconnects to the room from S1`)
  const { room1, actor, observer } = await setup(kind)
  const S1 = JSON.parse(JSON.stringify(room1.getCurrentSnapshot()))
  actor.update('shape:s1', { x: 111 }) // C1
  actor.create('shape:c1new', 600, 'a4')
  actor.del('shape:gone')
  await settled(actor.peer)
  room1.close()
  await sleep(50)
  actor.update('shape:s2', { color: 'red' }) // C2: update a record the room has
  actor.create('shape:c2new', 800, 'a5') //     create a new record
  actor.update('shape:c1new', { color: 'green' }) // update a record only C1 made (the restored room has not got it)
  actor.update('shape:s1', { color: 'blue' }) //  another property of the record C1 changed
  log(`  offline ${actor.name}: ${describe(actor.peer.store, IDS)}`)
  const room2 = createRoom({ snapshot: fix ? snapshotForRestore(S1) : S1 })
  await reconnectBoth(actor, observer, room2)
  await report(title, IDS, { actor, observer, room: room2 })
  actor.peer.close(); observer.peer.close(); room2.close()
}

async function scenarioC(kind: Kind) {
  const title = `c ${kind} same room`
  log(`\n[${title}] connection drops (room alive), ${kind} edits while cut off, O edits too, ${kind} reconnects to the same room`)
  const { room1, actor, observer } = await setup(kind)
  actor.peer.connection.cut()
  await sleep(50)
  actor.update('shape:s1', { x: 333 })
  actor.create('shape:c2new', 800, 'a5')
  actor.del('shape:gone')
  observer.update('shape:s2', { color: 'violet' })
  observer.update('shape:s1', { color: 'orange' }) // a different property of a record the actor changes offline
  await settled(observer.peer)
  const w = actor.peer.whenConnected(); actor.peer.connection.restore(); await w
  await sleep(300)
  await report(title, IDS, { actor, observer, room: room1 })
  actor.peer.close(); observer.peer.close(); room1.close()
}

async function scenarioC2(kind: Kind) {
  const title = `c2 ${kind} same room, conflict`
  log(`\n[${title}] as c, but O changes the same property (s1.x) while ${kind} is cut off; ${kind}'s offline value arrives last`)
  const { room1, actor, observer } = await setup(kind)
  actor.peer.connection.cut()
  actor.update('shape:s1', { x: 333 })
  observer.update('shape:s1', { x: 444 })
  await settled(observer.peer)
  const w = actor.peer.whenConnected(); actor.peer.connection.restore(); await w
  await sleep(300)
  await report(title, IDS, { actor, observer, room: room1 })
  actor.peer.close(); observer.peer.close(); room1.close()
}

async function scenarioD(kind: Kind) {
  const title = `d ${kind} catch-up`
  log(`\n[${title}] ${kind} away (cut), O changes things, ${kind} reconnects: normal catch-up`)
  const { room1, actor, observer } = await setup(kind)
  actor.peer.connection.cut()
  observer.update('shape:s1', { x: 555 })
  observer.create('shape:c1new', 600, 'a4')
  observer.del('shape:gone')
  await settled(observer.peer)
  const w = actor.peer.whenConnected(); actor.peer.connection.restore(); await w
  await sleep(300)
  await report(title, IDS, { actor, observer, room: room1 })
  actor.peer.close(); observer.peer.close(); room1.close()
}

async function scenarioE(kind: Kind) {
  const title = `e ${kind} restored, nobody newer`
  log(`\n[${title}] room restarted from an up-to-date save (nothing lost): ${kind} reconnects`)
  const { room1, actor, observer } = await setup(kind)
  actor.update('shape:s1', { x: 111 })
  await settled(actor.peer)
  const S = JSON.parse(JSON.stringify(room1.getCurrentSnapshot()))
  room1.close()
  await sleep(50)
  const room2 = createRoom({ snapshot: S })
  await reconnectBoth(actor, observer, room2)
  await report(title, IDS, { actor, observer, room: room2 })
  actor.peer.close(); observer.peer.close(); room2.close()
}

for (const kind of ['client', 'editor'] as Kind[]) {
  for (const fix of [false, true]) {
    await scenarioA(kind, fix)
    await scenarioA2(kind, fix)
    await scenarioA2(kind, fix, true)
    await scenarioB(kind, fix)
  }
  await scenarioC(kind)
  await scenarioC2(kind)
  await scenarioD(kind)
  await scenarioE(kind)
}

log('\nSummary: scenario | outcome | last hydration | actor after | room after')
for (const r of rows) log('  ' + r)
process.exit(0)
