// Step 4: what do you want to save? Format options, previews, the stamp, and opening a saved
// scene file. Files are made in the browser and saved to the device; nothing is uploaded.
import { stillsFor } from "../review/stills";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { MAX_SCENE_BYTES, canonicalJson, formatStamp, parseScene, parseSceneFile, sha256Hex, shortFingerprint, type ExportBundle, type ExportFile, type ExportFormat } from "@csd/core";
import { Tab, TabList, TabPanel } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { FILE_WORDS, bundleDownload, downloadFile, type DownloadItem } from "../lib/download";
import { useSimulation } from "../review/useSimulation";
import { mapThumbnail } from "../services/thumbnail";
import { useServices } from "../services/context";
import { docFromScene } from "../state/doc";
import { useDoc } from "../state/DocProvider";
import { docKey, useFlow } from "../state/Flow";
import { useRoads } from "../state/Roads";
import { useUi } from "../state/Ui";
import { Tips } from "../tips/Tips";
import { FullSizeDialog, JsonPreview, PdfPreview, PngPreview, findFile, useObjectUrls, type PreviewKind } from "./Previews";
import { useBundlePreview } from "./useBundlePreview";

type Choice = "pdf" | "png" | "json";
const FORMATS: Record<Choice, ExportFormat> = { pdf: "pdf", png: "png-diagram", json: "json" };

/** The scene file always comes with pictures and PDFs: the fingerprint in them is the hash of that file. */
export const JSON_WITH_PICTURES_HINT = "Always saved with pictures and PDFs, so the fingerprint can be checked.";
export const PREVIEW_UNAVAILABLE_TEXT = "This file isn't available to preview in this build.";

export const tooBigText = (bytes: number): string =>
  `That file is too big to be a scene file (${(bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_SCENE_BYTES / 1e6} MB).`;

/** Read out (and focus moved to the button) when building outlasted the tap window and one more tap is needed. */
export const SECOND_TAP_TEXT = "Your files are ready. Press “Download your files” to save them.";

/** How long after a tap a page may still start a download (browsers allow about 5 s; stay well inside). */
const ACTIVATION_WINDOW_MS = 3000;

