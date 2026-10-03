import { renderToString } from "@solidjs/web";

import { App } from "./App";

/**
 * The page's markup, as the prerender script writes it into the template.
 *
 * **Named `render` and exported rather than run here**, because this module is compiled by
 * Vite into a bundle that the script loads by address. Running it at import time would work
 * and would mean the script had no way to ask for the markup without importing a module that
 * had already produced it.
 */
export function render(): string {
  return renderToString(() => <App />);
}
