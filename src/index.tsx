import { render } from "@solidjs/web";

import App from "./app";
import "./index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error(
    "The #root element is missing. It is declared in index.html, and every " +
      "other assumption in this file is downstream of it being there.",
  );
}

render(() => <App />, root);
