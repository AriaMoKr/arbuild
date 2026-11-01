import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteHint, noticeText, statusText } from '../src/presence.js';

const fine = { online: true, loaded: true, relays: 2, slow: false, failed: 0 };

test('statusText says who is here, or why nobody is yet', () => {
  assert.equal(statusText({ here: 1 }, fine), '1 friend here');
  assert.equal(statusText({ here: 2, nearby: 1, away: 1 }, fine), '3 friends here · 1 elsewhere');
  assert.equal(statusText({ away: 2 }, fine), '2 elsewhere');
  assert.equal(statusText({ connecting: 1 }, fine), 'Connecting to 1 visitor…');
  assert.equal(statusText({}, fine), 'Waiting for others');
  assert.equal(statusText({}, { ...fine, loaded: false }), 'Connecting…');
  assert.equal(statusText({}, { ...fine, relays: 0, slow: true }), "Can't reach the relays");
  assert.equal(statusText({}, { ...fine, failed: 2 }), "Couldn't connect to 2 visitors");
  assert.equal(statusText({ here: 3 }, { ...fine, online: false }), 'Offline');
});

test('noticeText words a notice, with a name or without', () => {
  assert.equal(noticeText({ kind: 'join', peer: { name: 'Sam' } }), 'Sam is here');
  assert.equal(noticeText({ kind: 'arrive', peer: { name: null } }), 'Someone came in');
  assert.equal(noticeText({ kind: 'leave', peer: { name: 'Sam' } }), 'Sam left');
  assert.equal(noticeText({ kind: 'wave', peer: { name: 'Sam' } }), 'Sam waved');
  assert.equal(noticeText({ kind: 'other', peer: { name: 'Sam' } }), '');
});

test('inviteHint tells the other headset what to open', () => {
  assert.equal(inviteHint('k3vd-q8hn'), 'Others: open this page with ?room=k3vd-q8hn');
  assert.equal(inviteHint(null), '');
});
