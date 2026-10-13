import { accountItems, type Scene } from "@csd/core";
import { Icon } from "../icons/Icon";
export function AccountNotes({ scene, compact = false }: { scene: Scene; compact?: boolean }) {
  const items = accountItems(scene);
  if (!items.length) return null;
  const answers = <div className="account-chips" tabIndex={compact ? 0 : undefined} aria-label={compact ? "Claimant answers; scroll for more" : undefined}>
      {items.map((item) => <span key={item.key} title={item.text} aria-label={item.text} className="account-note" tabIndex={compact ? 0 : undefined}>
        {(item.icons ?? [item.icon]).map((icon, i) => <Icon key={`${icon}-${i}`} name={icon} className="icon-sm" />)}
        <span>{compact ? item.short : item.text}</span>
      </span>)}
    </div>;
  return compact ? <details className="account-icons" aria-label="What the claimant said">
    <summary>{items.slice(0, 2).map((item) => <Icon key={item.key} name={item.icon} className="icon-sm" />)}<span>Claimant said · {items.length} answers</span></summary>
    <span className="account-scroll-hint">Scroll for all answers</span>
    {answers}
  </details> : <div className="account-notes" aria-label="What the claimant said">{answers}</div>;
}
