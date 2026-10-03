/**
 * A colour picker: a hue/saturation chart, a brightness slider, an alpha slider and
 * four number fields.
 *
 * ## Ported from rm-stacker, and what changed
 *
 * The component is the sibling application's `ColorPicker.tsx` nearly as it stands there.
 * Four things differ, and each is because this repository is not that one:
 *
 * - **`pointer` comes from `@big-mesh-studios/ui`.** The sibling's lives in its
 *   `packages/utils`, and the two APIs agree on what a drag is — `(event, callback)` and a
 *   callback handed `{ event }` among other things — so the port is an import change.
 * - **`HSVA` and `RGBA` come from `@big-mesh-studios/core`,** beside the `Rgb8` they
 *   convert to. The arithmetic is unchanged.
 * - **`var(--margin)` is `var(--ui-margin)`** and the two text colours are defined here,
 *   because the baseline's tokens are this repository's and adding a foreground grey to it
 *   for one consumer would be the wrong direction.
 * - **The file is `colour-picker.tsx`,** because this repository spells colour that way
 *   everywhere else and a port is the one place a mixed spelling survives for years.
 *
 * ## Why the hue/saturation chart rather than three sliders
 *
 * **Because a slider cannot express hue and a picker must.** Hue is a circle: 0 and 360
 * are the same colour, and a track with two ends either wraps and is confusing at one end
 * or clamps and cannot reach every hue at all. The chart puts the wrap where it belongs —
 * on a track with no ends — and lets saturation and value fall out of where a finger is
 * put, which is the fastest interaction there is on a screen you can touch.
 *
 * ## Why the alpha slider is here at all
 *
 * **Because the packed vertex has four bytes and the third of them has always been the
 * alpha.** It was never written — `setColour` took three channels — so this picker would
 * have shipped a control that visibly did nothing. `setColour` now takes an alpha and
 * `Operation.opacity` reaches it, which is what makes the slider honest.
 */
import { createEffect, createMemo, createSignal, For } from "solid-js";
import {
  hsvaToRgba,
  rgbaEquals,
  rgbaToHsva,
  rgbaToCss,
  type HSVA,
  type RGBA,
} from "@big-mesh-studios/core";
import { pointer } from "@big-mesh-studios/ui/pointer";

import styles from "./colour-picker.module.css";

const DEFAULT_HSVA: HSVA = { h: 0, s: 1, v: 1, a: 1 };

const CHANNELS = ["r", "g", "b", "a"] as const satisfies ReadonlyArray<
  keyof RGBA
>;

const CHANNEL_LABELS: Record<keyof RGBA, string> = {
  r: "R",
  g: "G",
  b: "B",
  a: "A",
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Where in its element an event sits, as a fraction, clamped to `0..1`. */
const fractionWithin = (
  element: HTMLElement,
  event: PointerEvent,
): { x: number; y: number } => {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height),
  };
};

