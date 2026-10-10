// The 3D view's compass: a 44 px button whose arrow points at north as the camera turns. The Viewer's
// frame loop writes the turn to the button through its ref (`--compass-deg`), never through React state.
// Pressing it (or Enter / Space when focused) puts the camera back to north up.
import { forwardRef } from "react";
import { Icon } from "../icons/Icon";

export const COMPASS_LABEL = "Compass: reset to north up";
export const COMPASS_DRIVER_HINT = "The driver view always looks the way the vehicle faces";

export interface CompassProps {
  /** The driver views follow their vehicle, so there is no north-up turn to make. */
  readonly driver: boolean;
  readonly onReset: () => void;
}

export const Compass = forwardRef<HTMLButtonElement, CompassProps>(function Compass({ driver, onReset }, ref) {
  return (
    <button ref={ref} type="button" className="viewer3d-compass" aria-label={COMPASS_LABEL} aria-disabled={driver || undefined} title={driver ? COMPASS_DRIVER_HINT : "Reset to north up"} data-rotation="0" onClick={() => { if (!driver) onReset(); }}>
      <span className="viewer3d-compass-dial" aria-hidden="true">
        <span className="viewer3d-compass-n">N</span>
        <Icon name="north" />
      </span>
    </button>
  );
});
