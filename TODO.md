# TODO

## Fix: first table pick can land on a far table

Seen on the Quest 3 (debug log, 2026-10-04): both sessions started on a table about
9.5 m away ("Table 6 of 6", probably another room in Space Setup) while four tables
were within 1.5 m. Quest delivers the room's planes over the first few frames (the
scene object count went 45 → 49), and `TableTracker` locks onto the best table in the
first frame and keeps that lock when nearer tables arrive. The emulator and e2e tests
deliver every plane on frame 1, so they never caught it.

- Treat the automatic pick as provisional: re-pick whenever the set of tables changes,
  until the user takes control (trigger/pinch to cycle, left stick to slide, right stick
  to spin).
- Don't let "in view" beat distance outright: score candidates as distance plus a
  penalty (about 1.5 m) for being out of view, so a table in front only wins when it's
  about as close.
- Tests: a unit test where tables arrive over several updates, and an e2e scenario
  where planes trickle in (living room, far table first).
