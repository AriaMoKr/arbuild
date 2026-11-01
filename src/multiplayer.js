import * as THREE from 'three';
import { createTogether } from 'layersharedsession/together.js';
import { isRoom, roomFromUrl } from 'layersharedsession/room.js';
import { createBuffer } from 'layersharedsession/pose.js';
import { createAvatars } from 'layersharedsession/avatars.js';
import { APP_ID, PAGE_ID, STATE_HZ, electHost, foldMarks, inputActive, isInput, isSiteMessage } from './sharedFrame.js';
import { SPILL_CAPACITY, TRACK_CAPACITY } from './groundMarks.js';

const MARK_CAPS = { t: TRACK_CAPACITY, s: SPILL_CAPACITY }; // the slots the dig site has for each kind of mark

// The shared session, as the dig site runs one: AriaMoKr/layersharedsession (peer to peer over
// WebRTC, found through public relays, the same rooms as the other sites on the origin) through
// its together.js, which sends this visitor's pose, draws the others (their head and hands) and
// counts who's here. What's special here is the frame: poses go out expressed in the frame the
// app sets each frame (setFrame: the dig site's on the table, see src/sharedFrame.js), through
// stand-ins for the camera and the controllers whose world matrices are the real ones moved
// into that frame; and the others are drawn under a group placed at that frame.
//
// On top of that, two channels of the app's own: 'site', the host's state of the dig site
// (STATE_HZ a second, src/sharedFrame.js's isSiteMessage), and 'input', each guest's sticks and
// buttons. The host is elected (electHost) from everyone on this page, so it changes by itself
// when the host leaves.

/** The session's name for the room in the address, if any. */
export function roomInAddress() {
  return roomFromUrl(location.href);
}

/** Whether `text` is a room code someone could have been given (the layer's rules). */
export function isRoomCode(text) {
  return isRoom(String(text ?? '').trim().toLowerCase());
}

export class Multiplayer {
  /**
   * `hands`: () => the XR controllers as [{ controller, source }], for the avatars' hands.
   * `floor`: () => the floor's height in the scene, or null when it isn't known (a `local`
   * reference space), for the ring under each visitor; it goes on the table top then.
   */
  constructor({ scene, camera, renderer, hands = null, floor = () => 0, now = () => performance.now() }) {
    this.camera = camera;
    this.renderer = renderer;
    this.hands = hands;
    this.floor = floor;
    this.now = now;
    // The shared frame in the scene: the avatars are drawn under it.
    this.frame = new THREE.Group();
    this.frame.name = 'shared-frame';
    scene.add(this.frame);
    this.frameInverse = new THREE.Matrix4();
    this.framed = false;
    // Stand-ins whose world matrices are the real camera's and controllers', in the shared frame.
    const standIn = () => {
      const o = new THREE.Object3D();
      o.matrixAutoUpdate = false;
      o.matrixWorldAutoUpdate = false;
      return o;
    };
    this.headStandIn = standIn();
    this.handStandIns = [standIn(), standIn()];
    this.handSources = [null, null];
    const sources = this.handSources;
    const handList = this.handStandIns.map((controller, i) => ({
      controller,
      get source() {
        return sources[i];
      },
    }));
    this.together = createTogether({
      appId: APP_ID,
      page: PAGE_ID,
      camera: this.headStandIn,
      renderer,
      hands: () => handList,
      // The ring under a visitor goes on the floor (the frame sits on the table top).
      avatars: { parent: this.frame, ground: () => this.groundInFrame() },
      now,
    });
    this.latestState = null; // the host's last site message, for a guest
    this.hostMarks = null; // the host's tracks and dirt marks, every message's folded in (sharedFrame.js foldMarks), for a guest
    this.stateFrom = null; // which member it came from
    this.inputs = new Map(); // peer id -> { input, at }: the guests' latest inputs, for the host
    this.sequence = 0; // of the site messages sent
    this.nextSendAt = 0;
    this.lastInputSent = null;
    this.listeners = new Map();
    this.together.on('change', () => this.emit('change'));
    this.together.on('notice', (n) => this.emit('notice', n));
    this.together.on('session', (session) => this.wire(session));
  }

