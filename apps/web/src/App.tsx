// The app: providers (services, the shared scene, UI state, roads, the step flow) and the shell.
import { Component, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { hasWebGL, loadViewer } from "./viewer/load-viewer";
import { AboutDialog, DisclaimerBar, Header, Stepper, Toast } from "./components/Shell";
import { ReviewSkeleton, ReviewStep } from "./review/ReviewStep";
import { LoadAnnouncer, announceLoad } from "./review/LoadAnnouncer";
import { LocationStep, SaveStep, VehiclesStep, preloadStep } from "./steps";
import { ServicesProvider, useServices } from "./services/context";
import type { Services } from "./services/types";
import { contentKey, docFromScene, initialDoc } from "./state/doc";
import { DocProvider, useDoc } from "./state/DocProvider";
import { FlowProvider, STEPS, docKey, useFlow } from "./state/Flow";
import { RoadsProvider } from "./state/Roads";
import { UiProvider, useUi } from "./state/Ui";
import { TipsProvider } from "./tips/TipsProvider";
import { bootPreload } from "./boot";
import { fixturesAllowed } from "./services/fixtures";
import { shouldShowWelcome, writeWelcomeSeen } from "./welcome/storage";
import { WELCOME_EXAMPLE, WelcomeDialog } from "./welcome/WelcomeDialog";
import { claimFromSearch } from "./lib/claim";

function Screen() {
  const { step } = useFlow();
  switch (step) {
    case "location": return <LocationStep />;
    case "vehicles": return <VehiclesStep />;
    case "review": return <ReviewStep />;
    case "export": return <SaveStep />;
  }
}

const NEXT_STEP_DELAY_MS = 2000;

/**
 * A step whose code could not be fetched says so, with Retry, instead of taking the page down. The browser
 * keeps a failed module fetch, so Retry reloads the page (the scene is kept in session storage).
 */
class StepBoundary extends Component<{ step: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidUpdate(prev: { step: string }): void { if (prev.step !== this.props.step && this.state.failed) this.setState({ failed: false }); }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="review-wait example-failed" role="alert">
        <p>We couldn't load this step. Check your connection and try again.</p>
        <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }
}

type ExampleState ="loading" | "ready" | { missing: string } | { failed: string };

const exampleInUrl = (): string | null => new URLSearchParams(window.location.search).get("example");
/** One ask to open an example (a new object each time, so asking for the same one again loads it again). */
interface ExampleRequest { readonly name: string | null }
/** Drops these switches from the address (no reload, no new history entry). */
function dropFromUrl(...keys: string[]): void {
  const p = new URLSearchParams(window.location.search);
  if (!keys.some((k) => p.has(k))) return;
  for (const k of keys) p.delete(k);
  const q = p.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
}
/** This page's query string with the welcome's example in it (other switches, such as ?theme=, are kept). */
function exampleSearch(): string {
  const p = new URLSearchParams(window.location.search);
  p.set("example", WELCOME_EXAMPLE);
  return `?${p.toString()}`;
}

/**
 * ?example=<name> opens that example straight on the review step (examples are known-good, so no gate). `name` is the
 * URL's example, or one asked for later (the welcome's "Try an example"), which then loads the same way.
 */
function useExample(request: ExampleRequest): { state: ExampleState; retry: () => void } {
  const { name } = request;
  const services = useServices();
  const { dispatch } = useDoc();
  const flow = useFlow();
  const { setQuery } = useUi();
  const [state, setState] = useState<ExampleState>(name ? "loading" : "ready");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(request);
  // A new request after the first render shows the loading state at once, like a link to it would.
  if (loading !== request) { setLoading(request); if (name) setState("loading"); }
  const { goTrusted } = flow;
  useEffect(() => {
    if (!name) return;
    let off = false;
    services.examples.load(name).then((scene) => {
      if (off) return;
      if (!scene) { setState({ missing: name }); return; }
      const next = docFromScene(scene, scene.location.label, { example: name });
      dispatch({ type: "replace", doc: next });
      setQuery(scene.location.label);
      goTrusted("review", docKey(next));
      setState("ready");
    }, () => { if (!off) setState({ failed: name }); });
    return () => { off = true; };
  }, [request, name, services, dispatch, setQuery, goTrusted, attempt]);
  const retry = useCallback(() => { setState("loading"); setAttempt((n) => n + 1); }, []);
  return { state, retry };
}

