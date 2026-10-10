// The app: providers (services, the shared scene, UI state, roads, the step flow) and the shell.
import { useEffect, useState } from "react";
import { AboutDialog, DisclaimerBar, Header, Stepper, Toast } from "./components/Shell";
import { LocationStep } from "./components/LocationStep";
import { VehiclesStep } from "./components/VehiclesStep";
import { ReviewStep } from "./review/ReviewStep";
import { SaveStep } from "./save/SaveStep";
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

/** ?example=<name> opens that example straight on the review step (examples are known-good, so no gate). */
function useExample(): "loading" | "ready" | { missing: string } {
  const services = useServices();
  const { dispatch } = useDoc();
  const flow = useFlow();
  const { setQuery } = useUi();
  const name = new URLSearchParams(window.location.search).get("example");
  const [state, setState] = useState<"loading" | "ready" | { missing: string }>(name ? "loading" : "ready");
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
    }, () => { if (!off) setState({ missing: name }); });
    return () => { off = true; };
  }, [name, services, dispatch, setQuery, goTrusted]);
  return state;
}

function Body() {
  const { step } = useFlow();
  const { mode } = useServices();
  const [about, setAbout] = useState(false);
  const example = useExample();
  useEffect(() => {
    document.title = `${STEPS.find((s) => s.key === step)?.name ?? ""} · Crash scene illustration · InsurifyAI`;
  }, [step]);
  return (
    <div id="app" data-mode={mode} data-step={step}>
      <Header />
      <DisclaimerBar onLearnMore={() => setAbout(true)} />
      <Stepper />
      <Toast />
      <main>
        {example === "loading" ? <p className="review-wait" role="status">Opening the example…</p> : null}
        {typeof example === "object" ? <p className="review-wait" role="alert">We don't have an example called "{example.missing}".</p> : null}
        {example === "loading" ? null : <Screen />}
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