  // ---------- the session ----------

  start(room) {
    this.together.start(room);
  }

  stop() {
    this.latestState = null;
    this.hostMarks = null;
    this.inputs.clear();
    return this.together.stop();
  }

  pause() {
    return this.together.pause();
  }

  resume() {
    this.together.resume();
  }

  get active() {
    return this.together.active;
  }

  get room() {
    return this.together.room;
  }

  get inviteLink() {
    return this.together.inviteLink;
  }

  get self() {
    return this.together.self;
  }

  /** Everyone else here (on this page), as the session has them. */
  people() {
    return this.together.people().filter((p) => p.page === PAGE_ID);
  }

  company() {
    return this.together.company();
  }

  condition() {
    return this.together.condition();
  }

  wave() {
    return this.together.wave();
  }

  /** The member who runs the simulation; this visitor when alone. */
  get host() {
    return electHost(this.self.memberId, this.together.people());
  }

  get isHost() {
    return !this.together.session || this.host === this.self.memberId;
  }

  /** A guest with the host's state in hand: the app shows that instead of simulating. */
  get following() {
    return Boolean(this.together.session) && !this.isHost && (this.received ?? 0) > 0;
  }

  on(type, fn) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, detail) {
    const set = this.listeners.get(type);
    if (set) for (const fn of [...set]) fn(detail);
  }

  /** A shared value (last write wins), or `fallback` out of a session. */
  getShared(key, fallback) {
    return this.together.session ? this.together.session.get(key, fallback) : fallback;
  }

  setShared(key, value) {
    this.together.session?.set(key, value);
  }

  // ---------- each frame ----------

  /** Where the shared frame is in the scene ({ x, y, z, yaw }); the avatars go under it, the poses come out of it. */
  setFrame({ x, y, z, yaw }) {
    this.frame.position.set(x, y, z);
    this.frame.rotation.set(0, yaw, 0);
    this.frame.updateMatrixWorld(true);
    this.frameInverse.copy(this.frame.matrixWorld).invert();
    this.framed = true;
  }

  /** The floor's height in the shared frame (which is only turned about y), or the table top's when unknown. */
  groundInFrame() {
    const f = this.floor();
    return f === null || f === undefined ? 0 : f - this.frame.position.y;
  }

  /** The frame is gone (no table): send no pose, draw no one. */
  clearFrame() {
    this.framed = false;
    this.frame.visible = false;
  }

  /**
   * Every frame. With the frame set this visitor's pose goes out and the others are placed;
   * `input` (packInput's shape, or null) is sent when this visitor is a guest.
   */
  update(now, input = null) {
    if (!this.together.session) return;
    if (this.framed) {
      this.frame.visible = true;
      this.camera.updateWorldMatrix(true, false);
      this.headStandIn.matrixWorld.multiplyMatrices(this.frameInverse, this.camera.matrixWorld);
      const hands = this.hands?.() ?? [];
      for (let i = 0; i < 2; i++) {
        const hand = hands[i];
        this.handSources[i] = hand?.source ?? null;
        if (hand) {
          hand.controller.updateWorldMatrix(true, false);
          this.handStandIns[i].matrixWorld.multiplyMatrices(this.frameInverse, hand.controller.matrixWorld);
        }
      }
      this.together.update(now);
    }
    // A guest's input goes out when it changes, and while it asks for anything it's repeated
    // (STATE_HZ a second), since the host holds an input for only INPUT_HOLD_MS after it
    // arrived: a stick held still would otherwise drive for that long and stop.
    if (input && !this.isHost && now >= this.nextInputAt) {
      const text = JSON.stringify(input);
      if (text !== this.lastInputSent || inputActive(input)) {
        this.lastInputSent = text;
        this.nextInputAt = now + 1000 / STATE_HZ;
        this.inputChannel?.send(input);
      }
    }
  }

  /**
   * The host sends the site (at most STATE_HZ a second); `build(sequence, full)` makes the
   * message when it's time, `full` when someone has joined since the last one (or the host
   * changed), so they get everything rather than what changed.
   */
  sendState(now, build) {
    if (!this.together.session || !this.isHost || now < this.nextSendAt) return;
    this.nextSendAt = now + 1000 / STATE_HZ;
    const message = build(++this.sequence, this.newcomer);
    this.newcomer = false;
    this.siteChannel?.send(message);
  }

  /** The guests' latest inputs, newest first, as [{ input, at }]. */
  guestInputs() {
    return [...this.inputs.values()].sort((a, b) => b.at - a.at);
  }

  /** The host's latest site message, and forgets it (the app applies it once). */
  takeState() {
    const s = this.latestState;
    this.latestState = null;
    return s;
  }

  /**
   * Gets the avatars' shaders compiled before AR: a stand-in avatar of the app's own, made
   * the way the layer makes them (the same materials, geometry and label sprite), kept under
   * the frame for good: it's never placed, so never visible, and never dropped. The layer's
   * own avatars are dropped (their materials disposed) when a session ends, which would
   * release their shader programs, and the next visitor's would compile in AR. The frame is
   * shown for the app's precompile and warm-up draw; coolDown() puts it back.
   */
  warmUp() {
    if (!this.keeper) {
      this.keeper = createAvatars({ parent: this.frame, ground: () => 0 });
      this.keeper.show({ peerId: 'warm-up', name: 'Visitor', color: '#8fa3ff', page: PAGE_ID, buffer: createBuffer() });
    }
    this.frame.visible = true;
  }

  coolDown() {
    this.frame.visible = this.framed;
  }

  /** For the debug log and tests. */
  snapshot() {
    const c = this.company();
    return {
      active: this.active,
      room: this.room,
      self: this.self.memberId,
      host: this.together.session ? this.host : null,
      isHost: this.isHost,
      following: this.following,
      here: c.here + c.nearby,
      away: c.away,
      people: this.people().map((p) => p.memberId),
      relays: this.condition().relays,
      sequence: this.sequence,
      received: this.received ?? 0,
      // Where the others' heads are drawn, in the scene (mm): with the frame right, where they stand.
      avatars: (this.together.avatars?.list ?? [])
        .filter((a) => a.group.visible)
        .map((a) => a.head.getWorldPosition(new THREE.Vector3()).toArray().map((v) => Math.round(v * 1000) / 1000)),
    };
  }

  // ---------- internals ----------

  wire(session) {
    this.siteChannel = session.channel('site');
    this.inputChannel = session.channel('input');
    this.sequence = 0;
    this.received = 0;
    this.hostMarks = null;
    this.nextSendAt = 0;
    this.nextInputAt = 0;
    this.lastInputSent = null;
    this.newcomer = true;
    this.siteChannel.on((data, peer) => {
      if (!isSiteMessage(data) || peer.memberId !== this.host) return; // only the host's count
      this.received++;
      // The app takes only the latest state, but every message's marks are kept: they are
      // what changed since the one before.
      this.hostMarks = foldMarks(this.hostMarks, data, MARK_CAPS);
      this.latestState = data;
      this.stateFrom = peer.memberId;
      this.emit('state', data);
    });
    this.inputChannel.on((data, peer) => {
      if (!isInput(data)) return;
      this.inputs.set(peer.peerId, { input: data, at: this.now() });
    });
    session.on('leave', (p) => {
      this.inputs.delete(p.peerId);
      this.newcomer = true; // the host may have changed: whoever it is now starts afresh
      this.latestState = null;
      this.emit('change');
    });
    session.on('join', () => {
      this.newcomer = true;
      this.emit('change');
    });
  }
}
