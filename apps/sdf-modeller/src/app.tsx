/**
 * The application shell: a canvas, a parts list, a primitive picker, and the selected
 * part's transform.
 *
 * ## Why the mesh is rebuilt on a timer rather than on every edit
 *
 * **Because meshing a model is tens of milliseconds and a drag sends a change a frame.**
 * The rebuild is debounced, so a drag that moves a part continuously shows the model
 * updating a few times a second rather than re-meshing on every pointer move. On a phone
 * that is the difference between a control that follows a finger and one that does not.
 *
 * The mesh is the *result* of the model and never the model itself, so a mesh a few tens
 * of milliseconds behind is a picture that is briefly late rather than a state that
 * disagrees with itself.
 */
import type { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import {
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { PRIMITIVE_NAMES } from "@big-mesh-studios/sdf";
import { describeReport } from "@big-mesh-studios/meshing";
import { pointer } from "@big-mesh-studios/ui/pointer";

import {
  budgetFor,
  DEFAULT_BUDGET,
  MESH_MODES,
  meshModel,
  primitiveMesh,
  RESOLUTIONS,
  type MeshMode,
} from "./model/mesh-model";
import { modelBounds, placedPart, type Part } from "./model/part";
import { createGhost, type Ghost } from "./view/ghost";
import {
  armUnderPointer,
  distanceDragged,
  type Axis,
  type ScreenPoint,
} from "./view/move-handle";
import { createMoveHandles, type MoveHandles } from "./view/move-handles";
import { createModelStore } from "./model/model-store";
import {
  createOrbit,
  createViewport,
  type OrbitController,
} from "./view/viewport";
import { createModelView, type ModelView } from "./view/model-view";
import { PartsPanel } from "./ui/parts-panel";
import { createPalette } from "./ui/palette";
import { TransformPanel } from "./ui/transform-panel";
// **From `./print/print-problem` and not from `./print/export-model`, and that is the whole
// reason the module is split.** The export control's default height is a number about the
// printer; importing it through the writer would put `jszip` on the first frame, and the build
// says `INEFFECTIVE_DYNAMIC_IMPORT` out loud when it happens.
import { DEFAULT_HEIGHT_MM } from "./print/print-problem";
import { PROJECT_EXTENSION, PROJECT_MIME_TYPE } from "./file/project-file";
import {
  chooseFileToRead,
  choosePlaceToWrite,
  downloadBlob,
  remembersFiles,
  type OpenedFile,
  type WriteTarget,
} from "./file/save-file";
import { autosave, clearDraft, readDraft, saveDraft } from "./file/autosave";
import { NOWHERE, homeWriter, type Home } from "./file/home";
import {
  canRemember,
  forgetFile,
  listRecentFiles,
  readThrough,
  rememberFile,
  type RecentFile,
} from "./file/recent-files";
import { createDialog } from "./ui/dialog";
import { FilesPanel } from "./ui/files-panel";
import { DEFAULT_MAX_COLOURS } from "./print/quantise";
import type { MeshResult } from "./model/mesh-model";
import styles from "./app.module.css";

/** How long the model has to be still before it is re-meshed, in milliseconds. */
const REBUILD_MS = 90;

/** What a project file is called when nothing has said otherwise. */
const DEFAULT_PROJECT_NAME = `model${PROJECT_EXTENSION}`;

/**
 * An id for a home, so a list can key on it.
 *
 * **The same shape as the recent list's ids and for the same reason**: a `FileSystemFileHandle`
 * cannot be compared cheaply, and `isSameEntry` is asynchronous and only answers whether two
 * handles are one file. A document's home needs a name that a list can key on.
 */
const newEntryId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `home-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

/** What a project picker accepts, as the two things that ask for one need to agree. */
const PROJECT_CHOICE = {
  description: "SDF model",
  extension: PROJECT_EXTENSION,
  mimeType: PROJECT_MIME_TYPE,
} as const;

/** What a 3MF picker accepts, which is a zip like a project file and so says so. */
const THREE_MF_CHOICE = {
  description: "3D print model",
  extension: ".3mf",
  mimeType: PROJECT_MIME_TYPE,
} as const;

/**
 * The model a new document starts from.
 *
 * **A capsule rather than nothing**, for the reason on the store's initial state: an empty
 * canvas with an empty list tells a first-time visitor nothing about what the application is.
 * One capsule is the smallest figure that reads as a figure.
 */
const newModel = (): Part[] => [
  placedPart(
    "body",
    { type: "Capsule", len: 2.2, radius: 0.7 },
    { x: 0, y: 1.1, z: 0 },
  ),
];

/**
 * The direction one arrow lies along, in the model's own axes.
 *
 * **The model's axes and not the part's**, for the reason on `MoveHandles.place`: a move
 * tool that slid a part along its own turn would send a limb on its side travelling the
 * wrong way.
 */
const unitAlong = (axis: Axis): { x: number; y: number; z: number } =>
  axis === "x"
    ? { x: 1, y: 0, z: 0 }
    : axis === "y"
      ? { x: 0, y: 1, z: 0 }
      : { x: 0, y: 0, z: 1 };

export function App() {
  let canvas!: HTMLCanvasElement;

  /**
   * Which tool the pointer is holding.
   *
   * **Two named tools rather than a "handles up" flag**, because the interesting case is
   * coming back. A single toggle answers "are the handles showing" and leaves the question
   * of what the canvas does instead to be inferred; naming the tools says that with the
   * handles down the canvas is picking and with them up it is moving, which is the whole of
   * what the toolbar is for.
   */
  const [tool, setTool] = createSignal<"select" | "move">("select");

  /**
   * Whether a handle drag is running.
   *
   * **A plain boolean rather than a signal**: nothing renders from it, and a signal would
   * mean a write per frame for a value only a pointer handler ever reads.
   */
  let dragging = false;

  const store = createModelStore(newModel());

  /**
   * The colours this model has used, so a colour can be reached again.
   *
   * **Held here rather than in the panel**, because a panel's memory dies with the panel —
   * and on a phone a width query tears the layout down and rebuilds it on every rotation.
   */
  const palette = createPalette([
    { r: 214, g: 96, b: 84, a: 255 },
    { r: 111, g: 207, b: 151, a: 255 },
    { r: 96, g: 150, b: 214, a: 255 },
  ]);

  const [status, setStatus] = createSignal("meshing…");

  /**
   * Which mesher a rebuild uses.
   *
   * **A signal because it changes the mesh and nothing else**, and it is the one setting here
   * that alters what the model *is* rather than how it is drawn. Surface nets by default: it is
   * what this application was, and while a finger is down a mesh that arrives promptly and is
   * not quite closed beats one that is closed and late.
   */
  const [mode, setMode] = createSignal<MeshMode>("surface-nets");

  /**
   * How fine to mesh, as one of `RESOLUTIONS`.
   *
   * **A union of the offered sizes rather than a number**, so that a slider's value cannot be
   * something the mesher was never measured at. Widening it to `number` would also mean deciding
   * what to do with a value that is not in the list, and the answer would be to round it — which is
   * the same decision made invisibly.
   */
  const [resolution, setResolution] = createSignal<
    (typeof RESOLUTIONS)[number]
  >(DEFAULT_BUDGET.voxelSize as (typeof RESOLUTIONS)[number]);

  /**
   * Which panel the bottom sheet is showing, on a narrow screen.
   *
   * **One at a time, because two panels side by side on a phone is neither of them.**
   * The parts list needs a list's worth of height and the transform needs a form's worth of
   * width, and a screen cannot give both. Tabs are also the reason the two cannot overlap:
   * on a narrow screen the canvas and the sheet are siblings in one flex column, so the
   * sheet takes height from the canvas rather than being laid over it.
   */
  const [sheet, setSheet] = createSignal<"parts" | "shape">("parts");

  /**
   * Where the document came from, and therefore where Save writes.
   *
   * **`nowhere` until something has been opened or saved**, which is the whole of what "unsaved"
   * means here: there is nowhere to write back to, so Save becomes Save as. See `./file/home` for
   * why this is one value and not a name and a handle side by side.
   *
   * A restored draft is also `nowhere`, and deliberately: the bytes came from this browser's own
   * database rather than from a file, so saving it should ask where it goes rather than quietly
   * claiming the draft slot can be written back to.
   */
  const [home, setHome] = createSignal<Home>(NOWHERE);

  /** The files this browser has opened, drawn as cards. */
  const [recent, setRecent] = createSignal<readonly RecentFile[]>([]);

  /** When the draft was written, which is the only way a restore can say how stale it is. */
  const [draftAt, setDraftAt] = createSignal<number | undefined>();

  /** Something in a file operation is in flight, which is what disables the actions. */
  const [busy, setBusy] = createSignal(false);

  /**
   * The last mesh a rebuild produced.
   *
   * **Held so the export controls can say whether the model is printable without meshing it
   * again.** The export re-meshes at its own resolution when it runs, but the question "can this
   * be printed" is asked while somebody is looking at the panel, and answering it by meshing
   * would put a hundred milliseconds on opening a menu.
   *
   * **The viewport's mesh and not the export's**, and the button's title says so: at a
   * resolution chosen so a rebuild lands while a finger is down, an open edge is a warning about
   * what is on screen rather than a prediction about the file.
   */
  const [mesh, setMesh] = createSignal<MeshResult | undefined>();

  /**
   * What the last file operation had to say, or nothing.
   *
   * **One notice for the whole dialogue**, because there is one surface: a refusal from
   * `readProject` and a refusal from the print gate are the same kind of thing and are both
   * about a file somebody asked for. Cleared when an action starts, so a refusal does not sit
   * beside a control somebody has since fixed.
   */
  const [fileNotice, setFileNotice] = createSignal<string>();

  /**
   * The height a print should stand at, **held as text rather than as a number**.
   *
   * Because a number in a number input is a number on every keystroke, so typing "1" on the way
   * to "150" would export a one-millimetre model. The text is what the person typed; the number
   * is derived from it and refused when it is not one.
   */
  const [height, setHeight] = createSignal(String(DEFAULT_HEIGHT_MM));

  /**
   * How many filaments the destination printer has, as text, for the same reason.
   *
   * **Four by default, because that is what the printer this was written for has** — and a
   * number in a file that a slicer will act on is not a number to leave to chance.
   */
  const [filaments, setFilaments] = createSignal(String(DEFAULT_MAX_COLOURS));

  // **Assigned inside `onSettled` and read outside it, which is the shape this needs.**
  //
  // The renderer cannot be built in the component body, because `ref={canvas}` is
  // assigned *after* the body runs: at that point `canvas` is still `undefined`, and
  // `createViewport` hands it straight to `ResizeObserver.observe`, which throws
  // "parameter 1 is not of type 'Element'". So everything that needs the canvas waits
  // for the DOM.
  //
  // The rebuild reads them from outside, which is why they are declared here and
  // assigned later — and why `rebuild` has to cope with them not existing yet.
  const Files = createDialog();

  let picker!: HTMLInputElement;
  let view: ModelView | undefined;
  let orbit: OrbitController | undefined;
  let handles: MoveHandles | undefined;
  let ghost: Ghost | undefined;
  let camera: PerspectiveCamera | undefined;

  let pending: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0;

  /**
   * Rebuilds the mesh for `parts`.
   *
   * **The parts are an argument rather than read from the store inside.** A Solid 2 effect's
   * second function is the *effect* callback, and reading a reactive value there warns
   * `STRICT_READ_UNTRACKED` and does not update — which for a mesher means the second edit
   * would mesh the first edit's model. The compute function's value is handed in instead,
   * so the only reactive read happens where it is tracked.
   */
  const rebuild = (parts: readonly Part[]): void => {
    // The canvas may not be up yet, in which case the effect that drives this fires
    // before there is anything to mesh into. `onSettled` triggers the first rebuild
    // itself once there is.
    //
    // **Taken into locals rather than read through the outer `let`s inside the timeout.**
    // The guard narrows `view` and `orbit` here, but the narrowing does not reach a
    // closure — and reading the outer variables inside the callback would also mean a
    // rebuild that lands after teardown installs into a disposed renderer.
    const target = view;
    const camera = orbit;
    if (target === undefined || camera === undefined) return;
    // **The mode and the resolution are read here, not inside the timeout**, so they are part
    // of what this rebuild is *for*. Read inside, a rebuild would use whatever they happened to
    // be when the timer fired, so moving the resolution slider would mesh the old one and the
    // picture would come back looking like the control had not worked.
    const budget = budgetFor(resolution());
    const mesher = mode();
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      const started = performance.now();
      const result = meshModel(parts, budget, mesher);
      // **Kept for the export controls to read**, which is the only reason it is here: the
      // popover has to say whether the model is printable without meshing it again. See the
      // signal's own note about this being the viewport's mesh and not the export's.
      setMesh(result);
      // **Translucent only if something in the model is.** A mesh cannot say so itself, and
      // an always-transparent material with depth writes off makes a solid self-overlap.
      target.install(
        result,
        parts.some((part) => (part.opacity ?? 1) < 1),
      );
      elapsed = performance.now() - started;

      const bounds = modelBounds(parts);
      if (bounds !== undefined) {
        const size = Math.max(
          bounds.max.x - bounds.min.x,
          bounds.max.y - bounds.min.y,
          bounds.max.z - bounds.min.z,
        );
        camera.frame(
          {
            x: (bounds.min.x + bounds.max.x) / 2,
            y: (bounds.min.y + bounds.max.y) / 2,
            z: (bounds.min.z + bounds.max.z) / 2,
          },
          size,
        );
      }

      /**
       * **The draft is armed from the rebuild rather than watched separately.**
       *
       * The rebuild is the one place that runs when the model has actually changed, after the
       * debounce that keeps it off a finger's every frame — so arming the draft here means it is
       * written once per settled model rather than once per keystroke, with no second timer to
       * keep in step with this one.
       */
      draft.changed();

      const count = parts.length;
      setStatus(
        result === undefined
          ? "no parts yet — add one below"
          : `${count} part${count === 1 ? "" : "s"} · ${result.triangles} triangles · ${Math.round(result.samples / 1000)}k samples · ${Math.round(elapsed)} ms · ${describeReport(result.report)}`,
      );
    }, REBUILD_MS);
  };

  /**
   * Where the handles stand this frame, or nowhere.
   *
   * **Placed inside the render loop rather than in an effect**, because they depend on the
   * camera's distance as well as on the part, and the camera is not a signal — it changes
   * under a finger, with nothing observable to hang an effect off. An effect would place
   * them when the part changed and leave them the size they were when the view was last
   * orbited, which is a handle that shrinks as you zoom out and never catches up.
   */
  const standHandles = (): void => {
    const controller = orbit;
    const arrows = handles;
    const part = untrack(selected);
    if (controller === undefined || arrows === undefined) return;

    const standing = untrack(tool) === "move" && part !== undefined;
    arrows.setVisible(standing);
    if (part !== undefined)
      arrows.place(part.origin, controller.state().radius);
  };

  /**
   * The pointer's position on the canvas, in CSS pixels from its top left.
   *
   * **CSS pixels rather than device pixels**, and both ends of the comparison are: the
   * projection is given the canvas's CSS size, so a threshold written in pixels is the same
   * physical size on every display rather than half the size of the drawn buffer's.
   */
  const pointerOnCanvas = (event: PointerEvent): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /**
   * Takes hold of an arrow, or leaves the press to the camera.
   *
   * **The whole model is left alone until the finger lifts.** The part stays where it is and
   * a copy follows the pointer; the store is written once, on pointer-up, which is what
   * makes the drag one undo entry and one rebuild rather than one per frame.
   */
  const grabHandle = async (
    initial: PointerEvent & { currentTarget: HTMLElement },
  ): Promise<void> => {
    const controller = orbit;
    const arrows = handles;
    const copy = ghost;
    const eye = camera;
    const part = untrack(selected);
    if (
      controller === undefined ||
      arrows === undefined ||
      copy === undefined ||
      eye === undefined ||
      untrack(tool) !== "move" ||
      part === undefined ||
      dragging
    ) {
      return;
    }

    // Placed and measured now rather than read off the last frame, so a grab reads the same
    // picture the finger is looking at even if the camera has moved since the last frame.
    arrows.place(part.origin, controller.state().radius);
    const rect = canvas.getBoundingClientRect();
    const arms = arrows.armsOnScreen(eye, {
      width: rect.width,
      height: rect.height,
    });
    const axis = armUnderPointer(pointerOnCanvas(initial), arms);
    if (axis === undefined) return;

    dragging = true;
    controller.setInteractive(false);
    arrows.setHeld(axis);

    // **The primitive on its own, built once.** See `primitiveMesh`: a drag changes where a
    // part is and never what it is shaped like, so every frame after the first would
    // produce identical vertices.
    copy.show(primitiveMesh(part, DEFAULT_BUDGET)?.mesh, part.origin);

    const start = part.origin;
    const arm = arms.find((candidate) => candidate.axis === axis);
    let moved = start;

    try {
      await pointer(initial, ({ totalDelta }) => {
        if (arm === undefined) return;
        // **The distance is read off the arrow's own screen length**, so it is a fraction of
        // the arrow rather than an independent scale — and it is recomputed from the grab
        // every time rather than accumulated, so a drag that returns to its start returns
        // the part to its start.
        const along = distanceDragged(totalDelta, arm, arrows.armLength());
        const direction = unitAlong(axis);
        moved = {
          x: start.x + direction.x * along,
          y: start.y + direction.y * along,
          z: start.z + direction.z * along,
        };
        copy.moveTo(moved);
        // **The arrows follow the copy**, so the handle under the finger is the handle the
        // finger is on.
        arrows.place(moved, controller.state().radius);
      });
    } finally {
      arrows.setHeld(undefined);
      copy.hide();
      controller.setInteractive(true);
      dragging = false;
    }

    // **One write, on the way out.** Everything above was a proposal.
    if (moved.x !== start.x || moved.y !== start.y || moved.z !== start.z) {
      store.transform(part.id, { origin: moved });
    }
  };

  /**
   * A number somebody typed, or nothing.
   *
   * **A blank or unparseable field is `undefined` rather than a default**, because the export
   * button's whole question is whether the numbers in this form are a model somebody asked for.
   * Substituting a default would silently print at a height nobody chose, which is the one
   * outcome a size field exists to prevent.
   */
  const numberIn = (text: string, minimum: number): number | undefined => {
    const value = Number.parseFloat(text);
    return Number.isFinite(value) && value >= minimum ? value : undefined;
  };

  /**
   * Runs a file operation, putting its refusal where it can be read.
   *
   * **One place that reports, because every operation here refuses with a sentence that names
   * what is wrong** — `readProject`'s reasons and the print gate's are the same kind of thing,
   * and a caller that summarised them would throw away the only line a person can act on.
   *
   * @param notice Where to put a refusal: this popover's or that one's.
   */
  const attempt = async (
    notice: (message: string | undefined) => void,
    /** Put in the status line on success, or `undefined` to leave the mesh readout alone. */
    done: string | undefined,
    action: () => Promise<void>,
  ): Promise<void> => {
    notice(undefined);
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      notice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // **In a `finally`, because a refusal must not leave the actions disabled.** Every button
      // in the panel reads `busy`, and the most likely thing to be refused is an open — which is
      // exactly the moment the buttons most need to be live again.
      setBusy(false);
    }
    if (done !== undefined) setStatus(done);
  };

  /** Puts a model, a palette and a view into the store as one undoable step. */
  const loadInto = (
    project: {
      parts: readonly Part[];
      palette: readonly { r: number; g: number; b: number; a: number }[];
      view: { mode: MeshMode; resolution: number };
    },
    label: string,
  ): boolean => {
    // **The view settings come back too**, because the mesher is the one control here that
    // alters what the model *is* rather than how it is drawn — so a file that set the mesher
    // to cubes and was reopened at nets would be a model that quietly changed.
    setMode(project.view.mode as MeshMode);
    setResolution(project.view.resolution as (typeof RESOLUTIONS)[number]);
    // **The palette outside the history, deliberately.** A palette entry is not a fact about
    // the model's geometry, so rewinding it alongside would take a colour away from a model
    // that is still using it. See `createPalette`.
    palette.set(project.palette);
    return store.load(project.parts, label);
  };

  /**
   * Starts a document over, with the default model in it.
   *
   * **And throws the draft away**, which is the half that is easy to leave out. Without it a
   * person who starts over, closes the tab and comes back would be given the document they
   * discarded — and that is how an autosave becomes something people stop trusting.
   */
  const newDocument = (): void => {
    void clearDraft();
    setDraftAt(undefined);
    palette.set([]);
    setHome(NOWHERE);
    store.load(newModel(), "new model");
    setStatus("new model");
  };

  /** Writes the document to the browser's own store, as the debounced thing it is. */
  const draft = autosave(async () => {
    const blob = await writeBlob();
    await saveDraft(blob);
    setDraftAt(Date.now());
  });

  /** Opens the file somebody picks and loads it. */
  const openFromDisk = async (
    picker: HTMLInputElement | undefined,
  ): Promise<void> =>
    attempt(setFileNotice, "opened", async () => {
      const opened: OpenedFile | undefined = await chooseFileToRead(
        picker,
        PROJECT_CHOICE,
      );
      // **A dismissed picker is not a failure and says nothing.** An input's promise only
      // resolves on `change`, so without the `cancel` listener a person who backs out would
      // leave this waiting for the rest of the session.
      if (opened === undefined) return;

      // **Imported here rather than at the top of the module.** `jszip` is a hundred kilobytes
      // and nothing on the first frame needs it, so opening a model costs opening a model and
      // not everybody's first paint.
      const { readProject } = await import("./file/project");
      const project = await readProject(opened.blob);

      if (!loadInto(project, `open ${opened.name}`)) {
        throw new Error(
          "this file holds parts or ids this application cannot use — see the parts limit",
        );
      }
      // **A file with no handle — an opened download — has no home**, which means the next Save
      // asks rather than downloading a second copy under a name the browser invented.
      setHome(
        opened.handle === undefined
          ? NOWHERE
          : {
              kind: "file",
              id: newEntryId(),
              handle: opened.handle,
              name: opened.name,
            },
      );
      if (opened.handle !== undefined) {
        await rememberFile(opened.handle, store.parts().length);
        await refreshRecent();
      }
      setFileNotice(undefined);
    });

  /** Opens a file this browser has opened before, asking for permission in the click. */
  const openRecent = async (file: RecentFile): Promise<void> =>
    attempt(setFileNotice, "opened", async () => {
      const blob = await readThrough(file.handle);
      // **One sentence for every reason it could not be read** — permission refused, the file
      // moved, the disk unplugged — because the caller does one thing about all of them and a
      // message naming which would be a niceness rather than a difference.
      if (blob === undefined) {
        throw new Error(
          `could not read ${file.name} — permission or the file is gone`,
        );
      }

      const { readProject } = await import("./file/project");
      const project = await readProject(blob);

      if (!loadInto(project, `open ${file.name}`)) {
        throw new Error(
          "this file holds parts or ids this application cannot use — see the parts limit",
        );
      }
      setHome({
        kind: "file",
        id: file.id,
        handle: file.handle,
        name: file.name,
      });
      setFileNotice(undefined);
      await refreshRecent();
    });

  /** Re-reads the list from storage, which is where it survives a reload. */
  const refreshRecent = async (): Promise<void> => {
    setRecent(await listRecentFiles());
  };

  /**
   * Writes the document where it came from, or asks where if that is not known.
   *
   * **One function rather than Save and Save as**, because the difference between them is
   * entirely whether the document has a home, and a caller that had to choose would be choosing
   * on the person's behalf.
   */
  const saveToDisk = async (): Promise<void> =>
    attempt(setFileNotice, "saved", async () => {
      const here = home();
      const writer = homeWriter(here);

      const target: WriteTarget | undefined =
        writer !== undefined && here.kind === "file"
          ? { name: here.name, handle: here.handle, write: writer }
          : await choosePlaceToWrite(
              PROJECT_CHOICE,
              here.kind === "file" ? here.name : DEFAULT_PROJECT_NAME,
            );

      // **Two different reasons the picker can be `undefined`, and they are told apart.**
      // On a browser with no such dialog it is "there is nowhere to write", where a download is
      // the only way to put a file anywhere. On a browser that has one it is "the person closed
      // it", where writing a file anyway would be the last thing they asked for — and the same
      // `undefined` for both is a download landing on every accidental Escape.
      if (target === undefined) {
        if (writer !== undefined || remembersFiles()) return;
        await writeDownload();
        return;
      }

      const blob = await writeBlob();
      await target.write(blob);

      // **The handle the picker handed back becomes the document's home**, which is the whole
      // reason for asking through the File System Access API at all: the next Save writes to the
      // same file rather than asking again, and the file joins the list under a name that is
      // there rather than one the browser guessed.
      setHome({
        kind: "file",
        id: newEntryId(),
        handle: target.handle,
        name: target.name,
      });
      await rememberFile(target.handle, store.parts().length);
      await refreshRecent();
      setFileNotice(undefined);
    });

  /** The document as a project file. */
  const writeBlob = (): Promise<Blob> =>
    import("./file/project").then(({ writeProject }) =>
      writeProject(store.parts(), palette.colours(), {
        mode: mode(),
        resolution: resolution(),
      }),
    );

  /** Offers the document as a download, which is all a browser without the API can do. */
  const writeDownload = async (): Promise<void> => {
    const blob = await writeBlob();
    const here = home();
    const name = here.kind === "file" ? here.name : DEFAULT_PROJECT_NAME;
    downloadBlob(blob, name);
    // **The name is remembered even for a download**, and the home stays `nowhere`. A download
    // gives back no handle, so a second Save should ask again rather than pretend to know where
    // the last one went — but it should not ask about a name either, and somebody who has just
    // saved twice wants the same file name both times.
    setHome(here);
  };

  /** Writes the model as a `.3mf` for a slicer. */
  const exportPrint = async (): Promise<void> =>
    // **Nothing in the status line**, because the status line is the mesh readout and a print
    // that worked says something the mesh did not: the file exists somewhere.
    attempt(setFileNotice, undefined, async () => {
      const heightMm = numberIn(height(), 0.1);
      if (heightMm === undefined) {
        throw new Error("a printed model needs a height above the bed");
      }
      const maxColours = numberIn(filaments(), 1);
      if (maxColours === undefined || !Number.isInteger(maxColours)) {
        throw new Error("a printed model needs room for at least one colour");
      }

      const { exportThreeMf } = await import("./print/export-model");
      const blob = await exportThreeMf(store.parts(), { heightMm, maxColours });

      const target = await choosePlaceToWrite(
        THREE_MF_CHOICE,
        `${stemOf()}.3mf`,
      );
      // **A download only where the browser has no dialog at all.** A dismissed dialog is
      // silence, not consent — and treating the two alike is how a print ends up on a disk
      // somebody did not ask for it to reach.
      if (target === undefined) {
        if (remembersFiles()) return;
        downloadBlob(blob, `${stemOf()}.3mf`);
        return;
      }
      await target.write(blob);
    });

  /**
   * A name for the print, taken from the document's.
   *
   * **The stem without its extension**, so a print of `duck.sdfmod` is `duck.3mf` rather than
   * `duck.sdfmod.3mf` — which is what every other tool on the machine would produce and what a
   * person who has five of these in a folder would expect.
   */
  const stemOf = (): string => {
    const here = home();
    const name = here.kind === "file" ? here.name : DEFAULT_PROJECT_NAME;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  };

  // **Two functions, because Solid 2's `createEffect` takes a compute and an effect.**
  // The single-function form is Solid 1 and throws `MISSING_EFFECT_FN` at runtime while
  // type-checking perfectly, because the type is a pair of optional-looking arguments.
  //
  // Splitting them is also the clearer shape here: the first says *what to watch* and the
  // second says *what to do about it*. Under Solid 1's form both were in one closure, and
  // the dependency was invisible — a reader could not tell that reading `store.parts()`
  // and discarding the result was the entire mechanism.
  createEffect(
    () => store.parts(),
    (parts) => rebuild(parts),
  );

  /*
   * **The mesher and the resolution watch their own effects, because both change the mesh and
   * neither changes the model.**
   *
   * A model is a list of parts, so `store.parts()` is the only thing a rebuild used to depend on and
   * turning a mode on was not a model edit — there was nothing for that effect to fire on. Reading
   * the parts again here is the point rather than an accident: the rebuild needs the list, and the
   * list has to come from a tracked read.
   *
   * They are two effects rather than one watching both, because `rebuild` debounces by ninety
   * milliseconds and one effect over two signals would re-arm the timer whenever either moved —
   * including when they moved together, which is not a thing a person does.
   */
  createEffect(
    () => mode(),
    () => rebuild(store.parts()),
  );
  createEffect(
    () => resolution(),
    () => rebuild(store.parts()),
  );

  // **Solid 2 replaced `onMount` with `onSettled`**, which fires once after the current
  // activity settles rather than on mount, and which does *not* return a disposal: the
  // callback returns the teardown itself. `onCleanup` *inside* one is a dev-mode error
  // that halts the reactive system, so the two halves of the lifecycle live in this one
  // block and the block's last statement is its own undo.
  /**
   * Restores whatever this browser was holding, once there is a scene to put it in.
   *
   * **Silently, and that is a decision.** Every editor worth using does it — a reload giving you
   * an empty canvas after you had just built something is how an autosave becomes something
   * people turn off. The cost is a person who wanted a new document and reloaded instead of
   * pressing New, and New is one tap further away than reloading is.
   *
   * **Restored through the same reader as a file**, on the same bytes, so a draft cannot be a
   * different shape from a `.sdfmod` and cannot be a version this build does not read. A draft
   * this build refuses is cleared rather than left to be refused again on every reload.
   *
   * **The home stays `nowhere`**, because the bytes came from this browser's database and not
   * from a file — so the first Save after a restore asks where the document goes, rather than
   * quietly claiming it can write the draft slot back.
   */
  const restoreDraft = async (): Promise<void> => {
    const held = await readDraft();
    if (held === undefined || held === null) return;

    try {
      const { readProject } = await import("./file/project");
      const project = await readProject(held.blob);
      if (!loadInto(project, "restore")) return;
      setDraftAt(held.at === 0 ? Date.now() : held.at);
      setStatus("restored from this browser");
    } catch {
      // **A draft this build cannot read is thrown away rather than kept.**
      // Leaving it means every reload from now on spends the same work failing the same way, and
      // a person cannot act on a message about bytes they never asked to save.
      await clearDraft();
      setDraftAt(undefined);
    }
  };

  onSettled(() => {
    const viewport = createViewport(canvas);
    const created = createModelView(viewport.scene);
    const controller = createOrbit(viewport.camera);
    const madeHandles = createMoveHandles(viewport.scene);
    const madeGhost = createGhost(viewport.scene);
    view = created;
    orbit = controller;
    handles = madeHandles;
    ghost = madeGhost;
    camera = viewport.camera;

    /**
     * Takes a drag off the camera, or leaves it to the camera.
     *
     * **Attached before `controller.attach`, so that it is the first listener to see a
     * pointer-down.** The order matters: the camera's own handler takes the pointer capture
     * the moment it sees a press, and once it has, a handle drag cannot have it. So the
     * question of which of the two wants this press has to be settled first, and the only
     * way to settle it is to be first.
     */
    const onPointerDown = (event: PointerEvent): void => {
      void grabHandle(event as PointerEvent & { currentTarget: HTMLElement });
    };
    canvas.addEventListener("pointerdown", onPointerDown);

    const detach = controller.attach(canvas);
    viewport.renderer.setAnimationLoop(() => {
      standHandles();
      viewport.render();
    });

    // The first mesh, now that there is a scene to put it in. The effect above may have
    // run before this and found nothing to do.
    //
    // **Read through `untrack`, because this is outside the effect that tracks the parts.**
    rebuild(untrack(() => store.parts()));

    // **After the first mesh, and not before.** Restoring writes to the store, which arms the
    // rebuild effect — so restoring first would mesh the default model and then mesh the
    // restored one, and on a phone that is a second of nothing on screen. Restoring after also
    // means the first thing anybody sees is their model rather than the placeholder.
    //
    // **Awaits nothing.** A draft that takes a moment to arrive should not hold up the scene,
    // and the rebuild effect will pick it up when it lands.
    void Promise.all([restoreDraft(), refreshRecent()]);

    return () => {
      if (pending !== undefined) clearTimeout(pending);
      draft.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      detach();
      madeHandles.dispose();
      madeGhost.dispose();
      created.dispose();
      viewport.dispose();
      // Cleared, so a rebuild arriving after teardown cannot reach a disposed renderer.
      view = undefined;
      orbit = undefined;
      handles = undefined;
      ghost = undefined;
      camera = undefined;
    };
  });

  const selected = createMemo(() => {
    const id = store.selected();
    return id === undefined ? undefined : store.part(id);
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />

      <header class={styles.header}>
        <h1 class={styles.title}>sdf-modeller</h1>
        {/*
         * **The readout carries its own full text in a `title`.** It is the longest string in
         * the shell and it is one line with an ellipsis, because a second line would push the
         * header's bottom edge down through the tool row — see `.status` in
         * `app.module.css`, and the chain it is measured against. A `title` is what keeps the
         * tail of the sentence reachable on a screen too narrow to show it.
         */}
        <p class={styles.status} title={status()}>
          {status()}
        </p>
      </header>

      {/*
       **Two named tools, as a radio group, because they are one choice with two answers.**
       *
       * A pair of buttons that each toggled something would leave the question of which
       * tool is current to be answered by which button looks pressed — and "looks pressed"
       * is not an answer a screen reader gives you either. `radiogroup` says out loud that
       * exactly one of these is in effect, which is the truth, and `aria-checked` carries
       * it to assistive technology the same way the appearance does.
       *
       * **The move tool is disabled with nothing selected**, because there is nothing for
       * it to move. Rather than arming a tool that would refuse every press, which teaches
       * the button is broken, it says so.
       */}
      <div class={styles.tools} role="radiogroup" aria-label="Tool">
        {(
          [
            [
              "select",
              "Select",
              "Pick parts. Drag the canvas to turn the view.",
            ],
            [
              "move",
              "Move",
              "Arrow handles on the selected part. Drag one to move it.",
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            type="button"
            role="radio"
            class={styles.tool}
            aria-checked={tool() === value ? "true" : "false"}
            title={hint}
            disabled={value === "move" && selected() === undefined}
            onClick={() => {
              setTool(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        **The mesher chooser and the resolution, on their own row, for the same reason the tools
        are a radio group: one choice with several answers.**

        The mesher is a genuine choice rather than a quality slider, because the two produce
        different meshes from the same field — one is closed throughout and the other is not
        everywhere — so there is no ordering to slide along. What the resolution *is* a slider of is
        work: each step doubles the samples on every axis, and the cost is cubic in the reciprocal.
      */}
      <div class={styles.render}>
        <div class={styles.mesher} role="radiogroup" aria-label="Mesher">
          {MESH_MODES.map((option) => (
            <button
              type="button"
              role="radio"
              class={styles.tool}
              aria-checked={mode() === option.value ? "true" : "false"}
              title={option.hint}
              onClick={() => {
                setMode(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label class={styles.resolution}>
          <span class={styles.resolutionLabel}>Resolution</span>
          {/*
            **The slider's position is an index into `RESOLUTIONS` and not a voxel size.** The
            sizes halve as the index rises, so a slider whose value were the size itself would run
            backwards — the coarse end on the right — and a person would learn that by dragging it
            and watching the model get worse.

            `aria-valuetext` because the bare number a range reports is an index, and "2" is not a
            resolution. The text is what a screen reader says out loud, so it has to be the thing a
            person would have said.
          */}
          <input
            type="range"
            min={0}
            max={RESOLUTIONS.length - 1}
            step={1}
            value={RESOLUTIONS.indexOf(resolution())}
            aria-valuetext={`${resolution()} world units a voxel`}
            onInput={(event) => {
              const chosen = RESOLUTIONS[event.currentTarget.valueAsNumber];
              if (chosen !== undefined) setResolution(chosen);
            }}
          />
        </label>
      </div>

      {/*
        **The tab bar is only ever visible on a narrow screen** — a CSS rule, not a media
        query in the component, so that rotating a phone does not tear the tree down and
        rebuild it (ADR 0026's `Activity` exists for exactly that, and here the layout
        handles itself instead).

        `aria-selected` rather than a class, because it is the same attribute a screen
        reader asks about and the styling hangs off it rather than duplicating the state.
      */}
      <div class={styles.tabs} role="tablist" aria-label="Panels">
        {(
          [
            [
              "parts",
              `Parts${store.parts().length > 0 ? ` (${store.parts().length})` : ""}`,
            ],
            ["shape", "Shape"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            class={styles.tab}
            aria-selected={sheet() === id ? "true" : undefined}
            onClick={() => {
              setSheet(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <Show when={selected()}>
        {(part) => (
          <div
            class={styles.sheet}
            data-hidden={sheet() === "parts" ? "" : undefined}
          >
            <TransformPanel part={part()} store={store} palette={palette} />
          </div>
        )}
      </Show>

      <div
        class={styles.sheet}
        data-hidden={sheet() === "shape" ? "" : undefined}
      >
        <PartsPanel store={store} primitives={PRIMITIVE_NAMES} />
      </div>

      {/*
        **The picker `/open` clicks, and the one nothing else needs to know about.**
        `display: none` rather than visually hidden, and it is a sibling of the canvas rather
        than inside a panel, because a file dialog is not a text field and giving the interface
        two of its own would be worse. Copied from `apps/bm-sculpt/src/app.tsx`, which
        discovered that the browser's is not reliable everywhere.
      */}
      <input ref={picker} type="file" style={{ display: "none" }} />

      {/*
        **"Your files" as a modal dialogue rather than a menu in the corner.**
        The actions are five buttons and would fit anywhere; the list of files is a grid of cards
        and wants the whole screen. The dialogue's positioning is in `app.module.css` rather than
        here, so one stylesheet owns the whole screen's composition.
      */}
      <Files.Dialog class={styles.filesDialog}>
        <FilesPanel
          home={home}
          parts={() => store.parts().length}
          palette={palette.colours}
          recent={recent}
          canRemember={canRemember}
          draftAt={draftAt}
          mesh={mesh}
          height={height}
          filaments={filaments}
          notice={fileNotice}
          busy={busy}
          onNew={() => {
            newDocument();
          }}
          onOpen={() => {
            void openFromDisk(picker);
          }}
          onSave={() => {
            void saveToDisk();
          }}
          onExport={() => {
            void exportPrint();
          }}
          onHeight={setHeight}
          onFilaments={setFilaments}
          onOpenRecent={(file) => {
            void openRecent(file);
          }}
          onForgetRecent={(id) => {
            void forgetFile(id).then(refreshRecent);
          }}
          onClose={() => {
            Files.close();
          }}
        />
      </Files.Dialog>

      <footer class={styles.footer}>
        <button
          type="button"
          class={styles.action}
          disabled={!store.canUndo()}
          onClick={() => {
            store.undo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          class={styles.action}
          disabled={!store.canRedo()}
          onClick={() => {
            store.redo();
          }}
        >
          Redo
        </button>

        {/*
          **One button here, and the file actions are in a dialogue.**
          A footer of Undo, Redo, New, Open, Save and Export is six `--ui-size` targets across
          the bottom of a phone, which is most of the width and none of the height a thumb wants —
          and it is not even the right shape, because "your files" is a *list of files* and a list
          of files does not fit in the corner of a screen. The sibling keeps the tools in the
          shell and the files in a dialogue, and that is what this does.
        */}
        <button
          type="button"
          class={styles.action}
          aria-label="Your files"
          title="Your files"
          onClick={() => {
            Files.open();
          }}
        >
          Files
        </button>
        <span class={styles.hint}>drag to orbit · pinch to zoom</span>
      </footer>
    </div>
  );
}
