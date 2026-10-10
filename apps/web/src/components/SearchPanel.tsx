// Address search as a WAI-ARIA combobox.
//
// Typing (3 characters or more, after a 300 ms pause) asks for suggestions (Photon, through our proxy),
// biased toward the claim's location, else the pin, else the middle of the map; every suggestion shows
// its name and "Town, State". For an intersection ("X and Y", "X & Y", "X at Y", or after a street is
// picked) a second list, "Crossing streets", offers only the streets that really cross it, and picking
// one puts the pin exactly on the crossing. Enter with nothing highlighted runs the on-submit
// (Nominatim) search, as before. The claim address is prefilled but nothing is sent until the claimant
// types or taps Search.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { CrossStreet, LatLon, PlaceResult } from "@csd/core";
import { mapConfig } from "../config/map";
import { Icon } from "../icons/Icon";
import { useServices } from "../services/context";
import { ServiceError } from "../services/types";
import { useClaimTown } from "../state/claimTown";
import { useDoc } from "../state/DocProvider";
import { useUi } from "../state/Ui";

export const NO_RESULTS_TEXT = "We couldn't find that. Try a nearby street or landmark, or tap the map where it happened.";
export const SEARCH_FAILED_TEXT = "Search isn't working right now. Tap the map where it happened, or try again in a minute.";
export const EMPTY_QUERY_TEXT = "Type an address, intersection or landmark first.";
export const NO_SUGGESTIONS_TEXT = "No matches yet. Press Enter to search, or tap the map where it happened.";
export const ATTRIBUTION_TEXT = "Search by Photon · Nominatim";
/** What the proxy accepts: type-ahead text up to 120 characters, a street name up to 80. Longer input is explained, not sent. */
export const MAX_QUERY_CHARS = 120;
export const MAX_STREET_CHARS = 80;
export const TOO_LONG_TEXT = `That is too long to search for (${MAX_QUERY_CHARS} characters at most). Try a shorter address, or just a street name.`;
export const STREET_TOO_LONG_TEXT = `That street name is too long to look up (${MAX_STREET_CHARS} characters at most). Try a shorter name.`;
export const NO_AREA_TEXT = "Search for the place, or drop the pin on the map first, so we know which area to look in.";
export const noCrossingText = (street: string) => `No streets cross ${street} near here. Try the other street first, or drop the pin on the map.`;

const SEPARATORS = new Set(["and", "&", "at"]);
/** Never look further than this into the text: a pasted wall of text costs nothing. */
const MAX_SCAN = 400;

/**
 * "Main St and Park St", "Main St & Park St", "Main St at Park St": the street before the separator, and what
 * is typed after it (maybe nothing yet, once the separator is followed by a space). One pass over the words,
 * so a long run of spaces can't make it slow.
 */
