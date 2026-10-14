// All first-time-user tip copy lives here, in one place. To add a tip: add an entry to TIPS.
// A tip with `onDemand: true` is not shown by its step's slot; the screen that needs it renders
// <Tip id="..." /> itself (for example the "We can't draw this yet" screen on Review).
// Voice: DESIGN.md section 3. Plain words, short sentences, text only (no HTML), no emoji.
import type { StepKey } from "../state/Flow";

export interface TipDef {
  readonly id: string;
  readonly step: StepKey;
  /** Names the tip for screen readers and for its "Hide tip" button. */
  readonly title: string;
  /** One or two short sentences. */
  readonly text: string;
  readonly onDemand?: boolean;
}

export const TIPS: readonly TipDef[] = [
  {
    id: "location",
    step: "location",
    title: "Finding the place",
    text: 'Search an address, an intersection like "Main St and Park St", or a landmark. Pick the street from the list, then drag the pin to where the vehicles hit.',
  },
  {
    id: "vehicles",
    step: "vehicles",
    title: "Describing each vehicle",
    text: "Pick which way each vehicle was going on its real street, tap the spot where it was hit on the car diagram, and enter its speed at the moment of the crash.",
  },
  {
    id: "review",
    step: "review",
    title: "Checking the picture",
    text: "Press play or drag the timeline to watch it. Switch views, open Aftermath to see where everything ended up, and see the distances in the Measure tab.",
  },
  {
    id: "save",
    step: "export",
    title: "Saving your files",
    text: "The PDF summary is usually one page, the picture is a top-down diagram, and the scene file reopens this recreation. Save to my device gives you all of it as one ZIP.",
  },
  // The "We can't draw this yet" screen's tip (copy from DESIGN.md section 18), rendered by review/RefusalFixes.tsx.
  {
    id: "review-refusal",
    step: "review",
    title: "When the picture can't be drawn",
    text: "If the details can't happen, pick one of the suggested fixes or edit the details yourself.",
    onDemand: true,
  },
];

export const tipById = (id: string): TipDef | undefined => TIPS.find((t) => t.id === id);
export const tipsForStep = (step: StepKey): readonly TipDef[] => TIPS.filter((t) => t.step === step && !t.onDemand);
