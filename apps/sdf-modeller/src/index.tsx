// The mobile baseline first, so this application's own rules win at equal specificity.
import "@big-mesh-studios/ui/baseline.css";

import "./index.css";

// **`@solidjs/web` rather than `solid-js/web`**, because that is where the DOM renderer
// lives; `solid-js/web` does not exist. It is the same package the Solid JSX types come
// from, which is why this application's tsconfig points `jsxImportSource` at it.
import { render } from "@solidjs/web";

import { App } from "./app";

const root = document.getElementById("root");
if (root === null) {
  // A missing mount point is a broken page rather than a runtime error to throw from:
  // there is nothing to render into and no way for a person to act on the message.
  document.body.textContent = "sdf-modeller: #root is missing from the page.";
} else {
  render(() => <App />, root);
}
