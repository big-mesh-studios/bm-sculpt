import { render } from "@solidjs/web";

import App from "./app";
// The mobile baseline first, so that this application's own rules win wherever the
// two have the same specificity. See `index.css` for why this is a JavaScript import
// rather than a CSS `@import`.
import "@big-mesh-studios/ui/baseline.css";

import "./index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error(
    "The #root element is missing. It is declared in index.html, and every " +
      "other assumption in this file is downstream of it being there.",
  );
}

render(() => <App />, root);
