import { describe, expect, it } from "vitest";
import { Scene } from "@random-mesh/rmsl/scene";
import { Builder } from "@random-mesh/rmsl/scene/materials/nodes/Builder";
import { createWater } from "../apps/bm-sculpt/src/world/water";

describe("probe", () => {
  it("builds the fragment body headless", () => {
    const scene = new Scene();
    const material = createWater(scene, { kind: "radius", radius: 4000 })
      .material as unknown as {
      setup: (b: Builder, s: Scene) => void;
      buildFragmentBody: (b: Builder) => unknown;
    };
    const b = new Builder();
    material.setup(b, scene);
    const node = material.buildFragmentBody(b) as { toString?: () => string };
    console.log("typeof node.toString:", typeof node.toString);
    const text = node.toString?.() ?? "";
    console.log("length:", text.length);
    console.log("has positionWorld:", text.includes("positionWorld"));
    expect(text.length).toBeGreaterThan(0);
  });
});
