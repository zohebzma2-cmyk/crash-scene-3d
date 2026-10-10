// A fixed north arrow for the Leaflet maps. These maps are north up (they never rotate), so the arrow
// is a plain picture in a corner and never moves. It uses the `north` icon from our icon set, the same
// drawing as the PDF and PNG diagrams. Not interactive; the 3D view has the clickable compass.
import type { ReactElement } from "react";
import { Icon } from "../icons/Icon";

export function NorthArrow(): ReactElement {
  return (
    <div className="map-north" role="img" aria-label="North is up">
      <span className="map-north-n" aria-hidden="true">N</span>
      <Icon name="north" />
    </div>
  );
}
