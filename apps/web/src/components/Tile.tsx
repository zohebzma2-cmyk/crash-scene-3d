import type { ReactNode } from "react";
import { Radio } from "../a11y/roving";
import { Icon } from "../icons/Icon";

/** Icon + label choice (place, road, vehicle type, action). Radio semantics, roving tabindex. */
export function Tile<T extends string>({ value, icon, label, badge, ...rest }: { value: T; icon: string; label: string; badge?: ReactNode; "data-testid"?: string }) {
  return (
    <Radio value={value} className="tile" {...rest}>
      <Icon name={icon} />
      <span>{label}</span>
      {badge}
    </Radio>
  );
}