function Body() {
  const { step } = useFlow();
  const services = useServices();
  const { mode } = services;
  const [about, setAbout] = useState(false);
  const { doc, dispatch } = useDoc();
  const { setQuery } = useUi();
  const flow = useFlow();
  // ?example=<name> opens that example, unless this tab's scene is that example already edited: a reload never
  // reloads the example over the claimant's own work (the address loses ?example= at the first edit, below).
  const [exampleRequest, setExampleRequest] = useState<ExampleRequest>(() => {
    const name = exampleInUrl();
    if (name && !doc.example && doc.fromExample === name) { dropFromUrl("example"); return { name: null }; }
    return { name };
  });
  const { state: example, retry } = useExample(exampleRequest);
  // The first edit that changes an example ends it: no "Example data" chip, no made-up number, no ?example= in the address.
  useEffect(() => {
    if (!doc.example || example === "loading" || contentKey(doc) === doc.example.key) return;
    dispatch({ type: "leave-example" });
    dropFromUrl("example");
  }, [doc, example, dispatch]);
  // The first-visit welcome (DESIGN.md section 19), over step 1. Decided once, as the page opens.
  const [welcome, setWelcome] = useState(() => shouldShowWelcome({ search: window.location.search, hash: window.location.hash, fixtureMode: mode === "fixtures", fixturesAllowed: fixturesAllowed() }));
  /** Opened again from About this tool (not the first-visit one). */
  const [reopened, setReopened] = useState(false);
  const closeWelcome = useCallback(() => { writeWelcomeSeen(); setWelcome(false); }, []);
  const openWelcome = useCallback(() => { setReopened(true); setWelcome(true); }, []);
  // An InsurifyAI link's ?claim=<number> fills the claim number once: only into an empty number of the claimant's own
  // scene (never over a number they typed, an opened file's or an example's), then it leaves the address, so a reload
  // doesn't apply it again.
  const startDoc = useState(doc)[0];
  useEffect(() => {
    const number = claimFromSearch(window.location.search);
    if (number && !exampleInUrl() && startDoc.scene.claim.number === "" && startDoc.reconcile !== false) dispatch({ type: "claim-number", number });
    dropFromUrl("claim");
  }, [dispatch, startDoc]);
  // Reopened after details were entered: the example opens in a new tab, so nothing entered here is replaced. (docKey
  // leaves the claim out, so a claim number alone, as a ?claim= link fills it, is not work to keep.)
  // The answers count too: picking "Car", "Straight", 25 mph or "Front" is work even where it equals the placeholder.
  const [blank] = useState(() => initialDoc());
  const blankKey = docKey(blank);
  const answeredSomething = JSON.stringify(doc.unanswered ?? []) !== JSON.stringify(blank.unanswered) || doc.directionSet.some(Boolean);
  const keepWork = welcome && reopened && (docKey(doc) !== blankKey || answeredSomething);
  // "Start my own" (reopened over an example, or work that began as one): a new, empty scene on step 1.
  const fromExample = Boolean(doc.example || doc.fromExample);
  const startOwn = useCallback(() => {
    closeWelcome();
    dropFromUrl("example", "claim");
    const fresh = initialDoc();
    dispatch({ type: "replace", doc: fresh });
    setQuery(fresh.claimAddress);
    setExampleRequest({ name: null });
    flow.go("location");
  }, [closeWelcome, dispatch, setQuery, flow]);
  // "Try an example": the same as opening /?example=t-bone-intersection#review, without a reload. The URL says so too,
  // so a reload or a shared link opens the same example.
  const tryExample = useCallback(() => {
    closeWelcome();
    const search = exampleSearch();
    window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
    bootPreload(services, search, "#review");
    setExampleRequest({ name: WELCOME_EXAMPLE });
  }, [closeWelcome, services]);
  useEffect(() => {
    document.title = `${STEPS.find((s) => s.key === step)?.name ?? ""} · Crash scene illustration · InsurifyAI`;
  }, [step]);
  // Leaving Review empties its loading announcements, so a later visit starts from silence.
  useEffect(() => { if (step !== "review") announceLoad(""); }, [step]);
  // The next step's code loads in the background once this one has had time to settle (Review does its own, after its picture).
  useEffect(() => {
    const next = step === "location" ? () => preloadStep("vehicles") : step === "vehicles" ? () => { if (hasWebGL()) void loadViewer().catch(() => undefined); } : null;
    if (!next) return;
    const id = window.setTimeout(next, NEXT_STEP_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [step]);
  return (
    <div id="app" data-mode={mode} data-step={step}>
      <Header />
      <DisclaimerBar onLearnMore={() => setAbout(true)} onAbout={openWelcome} />
      <Stepper />
      <Toast />
      <main>
        <LoadAnnouncer active={step === "review" || example === "loading"} />
        {example === "loading" ? (
          // An example opens on Review: its picture's box, with the loading status, from the first paint.
          <section aria-labelledby="h-review">
            <div className="review-head"><h1 className="title" id="h-review" tabIndex={-1}>Does this match what happened?</h1></div>
            <ReviewSkeleton exampleLoading />
          </section>
        ) : null}
        {typeof example === "object" && "missing" in example ? <p className="review-wait" role="alert">We don't have an example called "{example.missing}".</p> : null}
        {typeof example === "object" && "failed" in example ? (
          <div className="review-wait example-failed" role="alert">
            <p>We couldn't open the example. Check your connection and try again.</p>
            <button type="button" className="btn btn-secondary" onClick={retry}>Retry</button>
          </div>
        ) : null}
        {example === "loading" ? null : (
          <StepBoundary step={step}>
            <Suspense fallback={<p className="review-wait" role="status">Loading…</p>}><Screen /></Suspense>
          </StepBoundary>
        )}
      </main>
      <AboutDialog open={about} onClose={() => setAbout(false)} onAboutTool={() => { setAbout(false); openWelcome(); }} />
      {welcome ? <WelcomeDialog onTryExample={tryExample} onDismiss={closeWelcome} newTabHref={keepWork ? `${window.location.pathname}${exampleSearch()}#review` : undefined} onStartOwn={reopened && fromExample ? startOwn : undefined} /> : null}
    </div>
  );
}

function Providers({ children }: { children: React.ReactNode }) {
  const { doc } = useDoc();
  return (
    <UiProvider initialQuery={doc.claimAddress}>
      <RoadsProvider>
        <FlowProvider><TipsProvider>{children}</TipsProvider></FlowProvider>
      </RoadsProvider>
    </UiProvider>
  );
}

export function App({ services }: { services: Services }) {
  return (
    <ServicesProvider services={services}>
      <DocProvider>
        <Providers><Body /></Providers>
      </DocProvider>
    </ServicesProvider>
  );
}
