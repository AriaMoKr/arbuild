// The shared session in the app's words: how it's going, for the panel and the page, and what
// a notice says when someone joins, leaves or waves. Pure, for the tests.

/** @type {(n: number, word: string) => string} */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How the session is doing, in a few words: together.js's company() and condition() at once.
 * "Here" is at this table (on this page); "elsewhere" is on another site in the same room.
 */
export function statusText({ here = 0, nearby = 0, away = 0, connecting = 0 }, { online = true, loaded, relays, slow, failed = 0 }) {
  if (!online) return 'Offline';
  here += nearby;
  if (here || away) {
    const parts = [];
    if (here) parts.push(`${plural(here, 'friend')} here`);
    if (away) parts.push(`${away} elsewhere`);
    return parts.join(' · ');
  }
  if (connecting) return `Connecting to ${plural(connecting, 'visitor')}…`;
  if (!loaded || !relays) return slow ? "Can't reach the relays" : 'Connecting…';
  if (failed) return `Couldn't connect to ${plural(failed, 'visitor')}`;
  return 'Waiting for others';
}

/**
 * A notice from the session as one line, or '' for none: a visitor said hello (join), came onto
 * this page (arrive), left (leave) or waved (wave).
 */
export function noticeText({ kind, peer }) {
  const name = peer.name || 'Someone';
  if (kind === 'join') return `${name} is here`;
  if (kind === 'arrive') return `${name} came in`;
  if (kind === 'leave') return `${name} left`;
  if (kind === 'wave') return `${name} waved`;
  return '';
}

/** The room code's address for another headset to type: the page with only ?room=. */
export function inviteHint(room) {
  return room ? `Others: open this page with ?room=${room}` : '';
}
