// Right-controller input for the cube: thumbstick spins it, holding A cycles its colour.
// Pure functions on plain values, so they run under `node --test`.
//
// Quest Touch controllers use the WebXR 'xr-standard' gamepad layout:
// buttons[4] is A on the right controller (X on the left), and axes[2]/axes[3]
// are the thumbstick's x/y (axes[0]/axes[1] are touchpad placeholders, always 0).

const A_BUTTON = 4;
const STICK_X = 2;
const STICK_Y = 3;

export const STICK_DEADZONE = 0.15;
export const MAX_SPIN_SPEED = Math.PI / 4; // rad/s at full deflection: one turn every 8 s
export const HUE_CYCLES_PER_SECOND = 0.25; // a full trip round the colour wheel in 4 s

/**
 * State of the right-hand controller among `inputSources`, or null when there isn't
 * one (no controller, hands only, or an unknown gamepad layout).
 * Returns { stick: { x, y }, aPressed }.
 */
export function readRightController(inputSources) {
  for (const source of inputSources ?? []) {
    if (source.handedness !== 'right' || source.hand || !source.gamepad) continue;
    const { mapping, axes, buttons } = source.gamepad;
    if (mapping !== 'xr-standard') continue;
    return {
      stick: { x: axes[STICK_X] ?? 0, y: axes[STICK_Y] ?? 0 },
      aPressed: Boolean(buttons[A_BUTTON]?.pressed),
    };
  }
  return null;
}

/**
 * Spin speed for a thumbstick position. Any push past the dead zone spins the cube,
 * faster the further the stick goes. Pushing right turns it clockwise seen from
 * above (negative yaw) and left turns it anticlockwise; a straight up/down push
 * keeps the previous direction. Returns { velocity (rad/s), direction (+1 | -1) }.
 */
export function spinVelocity(stick, previousDirection = -1) {
  const magnitude = Math.min(1, Math.hypot(stick.x, stick.y));
  if (magnitude < STICK_DEADZONE) return { velocity: 0, direction: previousDirection };
  const direction = Math.abs(stick.x) >= STICK_DEADZONE ? (stick.x > 0 ? -1 : 1) : previousDirection;
  const scaled = (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  return { velocity: direction * scaled * MAX_SPIN_SPEED, direction };
}

/** Hue (0..1) advanced by `dt` seconds of holding A. */
export function nextHue(hue, dt) {
  return (hue + dt * HUE_CYCLES_PER_SECOND) % 1;
}
