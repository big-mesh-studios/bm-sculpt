import { SculptDocument } from "../edit/document";
import { beginStroke, DEFAULT_BRUSH } from "../edit/brush";
import { makeOperation } from "@big-mesh-studios/csg";
const d = new SculptDocument();
d.add([
  makeOperation(
    0,
    { x: 0, y: 0, z: 0 },
    { type: "Ellipsoid", radius: { x: 10, y: 10, z: 10 } },
    "Add",
  ),
]);
const s = beginStroke(d, DEFAULT_BRUSH);
s.extendTo({ x: 0, y: 0, z: 0 });
const ops = (s as unknown as { operations: Array<{ index: number }> })
  .operations;
console.log(
  "stroke's own operation indices:",
  ops.map((o) => o.index),
);
s.extendTo({ x: 200, y: 0, z: 0 });
console.log("after extend:", ops.map((o) => o.index).slice(0, 6), "…");
s.end();
console.log(
  "document list indices:",
  d.list.map((o) => o.index).slice(0, 6),
  "… count",
  d.count,
);