export function ColourPicker(props: {
  class?: string;
  /** The colour being shown. `undefined` leaves the picker where it is. */
  colour?: RGBA;
  onColour?: (colour: RGBA) => void;
}) {
  // **A writable signal seeded from a function of its previous value.** A drag writes
  // HSVA directly, because the hue and saturation of a colour the person chose must not be
  // recovered from an 8-bit round trip on every move — a fully saturated red comes back
  // from `rgbaToHsva` as a slightly different red, and a picker that did that would drift
  // under a stationary finger. An incoming `colour` prop still wins, and `previous` is the
  // fallback `rgbaToHsva` needs at the greys and at black, where hue and saturation have no
  // answer of their own.
  const [hsva, setHsva] = createSignal<HSVA>(
    (previous) => {
      const colour = props.colour;
      if (colour === undefined) return previous ?? DEFAULT_HSVA;
      // Already showing this colour, so leave hue and saturation alone.
      if (previous !== undefined && rgbaEquals(hsvaToRgba(previous), colour)) {
        return previous;
      }
      return rgbaToHsva(colour, previous ?? DEFAULT_HSVA);
    },
    {
      equals: (a, b) =>
        a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a,
    },
  );

  const colour = createMemo<RGBA>(() => hsvaToRgba(hsva()));

  // Only one channel is ever mid-edit, so a single draft covers all four inputs.
  const [draft, setDraft] = createSignal<
    { channel: keyof RGBA; text: string } | undefined
  >();

  createEffect(colour, (shown) => {
    if (props.colour !== undefined && rgbaEquals(shown, props.colour)) return;
    props.onColour?.(shown);
  });

  const onChannelInput = (channel: keyof RGBA, text: string): void => {
    setDraft({ channel, text });
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return;
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    setHsva((previous) =>
      rgbaToHsva({ ...colour(), [channel]: clamped }, previous),
    );
  };

  /**
   * Follows a drag on one of the tracks.
   *
   * **`element` is captured before the await**, because `event.currentTarget` is only
   * meaningful during dispatch — after the first `await` it is null, and measuring against
   * a null element throws on the first move of every drag.
   */
  const drag = async (
    event: PointerEvent & { currentTarget: HTMLElement },
    update: (fraction: { x: number; y: number }, previous: HSVA) => HSVA,
  ): Promise<void> => {
    const element = event.currentTarget;
    setDraft(undefined);
    await pointer(event, ({ event: moved }) => {
      setHsva((previous) => update(fractionWithin(element, moved), previous));
    });
  };

  return (
    <div class={[styles.colourPicker, props.class]}>
      <div
        class={styles.hueSaturation}
        style={{ "--darken": 1 - hsva().v }}
        onPointerDown={(event) => {
          void drag(event, ({ x, y }, previous) => ({
            ...previous,
            h: x * 360,
            s: 1 - y,
          }));
        }}
      >
        <div
          class={styles.chartHandle}
          style={{
            left: `${(hsva().h / 360) * 100}%`,
            top: `${(1 - hsva().s) * 100}%`,
          }}
        />
      </div>

      <div
        class={styles.brightness}
        style={{
          "--full-value-colour": rgbaToCss(
            hsvaToRgba({ ...hsva(), v: 1, a: 1 }),
          ),
        }}
        onPointerDown={(event) => {
          void drag(event, ({ y }, previous) => ({ ...previous, v: 1 - y }));
        }}
      >
        <div
          class={styles.sliderHandle}
          style={{ bottom: `${hsva().v * 100}%` }}
        />
      </div>

      <div
        class={styles.alpha}
        style={{
          "--opaque-colour": rgbaToCss(hsvaToRgba({ ...hsva(), a: 1 })),
        }}
        onPointerDown={(event) => {
          void drag(event, ({ y }, previous) => ({ ...previous, a: 1 - y }));
        }}
      >
        <div
          class={styles.sliderHandle}
          style={{ bottom: `${hsva().a * 100}%` }}
        />
      </div>

      <div class={styles.fields}>
        <For each={CHANNELS}>
          {(channel) => {
            const shown = createMemo(() => {
              const value = draft();
              return value?.channel === channel ? value.text : undefined;
            });
            return (
              <>
                <label class={styles.label} for={`colour-${channel}`}>
                  {CHANNEL_LABELS[channel]}
                </label>
                <input
                  id={`colour-${channel}`}
                  class={styles.channel}
                  type="number"
                  min="0"
                  max="255"
                  size="4"
                  value={shown() ?? colour()[channel]}
                  onInput={(event) => {
                    onChannelInput(channel, event.currentTarget.value);
                  }}
                  onBlur={() => {
                    setDraft(undefined);
                  }}
                />
              </>
            );
          }}
        </For>
      </div>

      <div class={styles.output} style={{ "--colour": rgbaToCss(colour()) }} />
    </div>
  );
}
