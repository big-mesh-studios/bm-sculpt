import { describe, expect, it } from "vitest";

import { combineRefs } from "./combine-refs";

describe("combining refs", () => {
  it("calls a callback ref with the element", () => {
    const seen: string[] = [];
    combineRefs<string>((value) => seen.push(value))("canvas");
    expect(seen).toEqual(["canvas"]);
  });

  it("assigns an object ref", () => {
    const holder = { current: "" };
    combineRefs<string>(holder)("canvas");
    expect(holder.current).toBe("canvas");
  });

  it("reaches every ref, in order", () => {
    // **In order, because a caller will rely on it**: a ref that measures the element
    // has to run before one that reads the measurement.
    const order: string[] = [];
    combineRefs<string>(
      () => order.push("first"),
      { current: "" },
      () => order.push("third"),
    )("canvas");
    expect(order).toEqual(["first", "third"]);
  });

  it("skips the refs that are not there", () => {
    // A `ref={maybe()}` where the ref is optional is the ordinary case, not an error.
    const holder = { current: "" };
    expect(() =>
      combineRefs<string>(undefined, null, holder)("canvas"),
    ).not.toThrow();
    expect(holder.current).toBe("canvas");
  });

  it("returns a function of no arguments when given no refs", () => {
    expect(() => combineRefs<string>()("canvas")).not.toThrow();
  });
});