export function splitIntersection(text: string): { first: string; rest: string } | null {
  const tokens = text.slice(0, MAX_SCAN).trimStart().split(/\s+/);
  for (let i = 1; i < tokens.length - 1; i++) {
    if (SEPARATORS.has((tokens[i] ?? "").toLowerCase())) return { first: tokens.slice(0, i).join(" "), rest: tokens.slice(i + 1).join(" ").trim() };
  }
  return null;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Does `name` start with each typed word (the last typed word may be partial)? An empty filter matches all. */
export function matchesTyped(name: string, typed: string): boolean {
  const want = words(typed);
  if (want.length === 0) return true;
  const have = words(name);
  return want.every((w, i) => have.some((h) => (i === want.length - 1 ? h.startsWith(w) : h === w)));
}

/**
 * The text after "and" may carry the town too ("Park Street, Nashua NH"). Only the street part filters the crossings:
 * what comes before a comma, or else the leading whole words that are all in the street's name.
 */
export function matchesCrossTyped(name: string, rest: string): boolean {
  const street = rest.split(",")[0] ?? "";
  if (matchesTyped(name, street)) return true;
  const want = words(street);
  const have = new Set(words(name));
  let k = 0;
  while (k < want.length && have.has(want[k]!)) k++;
  return k > 0;
}

type Loaded<T> = { key: string; status: "ok"; value: T } | { key: string; status: "error"; message: string };

function StatusLine({ kind, children }: { kind: "loading" | "empty" | "info"; children: ReactNode }) {
  return (
    <p className={`status-line status-${kind}`}>
      {kind === "loading" ? <span className="spinner" aria-hidden="true" /> : <Icon name="info" className="icon-sm" />}
      <span>{children}</span>
    </p>
  );
}

interface Option { id: string; main: string; sub: string; onPick: () => void }

export interface SearchPanelProps {
  /** After a pick: the map recenters (a point, with or without a pin) */
  readonly onPicked: (at: LatLon | null) => void;
  /** The middle of the map view: where to look when there is no claim location and no pin. */
  readonly bias: LatLon | null;
  /** The pin, when there is one. */
  readonly pin?: LatLon | null;
  /** A location known for the claim. It comes before everything else; usually null, and the claim's town is looked up when it is needed. */
  readonly claimBias?: LatLon | null;
  /** The map view (west, south, east, north), so results inside it come first. */
  readonly bbox?: readonly [number, number, number, number] | null;
}

export function SearchPanel({ onPicked, bias: viewBias, pin = null, claimBias = null, bbox = null }: SearchPanelProps) {
  const { doc, dispatch } = useDoc();
  const { geo } = useServices();
  const { query, setQuery, setHighlight } = useUi();
  const ids = useId();
  const listId = `${ids}-list`;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The on-submit (Nominatim) search and its results list.
  const [fallback, setFallback] = useState<{ status: "idle" | "loading" | "waiting" | "results" | "empty" | "error"; text?: string }>({ status: "idle" });
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [pickedResult, setPickedResult] = useState(-1);
  const busy = useRef(false);

  // The combobox.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** Text set by a pick: it is not a new search. */
  const [settled, setSettled] = useState<string | null>(null);
  /** Nothing is asked of the network until the claimant types: the claim address alone sends nothing. */
  const [typed, setTyped] = useState(false);
  /** A street picked from the suggestions: its crossings are asked for. */
  const [street, setStreet] = useState<{ name: string; ways: readonly number[]; at: LatLon } | null>(null);

  const split = splitIntersection(query);
  const q = query.trim();
  // Where to look: a known claim location, the pin, the middle of the map, and last the claim's town, which is only
  // looked up once "A and B" is typed with none of the others to go on.
  const known = claimBias ?? pin ?? viewBias;
  const wantTown = typed && !known && !street && split != null && split.first.length >= mapConfig.suggestMinChars;
  const claim = useClaimTown(wantTown);
  const bias = known ?? claim.point;
  const biasKey = bias ? `${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}` : "-";
  const isSettled = settled !== null && settled === query;
  // What the second list is about: the street before the separator, else a picked street while the text still names it.
  const intent: { name: string; rest: string; ways: readonly number[]; at: LatLon | null } | null = (() => {
    if (!typed && !street) return null;
    if (split) {
      const same = street && street.name.toLowerCase() === split.first.toLowerCase();
      return split.first.length >= mapConfig.suggestMinChars ? { name: same ? street.name : split.first, rest: split.rest, ways: same ? street.ways : [], at: same ? street.at : bias } : null;
    }
    return street && matchesTyped(street.name, q) && q.length >= mapConfig.suggestMinChars ? { name: street.name, rest: "", ways: street.ways, at: street.at } : null;
  })();
  // A street name the proxy would refuse, or no area to look in: say so, and don't send a request that would fail.
  const noArea = intent != null && !intent.at && intent.ways.length === 0;
  // The claim's town is still being found: wait for it, then ask.
  const areaPending = noArea && claim.status === "loading";
  const blocked = intent && intent.name.length > MAX_STREET_CHARS ? STREET_TOO_LONG_TEXT : noArea && !areaPending ? NO_AREA_TEXT : null;
  const crossFor = blocked || areaPending ? null : intent;
  const mode: "crossings" | "suggest" = intent ? "crossings" : "suggest";

  // ---- suggestions (debounced, cached by the service, stale requests aborted) ----
  const bboxKey = bbox ? bbox.map((n) => n.toFixed(2)).join(",") : "";
  const suggestKey = `${q.toLowerCase()}|${biasKey}|${bboxKey}`;
  const [suggested, setSuggested] = useState<Loaded<PlaceResult[]> | null>(null);
  const tooLong = q.length > MAX_QUERY_CHARS;
  const wantSuggest = typed && mode === "suggest" && !isSettled && q.length >= mapConfig.suggestMinChars && !tooLong;
  useEffect(() => {
    if (!wantSuggest) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      geo.suggest(q, { bias, bbox, signal: ctrl.signal }).then(
        (value) => setSuggested({ key: suggestKey, status: "ok", value }),
        (e: unknown) => { if (!(e instanceof DOMException && e.name === "AbortError")) setSuggested({ key: suggestKey, status: "error", message: e instanceof ServiceError ? e.message : SEARCH_FAILED_TEXT }); },
      );
    }, mapConfig.suggestDebounceMs);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
    // `suggestKey` stands for the text, the rounded bias and the map view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantSuggest, suggestKey, geo]);
  const suggestState = !wantSuggest ? null : suggested && suggested.key === suggestKey ? suggested : { key: suggestKey, status: "loading" as const };

  // ---- crossing streets ----
  const crossKey = crossFor ? `${crossFor.name.toLowerCase()}|${crossFor.at ? `${crossFor.at.lat.toFixed(2)},${crossFor.at.lon.toFixed(2)}` : "-"}|${crossFor.ways.join(",")}` : "";
  const [crossed, setCrossed] = useState<Loaded<readonly CrossStreet[]> | null>(null);
  useEffect(() => {
    if (!crossFor) return;
    const ctrl = new AbortController();
    const name = crossFor.name;
    const at = crossFor.at;
    const ways = crossFor.ways;
    const timer = window.setTimeout(() => {
      geo.crossStreets(name, at, { signal: ctrl.signal, ways }).then(
        (r) => setCrossed({ key: crossKey, status: "ok", value: r.crossings }),
        (e: unknown) => { if (!(e instanceof DOMException && e.name === "AbortError")) setCrossed({ key: crossKey, status: "error", message: e instanceof ServiceError ? e.message : SEARCH_FAILED_TEXT }); },
      );
    }, mapConfig.suggestDebounceMs);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
    // `crossKey` stands for the street, where, and which ways.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossKey, geo]);
  const crossState = !crossFor ? null : crossed && crossed.key === crossKey ? crossed : { key: crossKey, status: "loading" as const };

  // ---- the options in the open list ----
  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    if (mode === "crossings" && crossFor && crossState?.status === "ok") {
      for (const c of crossState.value) {
        if (!matchesCrossTyped(c.name, crossFor.rest)) continue;
        const pts = c.points && c.points.length > 1 ? c.points : [{ lat: c.lat, lon: c.lon }];
        pts.forEach((p, i) => {
          const sub = [c.place, pts.length > 1 ? `crossing ${i + 1} of ${pts.length}` : null].filter(Boolean).join(" · ");
          out.push({
            id: `${ids}-c${out.length}`, main: c.name, sub,
            onPick: () => pickCrossing(crossFor.name, c, p),
          });
        });
      }
    } else if (mode === "suggest" && suggestState?.status === "ok") {
      suggestState.value.forEach((s, i) => out.push({ id: `${ids}-s${i}`, main: s.main, sub: s.sub, onPick: () => pickSuggestion(s) }));
    }
    return out;
    // The pick handlers only read stable setters and the current street.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, crossFor?.name, crossFor?.rest, crossState, suggestState, ids]);

  function settle(text: string) {
    setSettled(text);
    setQuery(text);
    setOpen(false);
    setActive(-1);
  }

  function pickSuggestion(s: PlaceResult) {
    setFallback({ status: "idle" });
    if (s.category === "street") {
      // A street has no single point: go there, and ask which street crosses it.
      setStreet({ name: s.main, ways: s.osmWayIds ?? [], at: { lat: s.lat, lon: s.lon } });
      setQuery(s.main);
      setSettled(null);
      setHighlight([s.main]);
      setOpen(true);
      setActive(-1);
      onPicked({ lat: s.lat, lon: s.lon });
      document.getElementById(`${ids}-q`)?.focus();
      return;
    }
    setStreet(null);
    setHighlight([]);
    dispatch({ type: "pick", result: s });
    settle(s.label);
    onPicked({ lat: s.lat, lon: s.lon });
  }

  function pickCrossing(streetName: string, c: CrossStreet, p: { lat: number; lon: number }) {
    const result: PlaceResult = {
      label: `${streetName} & ${c.name}${c.place ? `, ${c.place}` : ""}`,
      main: `${streetName} & ${c.name}`,
      sub: c.place ?? "",
      lat: p.lat,
      lon: p.lon,
      kind: "crossing",
      streets: [streetName, c.name],
    };
    dispatch({ type: "pick", result });
    setHighlight([streetName, c.name]);
    setStreet(null);
    settle(result.label);
    onPicked({ lat: p.lat, lon: p.lon });
  }

  // ---- the on-submit search (Nominatim), as before ----
  async function run(e: FormEvent) {
    e.preventDefault();
    if (open && active >= 0 && options[active]) { options[active]?.onPick(); return; }
    if (!q) { setFallback({ status: "empty", text: EMPTY_QUERY_TEXT }); return; }
    if (q.length > MAX_QUERY_CHARS) { setOpen(false); setFallback({ status: "empty", text: TOO_LONG_TEXT }); return; }
    const parts = splitIntersection(q);
    if (parts && (parts.first.length > MAX_STREET_CHARS || parts.rest.length > MAX_STREET_CHARS)) { setOpen(false); setFallback({ status: "empty", text: STREET_TOO_LONG_TEXT }); return; }
    if (busy.current) return;
    busy.current = true;
    setOpen(false);
    setFallback({ status: "loading" });
    setPickedResult(-1);
    try {
      const found = await geo.search(q, { bias, town: claim.town, onWait: () => setFallback({ status: "waiting" }) });
      setResults(found);
      setFallback(found.length ? { status: "results" } : { status: "empty", text: NO_RESULTS_TEXT });
    } catch (err) {
      setResults([]);
      // A ProxyError message (such as the busy message) is shown as text.
      setFallback({ status: "error", text: err instanceof ServiceError ? err.message : SEARCH_FAILED_TEXT });
    } finally {
      busy.current = false;
    }
  }

  function pickFallback(i: number) {
    const r = results[i];
    if (!r) return;
    setPickedResult(i);
    setStreet(null);
    setHighlight(r.streets ? [...r.streets] : []);
    dispatch({ type: "pick", result: r });
    onPicked({ lat: r.lat, lon: r.lon });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter") {
      // Enter runs the search (a newline is never wanted here).
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(options.length ? 0 : -1); return; }
      setActive((a) => (options.length ? (a + 1) % options.length : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(options.length ? options.length - 1 : -1); return; }
      setActive((a) => (options.length ? (a <= 0 ? options.length - 1 : a - 1) : -1));
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); setOpen(false); setActive(-1); }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const listVisible = open && (mode === "crossings" ? crossState != null || blocked != null || areaPending : wantSuggest || (typed && tooLong && mode === "suggest"));
  const state = mode === "crossings" ? crossState : suggestState;
  const loading = !blocked && (areaPending || state?.status === "loading");
  const listLabel = mode === "crossings" ? "Crossing streets" : "Suggestions";
  const activeId = listVisible && active >= 0 ? options[active]?.id : undefined;
  const fallbackBusy = fallback.status === "loading" || fallback.status === "waiting";

  let message: string | null = null;
  if (listVisible && blocked) message = blocked;
  else if (listVisible && tooLong && mode === "suggest") message = TOO_LONG_TEXT;
  else if (listVisible && state?.status === "error") message = state.message;
  else if (listVisible && state?.status === "ok" && options.length === 0) message = mode === "crossings" && crossFor ? noCrossingText(crossFor.name) : NO_SUGGESTIONS_TEXT;

  const showClaimHint = fallback.status === "idle" && !doc.located && query === doc.claimAddress;
  // Grow to fit the text (border-box: add the borders back).
  const resize = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`; };

  return (
    <form className="search" role="search" noValidate onSubmit={(e) => void run(e)}>
      <label className="field-label" htmlFor={`${ids}-q`}>Address, intersection or landmark</label>
      <div className="search-row">
        <div className="input-wrap combobox">
          <Icon name="search" className="icon-sm input-icon" />
          {/* A textarea that grows: a long address wraps instead of being cut off on a phone. Enter still searches. */}
          <textarea
            ref={(el) => { inputRef.current = el; if (el) resize(el); }}
            className="input input-grow"
            id={`${ids}-q`}
            name="q"
            rows={1}
            maxLength={MAX_QUERY_CHARS}
            role="combobox"
            aria-expanded={listVisible}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-busy={loading || undefined}
            autoComplete="off"
            enterKeyHint="search"
            spellCheck={false}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setTyped(true); setSettled(null); setOpen(true); setActive(-1); setFallback((f) => (f.status === "idle" ? f : { status: "idle" })); resize(e.target); }}
            onFocus={() => { if (typed && !isSettled && q.length >= mapConfig.suggestMinChars) setOpen(true); }}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
          />
          {listVisible ? (
            <div className="combo-pop">
              <p className="combo-title" id={`${listId}-label`}>{listLabel}</p>
              <ul className="combo-list" id={listId} role="listbox" aria-labelledby={`${listId}-label`}>
                {options.map((o, i) => (
                  <li key={o.id} id={o.id} role="option" aria-selected={i === active} className={`combo-option${i === active ? " is-active" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={o.onPick} onMouseMove={() => { if (active !== i) setActive(i); }}>
                    <Icon name="pin" className="icon-sm" />
                    <span>
                      <span className="r-main">{o.main}</span>
                      {o.sub ? <span className="r-sub">{o.sub}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              {loading ? <p className="combo-note" role="status"><span className="spinner" aria-hidden="true" /> Searching…</p> : null}
              {message ? <p className="combo-note" role="status">{message}</p> : null}
              <p className="combo-attrib">{ATTRIBUTION_TEXT} · <a href={mapConfig.attributionUrl} target="_blank" rel="noopener noreferrer">{mapConfig.attribution}</a></p>
            </div>
          ) : null}
        </div>
        <button className="btn btn-secondary" type="submit" aria-busy={fallbackBusy || undefined} aria-disabled={fallbackBusy || undefined}>{fallbackBusy ? "Searching…" : "Search"}</button>
      </div>
      <div className="search-status" aria-live="polite">
        {showClaimHint ? <StatusLine kind="info">This is the address on your claim. Tap Search to find it on the map.</StatusLine> : null}
        {fallback.status === "loading" ? <StatusLine kind="loading">Searching OpenStreetMap…</StatusLine> : null}
        {fallback.status === "waiting" ? <StatusLine kind="loading">Waiting a moment before the next search…</StatusLine> : null}
        {fallback.status === "empty" || fallback.status === "error" ? <StatusLine kind="empty">{fallback.text}</StatusLine> : null}
        {fallback.status === "results" ? <span className="visually-hidden">{results.length} {results.length === 1 ? "result" : "results"}. Pick the right one.</span> : null}
        {listVisible && options.length > 0 ? <span className="visually-hidden">{options.length} {options.length === 1 ? "suggestion" : "suggestions"} available. Use the arrow keys.</span> : null}
      </div>
      {results.length > 0 && !fallbackBusy ? (
        <ul className="results" aria-label="Search results">
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lon},${r.label}`}>
              <button type="button" aria-current={i === pickedResult} onClick={() => pickFallback(i)}>
                <Icon name="pin" className="icon-sm" />
                <span>
                  <span className="r-main">{r.main}</span>
                  <span className="r-sub">{[r.sub, r.streets ? `where ${r.streets[0]} meets ${r.streets[1]}` : r.kind, r.approximate ? "Approximate crossing" : null].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {fallback.status === "results" || fallback.status === "empty" || fallback.status === "error" ? (
        <p className="attrib">{ATTRIBUTION_TEXT} · <a href={mapConfig.attributionUrl} target="_blank" rel="noopener noreferrer">{mapConfig.attribution}</a></p>
      ) : null}
    </form>
  );
}