export function SaveStep() {
  const { doc, dispatch } = useDoc();
  const scene = doc.scene;
  const services = useServices();
  const roads = useRoads();
  const flow = useFlow();
  const { lastExport, setLastExport, showToast, setQuery } = useUi();
  const outcome = useSimulation(scene);
  const [chosen, setChosen] = useState<Record<Choice, boolean>>({ pdf: true, png: true, json: false });
  const [preview, setPreview] = useState<PreviewKind>("pdf");
  const built = useBundlePreview(scene, outcome?.ok ? outcome.result : null, roads.net);
  const bundle = built?.status === "ready" ? built.bundle : null;
  const urls = useObjectUrls(bundle);
  const [saving, setSaving] = useState(false);
  /** A save that took too long for the browser to still count the tap: the next tap downloads it. */
  const [ready, setReady] = useState<{ item: DownloadItem; sceneKey: string } | null>(null);
  const [openErrors, setOpenErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const sceneKey = canonicalJson(scene);
  const secondTap = ready && ready.sceneKey === sceneKey ? ready : null;
  // The primary button changes under the person (Save to my device <-> Download your files): focus goes with it, so a
  // keyboard or screen reader user lands on the button that now does the job (the live region below says why).
  const primaryRef = useRef<HTMLButtonElement>(null);
  const hadSecondTap = useRef(false);
  useEffect(() => {
    // Only when focus is nowhere in particular or already on that button: never pulled away from what the person is using.
    const el = primaryRef.current;
    const free = document.activeElement == null || document.activeElement === document.body || document.activeElement === el;
    if (hadSecondTap.current !== (secondTap != null) && free) el?.focus();
    hadSecondTap.current = secondTap != null;
  }, [secondTap]);
  const current = lastExport && lastExport.sceneKey === sceneKey ? lastExport : null;
  const stale = lastExport != null && current == null;

  async function save() {
    if (saving || !outcome?.ok) return;
    const picked = (Object.keys(chosen) as Choice[]).filter((k) => chosen[k]);
    if (!picked.length) { showToast("Pick at least one file to save."); return; }
    // The exports package always adds the scene file to a PDF or a picture; ask for it so the request says what happens.
    const stills = stillsFor(scene);
    // Pictures = the top-down diagram plus, when the 3D view was available, the impact and final-rest stills.
    const formats = [...new Set<ExportFormat>([
      ...picked.map((k) => FORMATS[k]),
      // Always ask for the 3D pictures with "Pictures": if they couldn't be taken, the save says so plainly.
      ...(chosen.png ? (["png-impact", "png-rest"] as const) : []),
      ...(chosen.pdf || chosen.png ? (["json"] as const) : []),
    ])];
    setSaving(true);
    try {
      const thumb = mapThumbnail.get(scene.location);
      const started = performance.now();
      const bundle = await services.exports.build({ scene, sim: outcome.result, roads: roads.net, formats, ...(thumb ? { mapThumbnail: thumb } : {}), ...(stills ? { stills } : {}) });
      const item = bundleDownload(bundle);
      setLastExport({ stamp: bundle.stamp, sceneKey });
      const words = [...new Set(bundle.files.map((f) => FILE_WORDS[f.mime]))];
      // The exports package may report files it left out and plain notes for the person saving.
      const more = [...bundle.skipped.map((x) => x.reason), ...bundle.notes].map((t) => t.trim()).filter(Boolean);
      if (!item) { showToast(["Nothing was saved.", ...more].join(" ")); return; }
      const what = item.mime === "application/zip" ? `one zip file with the ${words.join(", ")}` : words.join(", ");
      // Browsers only let a page start a download shortly after a tap. If building took longer,
      // ask for one more tap instead of failing silently.
      if (performance.now() - started > ACTIVATION_WINDOW_MS) {
        setReady({ item, sceneKey });
        // The line by the button says so (and stays, where a toast would time out); the toast only carries the notes.
        if (more.length) showToast(more.join(" "));
        return;
      }
      downloadFile(item);
      showToast([`Saved to your device: ${what}.`, ...more].join(" "));
    } catch (e) {
      const why = (e instanceof Error && e.message ? e.message : "something went wrong").replace(/\.+$/, "");
      showToast(`Saving didn't finish: ${why}. Nothing was saved.`);
    } finally {
      setSaving(false);
    }
  }

  // Open a saved scene file. The size is checked before the file is read into memory.
  async function openFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOpenErrors([]);
    if (file.size > MAX_SCENE_BYTES) { setOpenErrors([tooBigText(file.size)]); return; }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      setOpenErrors(["We couldn't read that file."]);
      return;
    }
    const parsed = parseSceneFile(bytes);
    if (!parsed.ok) { setOpenErrors(parsed.errors); return; }
    const fresh = parseScene(parsed.value);
    if (!fresh.ok) { setOpenErrors(fresh.errors); return; }
    let fp = "";
    try { fp = shortFingerprint(await sha256Hex(new TextDecoder().decode(bytes))); } catch { /* no Web Crypto here: open without the fingerprint */ }
    const next = docFromScene(fresh.value, doc.claimAddress);
    dispatch({ type: "replace", doc: next });
    setQuery(fresh.value.location.label || doc.claimAddress);
    setLastExport(null);
    flow.goTrusted("review", docKey(next));
    // Moving to Review clears toasts, so this one is shown just after the move.
    const opened = `Opened the scene saved ${formatStamp(parsed.value.createdAt)}.${fp ? ` File fingerprint ${fp}.` : ""}`;
    window.setTimeout(() => showToast(opened), 0);
  }

  const options: Array<{ id: Choice; title: string; desc: string }> = [
    { id: "pdf", title: "PDF summary", desc: "One page: place and time, map, diagram, each vehicle, distances, assumptions and the notice." },
    { id: "png", title: "Diagram picture", desc: "Top-down picture with distances in feet and meters. Impact and final-rest pictures come with 3D." },
    { id: "json", title: "Scene file", desc: "Open it here again to get the exact same recreation." },
  ];

  return (
    <section aria-labelledby="h-export">
      <div className="split split-save">
        <div className="split-head">
          <h1 className="title" id="h-export">What do you want to save?</h1>
          <p className="lede">Made on your device. Nothing is uploaded.</p>
        </div>

        <Tips step="export" />

        <div className="split-side">
          <div className="preview-frame">
            {outcome?.ok ? (
              <>
                <TabList className="segmented preview-tabs" value={preview} onChange={(v) => setPreview(v as PreviewKind)} idBase="preview" aria-label="Preview">
                  <Tab value="pdf">PDF</Tab>
                  <Tab value="png">Diagram</Tab>
                  <Tab value="json">Scene file</Tab>
                </TabList>
                {(["pdf", "png", "json"] as const).map((kind) => (
                  <TabPanel key={kind} className="preview-panel" idBase="preview" value={kind} current={preview}>
                    <PreviewBody kind={kind} built={built} bundle={bundle} urls={urls} />
                  </TabPanel>
                ))}
              </>
            ) : (
              <p className="hint" role="status">{outcome == null ? "Loading the road layout…" : "We can't draw a preview until the details fit together."}</p>
            )}
          </div>
        </div>

        <div className="split-main">
          <fieldset className="options">
            <legend className="visually-hidden">Files to save</legend>
            {options.map((o) => {
              const locked = o.id === "json" && (chosen.pdf || chosen.png);
              return (
                <label className="option" key={o.id}>
                  <input type="checkbox" name="fmt" value={o.id} checked={locked || chosen[o.id]} disabled={locked} onChange={(e) => setChosen((c) => ({ ...c, [o.id]: e.target.checked }))} />
                  <span className="option-body">
                    <span className="option-title">{o.title}</span>
                    <span className="option-desc">{o.desc}</span>
                    {locked ? <span className="option-desc" data-testid="json-hint">{JSON_WITH_PICTURES_HINT}</span> : null}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="open-scene">
            <label className="link-btn" htmlFor="open-scene">Open a saved scene file</label>
            <input id="open-scene" ref={fileInput} type="file" className="visually-hidden" accept="application/json,.json" onChange={(e) => void openFile(e)} />
            {openErrors.length ? <ul className="open-errors" role="alert">{openErrors.map((m) => <li key={m}>{m}</li>)}</ul> : null}
          </div>

          <div className="coming">
            <p className="group-label">Coming next</p>
            <p className="coming-row"><strong>Video clip.</strong> Needs an in-browser video encoder and a size limit.</p>
            <p className="coming-row"><strong>Share link.</strong> Needs hosting, link expiry and control over who can open it.</p>
          </div>

          <div className={`stamp${stale ? " is-stale" : ""}`} aria-live="polite" data-testid="stamp">
            {current ? (
              <>
                <span>Saved <strong>{formatStamp(current.stamp.createdAt)}</strong></span>
                <span>Fingerprint <strong className="num">{current.stamp.fingerprintShort}</strong></span>
              </>
            ) : stale && lastExport ? (
              <span>You changed the scene after saving at {formatStamp(lastExport.stamp.createdAt)}. Save again to update the files.</span>
            ) : (
              <span>The time of saving and a fingerprint are added to every file when you save.</span>
            )}
          </div>

          <div className="actions">
            <button type="button" className="btn btn-quiet" onClick={() => flow.go("review")}><Icon name="arrow-left" className="icon-sm" />Back</button>
            {secondTap ? (
              <button ref={primaryRef} type="button" className="btn btn-primary" onClick={() => { downloadFile(secondTap.item); setReady(null); showToast("Saved to your device."); }}><Icon name="download" className="icon-sm" />Download your files</button>
            ) : (
              <button ref={primaryRef} type="button" className="btn btn-primary" aria-busy={saving || undefined} disabled={!outcome?.ok} onClick={() => void save()}><Icon name="download" className="icon-sm" />Save to my device</button>
            )}
          </div>
          {/* Always in the page (a region added with its text is often not read): shown and read out when the second tap is
              needed, and it stays until then (a toast would time out). The one place that says it, so it is read once. */}
          <p className={secondTap ? "hint save-ready" : "visually-hidden"} aria-live="polite" data-testid="save-ready">{secondTap ? SECOND_TAP_TEXT : ""}</p>
        </div>
      </div>
    </section>
  );
}

function PreviewBody({ kind, built, bundle, urls }: { kind: PreviewKind; built: ReturnType<typeof useBundlePreview>; bundle: ExportBundle | null; urls: ReadonlyMap<ExportFile, string> }) {
  const [full, setFull] = useState(false);
  if (!built || built.status === "building") return <p className="hint" role="status" aria-busy="true">Making the preview…</p>;
  if (built.status === "error") return <p className="hint" role="alert">{built.message}</p>;
  const file = bundle ? findFile(bundle, kind) : undefined;
  if (!file) {
    const why = built.bundle.skipped.map((x) => x.reason).filter(Boolean).join(" ");
    return <p className="hint" role="status">{why || PREVIEW_UNAVAILABLE_TEXT}</p>;
  }
  const url = urls.get(file);
  const title = kind === "pdf" ? "PDF summary, full size" : "Diagram picture, full size";
  return (
    <>
      {kind === "pdf" ? <PdfPreview file={file} /> : kind === "png" ? (url ? <PngPreview url={url} /> : null) : <JsonPreview file={file} />}
      {full ? (
        <FullSizeDialog title={title} onClose={() => setFull(false)}>
          {kind === "pdf" ? <PdfPreview file={file} /> : url ? <PngPreview url={url} /> : null}
        </FullSizeDialog>
      ) : null}
      <p className="preview-open">
        {kind !== "json" ? <button type="button" className="link-btn" aria-haspopup="dialog" onClick={() => setFull(true)}>Open full size</button> : null}
        <span className="hint">Preview made {formatStamp(built.bundle.stamp.createdAt)}. The files you save carry the time you press Save.</span>
      </p>
    </>
  );
}
