/**
 * The move handle's arithmetic, against numbers.
 *
 * **These are the only tests in the application that can catch a move tool which moves the
 * wrong part along the wrong axis.** Everything else about the tool is a mesh appearing and
 * disappearing, and a mesh that is drawn correctly while the maths underneath it is wrong
 * produces a tool that looks entirely healthy.
 */
import { describe, expect, it } from "vitest";

import {
  armUnderPointer,
  distanceDragged,
  distanceToSegment,
  GRAB_RADIUS,
  HUB_RADIUS,
  type ArmOnScreen,
  type ScreenPoint,
  TOO_FORESHORTENED,
} from "./move-handle";

const at = (x: number, y: number): ScreenPoint => ({ x, y });

/**
 * A widget as it is actually drawn: x to the right, y up, and z pointing at the camera and
 * so projecting to no screen length at all.
 *
 * **The degenerate z arrow is deliberate** — it is what the three arms of a real widget look
 * like from most camera angles, and a hit test that divides by its zero length would be a
 * NaN that compares false against everything.
 */
const threeAxes: ArmOnScreen[] = [
  { axis: "x", from: at(100, 100), to: at(200, 100) },
  { axis: "y", from: at(100, 100), to: at(100, 20) },
  { axis: "z", from: at(100, 100), to: at(100, 100) },
];

describe("distanceToSegment", () => {
  it("measures to the line between the ends", () => {
    expect(distanceToSegment(at(150, 130), at(100, 100), at(200, 100))).toBe(
      30,
    );
  });

  it("measures to the tip past the end, not to the infinite line", () => {
    // A point beyond `to` on the same line is at distance 0 from the line but 50 from the
    // tip. Measuring to the line would make the arrow infinitely grabbable past its head.
    expect(distanceToSegment(at(250, 100), at(100, 100), at(200, 100))).toBe(
      50,
    );
  });

  it("measures to the near end before the start", () => {
    expect(distanceToSegment(at(50, 100), at(100, 100), at(200, 100))).toBe(50);
  });

  it("copes with an arrow of no screen length", () => {
    // The z arrow above points at the camera and projects to a point. Dividing by its zero
    // length would be a NaN, and a NaN distance compares false against everything, so the
    // arrow would be ungrabbable *and* would poison the nearest-wins search.
    expect(distanceToSegment(at(105, 100), at(100, 100), at(100, 100))).toBe(5);
  });
});

describe("armUnderPointer", () => {
  const arms = threeAxes;

  it("takes the arm the pointer is nearest to", () => {
    expect(armUnderPointer(at(180, 103), arms)).toBe("x");
    expect(armUnderPointer(at(97, 40), arms)).toBe("y");
  });

  it("grabs nothing at the hub, where no arm is nearer than any other", () => {
    expect(armUnderPointer(at(100, 100), arms)).toBeUndefined();
    expect(armUnderPointer(at(108, 108), arms)).toBeUndefined();
  });

  it("grabs nothing clear of every arm", () => {
    expect(armUnderPointer(at(100, 220), arms)).toBeUndefined();
  });

  it("grabs an arm within the threshold and not beyond it", () => {
    const just = 100 + GRAB_RADIUS - 1;
    expect(armUnderPointer(at(150, just), arms)).toBe("x");
    const past = 100 + GRAB_RADIUS + 1;
    expect(armUnderPointer(at(150, past), arms)).toBeUndefined();
  });

  it("takes the nearest where two arms cross", () => {
    // The x arrow runs through the middle of the y arrow's shaft. Whichever the pointer is
    // closer to is the one drawn in front, and picking by axis order instead would reach
    // through the figure for the arm behind.
    const crossing: ArmOnScreen[] = [
      { axis: "x", from: at(100, 100), to: at(200, 100) },
      { axis: "y", from: at(100, 100), to: at(100, 160) },
    ];
    // **Clear of the hub**, which is itself a dead zone — so a test that grabs three
    // pixels off the middle is testing the hub, not the crossing.
    expect(armUnderPointer(at(105, 120), crossing)).toBe("y");
    expect(armUnderPointer(at(150, 100), crossing)).toBe("x");
  });

  it("has no answer with no arms up", () => {
    expect(armUnderPointer(at(150, 100), [])).toBeUndefined();
  });

  it("puts the dead zone inside the grab radius, or the hub is unreachable", () => {
    // Otherwise a pointer just off the hub is both "too near the middle" and "too far from
    // every arm", and there is a ring around the middle where nothing can be grabbed at
    // all — which is where a person reaches first.
    expect(HUB_RADIUS).toBeLessThan(GRAB_RADIUS);
  });
});

describe("distanceDragged", () => {
  const arm: ArmOnScreen = { axis: "x", from: at(100, 100), to: at(200, 100) };

  it("reads travel since the grab as a fraction of the arrow", () => {
    // **The argument is a delta, not a position.** A hundred pixels of screen is the
    // arrow's whole length, so a hundred pixels of travel is the whole world distance it
    // stands for, and half of it is half of that.
    expect(distanceDragged(at(50, 0), arm, 4)).toBe(2);
    expect(distanceDragged(at(100, 0), arm, 4)).toBe(4);
    expect(distanceDragged(at(0, 0), arm, 4)).toBe(0);
  });

  it("reads a drag against the arrow as negative, so the part comes back", () => {
    expect(distanceDragged(at(-100, 0), arm, 4)).toBe(-4);
    expect(distanceDragged(at(-50, 0), arm, 4)).toBe(-2);
  });

  it("ignores movement across the arrow", () => {
    expect(distanceDragged(at(0, 90), arm, 4)).toBe(0);
  });

  it("is absolute, so returning to the start returns to zero", () => {
    // The caller passes travel since the grab. A version that summed each move would not
    // come back to zero here, and a part that will not go back where it was put down is the
    // wrong a person notices immediately.
    expect(distanceDragged(at(0, 0), arm, 4)).toBe(0);
  });

  it("refuses to read a distance off an arrow pointing at the camera", () => {
    // Every pixel of travel would have to mean an enormous distance, so a wobble would send
    // the part across the model. Zero is the safe answer: the part does not move at all.
    const headOn: ArmOnScreen = {
      axis: "z",
      from: at(100, 100),
      to: at(101, 100),
    };
    expect(distanceDragged(at(50, 0), headOn, 4)).toBe(0);
  });

  it("draws the line just above the foreshortening threshold", () => {
    const length = TOO_FORESHORTENED + 1;
    const thin: ArmOnScreen = {
      axis: "z",
      from: at(100, 100),
      to: at(100 + length, 100),
    };
    expect(distanceDragged(at(50, 0), thin, 4)).toBeGreaterThan(0);
  });
});
