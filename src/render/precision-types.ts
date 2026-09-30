/**
 * `Precision` lives on its own because `precision.ts` and everything that renders with it
 * need the type, and a type-only import from a module that also touches `document` makes
 * it look as though asking for the type requires a browser.
 */
export type Precision = "lowp" | "mediump" | "highp";
