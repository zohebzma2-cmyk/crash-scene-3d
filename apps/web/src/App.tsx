// The app: providers (services, the shared scene, UI state, roads, the step flow) and the shell.
import { Component, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { hasWebGL, loadViewer } from "./viewer/load-viewer";
import { AboutDialog, DisclaimerBar, Header, Stepper, Toast } from "./components/Shell";
import { ReviewSkeleton, ReviewStep } from "./review/ReviewStep";
import { LoadAnnouncer, announceLoad } from "./review/LoadAnnouncer";
import { LocationStep, SaveStep, VehiclesStep, preloadStep } from "./steps";
import { ServicesProvider, useServices } from "./services/context";
import type { Services } from "./services/types";
import { docFromScene } from "./state/doc";
import { DocProvider, useDoc } from "./state/DocProvider";
import { FlowProvider, STEPS, docKey, useFlow } from "./state/Flow";
import { RoadsProvider } from "./state/Roads";
import { UiProvider, useUi } from "./state/Ui";
import { TipsProvider } from "./tips/TipsProvider";

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

/** ?example=<name> opens that example straight on the review step (examples are known-good, so no gate). */
function useExample(): { state: ExampleState; retry: () => void } {
  const services = useServices();
  const { dispatch } = useDoc();
  const flow = useFlow();
  const { setQuery } = useUi();
  const name = new URLSearchParams(window.location.search).get("example");
  const [state, setState] = useState<ExampleState>(name ? "loading" : "ready");
  const [attempt, setAttempt] = useState(0);
  const { goTrusted } = flow;
  useEffect(() => {
    if (!name) return;
    let off = false;
    services.examples.load(name).then((scene) => {
      if (off) return;
      if (!scene) { setState({ missing: name }); return; }
      const next = docFromScene(scene, scene.location.label);
      dispatch({ type: "replace", doc: next });
      setQuery(scene.location.label);
      goTrusted("review", docKey(next));
      setState("ready");
    }, () => { if (!off) setState({ failed: name }); });
    return () => { off = true; };
  }, [name, services, dispatch, setQuery, goTrusted, attempt]);
  const retry = useCallback(() => { setState("loading"); setAttempt((n) => n + 1); }, []);
  return { state, retry };
}

function Body() {
  const { step } = useFlow();
  const { mode } = useServices();
  const [about, setAbout] = useState(false);
  const { state: example, retry } = useExample();
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
      <DisclaimerBar onLearnMore={() => setAbout(true)} />
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
      <AboutDialog open={about} onClose={() => setAbout(false)} />
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
