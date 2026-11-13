import { memo, useEffect, useMemo, useRef, useState } from "react";
import { LONG_DELAY_MS, TROMBONE_MS, WORLD_POINTS, WORLD_POINTS_SHORT, aggregateReadings, analysePair, pickAnchors } from "./lib/soi";
import { loadAnchors, loadIxpIndex, loadRootAnswers, loadRootSites, pingAnchorsAtlas, pingAnchorsGlobalping } from "./lib/placeData";

// Trombone routing and the place of the probes, under the tables: the reading of the trombone for a traceroute or an mtr, the
// place of the probes under any command. The method is in src/lib/soi.js.

const PLACE_CHECK_STORE = "PING6_PLACE_CHECK";

const cell = { padding: "6px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" };
const head = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px", whiteSpace: "nowrap" };
const TONES = {
  good: { background: "#f0fdf4", border: "1px solid #22c55e" },
  warn: { background: "#fffbeb", border: "1px solid #f59e0b" },
  bad: { background: "#fef2f2", border: "1px solid #ef4444" },
  plain: { background: "#f9fafb", border: "1px solid #e5e7eb" },
};
const ORDER = { misplaced: 0, trombone: 1, long: 2, none: 3, far: 4, unknown: 5 };

const fmtMs = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : "-");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function readStored() {
  try {
    return window.localStorage.getItem(PLACE_CHECK_STORE) === "1";
  } catch {
    return false;
  }
}

function probeLabel(p) {
  const city = String(p?.city ?? "").trim();
  const country = String(p?.country ?? p?.country_code ?? "").trim().toUpperCase();
  const id = p?.id !== undefined && p?.id !== null ? String(p.id) : "";
  if (id) return `RIPE Atlas ${id}${country ? ` · ${country}` : ""}`;
  return [city, country].filter(Boolean).join(", ") || "A probe";
}

// A reference point of a probe, as a name and what tells where it is.
function pointLabel(p) {
  const where = [p.city, p.country].filter(Boolean).join(", ");
  if (p.kind === "anchor") return { name: `anchor ${String(p.anchor).replace(/\.anchors\.atlas\.ripe\.net$/, "")}`, note: where };
  if (p.kind === "root") return { name: `${String(p.letter).toUpperCase()} root`, note: `${p.hostname} (${p.code})` };
  return { name: p.ixp, note: [where, `${p.family} hop ${p.hop}, ${p.ip}`].filter(Boolean).join(" · ") };
}

const fmtKm = (v) => `${Number(v).toLocaleString("en-US")} km`;

// The reference points of a probe with their figures, the nearest first.
function PlaceDetails({ row }) {
  const points = [...row.place.points].sort((a, b) => a.km - b.km);
  const lat = Number(row.probe?.latitude);
  const lon = Number(row.probe?.longitude);
  const num = { ...cell, textAlign: "right", whiteSpace: "nowrap" };
  const numHead = { ...head, textAlign: "right" };
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        Declared place: {[row.probe?.city, String(row.probe?.country ?? row.probe?.country_code ?? "").toUpperCase()].filter(Boolean).join(", ") || "-"}
        {Number.isFinite(lat) && Number.isFinite(lon) ? ` (${lat.toFixed(2)}, ${lon.toFixed(2)})` : ""}. A round trip shorter than the least one proves that the probe is elsewhere.
      </div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={head}>Reference point</th>
            <th style={numHead} title="From the declared place of the probe to the nearest site of the reference point">Distance</th>
            <th style={numHead} title="The shortest round trip from the probe to the reference point">Round trip</th>
            <th style={numHead} title="Light in fibre there and back from the declared place, less the margin">Least one</th>
            <th style={numHead} title="The round trip in fibre, plus the margin: the probe cannot be farther than this from the reference point">Probe within</th>
            <th style={head} />
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => {
            const l = pointLabel(p);
            return (
              <tr key={i}>
                <td style={cell}>
                  {l.name}
                  {l.note ? <span style={{ opacity: 0.7 }}> · {l.note}</span> : null}
                </td>
                <td style={num}>{fmtKm(p.km)}</td>
                <td style={num}>{fmtMs(p.rtt)}</td>
                <td style={num}>{p.atLeast > 0 ? fmtMs(p.atLeast) : <span title={`Within the margin of ${p.margin} km: any round trip is possible`}>any</span>}</td>
                <td style={num}>{fmtKm(p.within)}</td>
                <td style={cell}>{p.ok ? "possible" : <span style={{ fontWeight: 700, color: "#92400e" }}>too fast</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The sentence for a probe that is not where it is said to be, with the figures that prove it.
function misplacedText(row, isAtlas) {
  const m = row.place.misplaced;
  const who = isAtlas ? `${probeLabel(row.probe)} is not where its host places it` : `This probe is not where Globalping places it (${probeLabel(row.probe)})`;
  const floor = `while light in fibre needs at least ${fmtMs(m.atLeast)} to go there and back`;
  if (m.kind === "anchor") {
    return `${who}: it reaches the anchor of RIPE Atlas ${m.anchor}${m.city ? ` in ${m.city}` : ""}, ${m.km} km from that place, in ${fmtMs(m.rtt)}, ${floor}. The probe is within about ${m.within} km of that anchor.`;
  }
  if (m.kind === "root") {
    return `${who}: the ${m.letter.toUpperCase()} root server answers it from its instance ${m.hostname} (${m.code}), ${m.km} km from that place, in ${fmtMs(m.rtt)}, ${floor}. The probe is within about ${m.within} km of that instance.`;
  }
  return `${who}: ${m.family} hop ${m.hop}, ${m.ip}, is on the LAN of ${m.ixp}${m.city ? ` in ${m.city}` : ""}, whose nearest site is ${m.km} km from that place, and it answers in ${fmtMs(m.rtt)}, ${floor}. The probe is within about ${m.within} km of a site of that exchange.`;
}

function headline(c) {
  if (!c.read) {
    return {
      tone: "plain",
      title: "No reading of the trombone",
      text: c.far > 0 ? `No probe gets to the target within ${LONG_DELAY_MS} ms on either family, so the target may simply be far from all of them.` : "",
    };
  }
  const of = `of the ${plural(c.read, "probe", "probes")} that can be read`;
  if (c.tromboneV4 && c.tromboneV6) {
    return { tone: "bad", title: "Trombone over IPv6 and over IPv4", text: `Over IPv6 on ${c.tromboneV6} and over IPv4 on ${c.tromboneV4} ${of}.` };
  }
  if (c.tromboneV6 || c.tromboneV4) {
    const fam = c.tromboneV6 ? "IPv6" : "IPv4";
    const n = c.tromboneV6 || c.tromboneV4;
    return { tone: n * 2 >= c.read ? "bad" : "warn", title: `Trombone over ${fam} only`, text: `On ${n} ${of}.` };
  }
  if (c.longV4 || c.longV6) {
    const bits = [c.longV6 ? `IPv6 on ${c.longV6}` : "", c.longV4 ? `IPv4 on ${c.longV4}` : ""].filter(Boolean).join(" and ");
    return { tone: "warn", title: "No trombone seen, but one family is longer than it should be", text: `${bits} ${of}.` };
  }
  return { tone: "good", title: "No trombone seen, over IPv4 or IPv6", text: `On ${plural(c.read, "probe", "probes")}.` };
}

function readingCell(row) {
  const r = row.reading;
  if (!r) return null;
  const fam = r.verdict === "v6" ? "IPv6" : "IPv4";
  const other = r.verdict === "v6" ? "IPv4" : "IPv6";
  if (r.verdict === "misplaced") return <span style={{ opacity: 0.7 }}>not read</span>;
  if (r.verdict === "unknown") return <span style={{ opacity: 0.7 }}>-</span>;
  if (r.verdict === "far") return <span title={`Neither family gets there within ${LONG_DELAY_MS} ms: the target may be far from this probe.`}>far on both</span>;
  if (r.verdict === "none") return <span>no trombone</span>;
  const why = `${other} gets there in ${fmtMs(r.fast)}, so the target is within about ${r.withinKm} km of this probe; ${fam} needs ${fmtMs(r.slow)}.`;
  return (
    <span title={why} style={{ fontWeight: 700, color: r.level === "trombone" ? "#b91c1c" : "#92400e" }}>
      {r.level === "trombone" ? `trombone over ${fam}` : `${fam} longer`}
    </span>
  );
}

function PathChecks({ cmd, v4, v6, excludeKeys, busy = false, atlasKey = "", getTurnstileToken = null }) {
  const paths = cmd === "traceroute" || cmd === "mtr";
  const isAtlas = Boolean(v4?.atlas || v6?.atlas);

  const [enabled, setEnabled] = useState(readStored);
  const [ixp, setIxp] = useState({ state: "idle", index: null }); // idle | ready | failed
  const [roots, setRoots] = useState({ state: "idle", sites: null, answers: null, key: "" });
  // the pings to the anchors belong to one pair of measurements: `pair` tells which
  const [anch, setAnch] = useState({ state: "idle", pings: null, msg: "", pair: "" });
  const anchorsAbort = useRef(null);
  const boxRef = useRef(null);
  const [open, setOpen] = useState(() => new Set()); // the probes whose reference points are shown
  const flip = (key) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const pairKey = `${v4?.id ?? ""}|${v6?.id ?? ""}`;
  const anchorPings = anch.pair === pairKey ? anch.pings : null;
  const anchState = anch.pair === pairKey ? anch.state : "idle";

  useEffect(() => () => anchorsAbort.current?.abort(), []);

  const atlasIds = useMemo(() => {
    if (!isAtlas) return "";
    const ids = new Set();
    for (const m of [v4, v6]) for (const x of m?.results || []) if (x?.probe?.id !== undefined && x?.probe?.id !== null) ids.add(String(x.probe.id));
    return [...ids].sort().join(",");
  }, [isAtlas, v4, v6]);

  function toggle(on) {
    setEnabled(on);
    // a table that PeeringDB or RIPE Atlas did not give is asked again
    if (on && ixp.state === "failed") setIxp({ state: "idle", index: null });
    if (on && roots.state === "failed") setRoots({ state: "idle", sites: null, answers: null, key: "" });
    try {
      window.localStorage.setItem(PLACE_CHECK_STORE, on ? "1" : "0");
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!enabled || !paths || ixp.state !== "idle") return undefined;
    let live = true;
    loadIxpIndex().then((index) => {
      if (live) setIxp(index ? { state: "ready", index } : { state: "failed", index: null });
    });
    return () => {
      live = false;
    };
  }, [enabled, paths, ixp.state]);

  useEffect(() => {
    if (!enabled || !atlasIds || roots.key === atlasIds) return undefined;
    const ctl = new AbortController();
    Promise.all([loadRootSites(), loadRootAnswers(atlasIds.split(","), ctl.signal)])
      .then(([sites, answers]) => {
        if (!ctl.signal.aborted) setRoots({ state: sites && answers.size ? "ready" : "failed", sites, answers, key: atlasIds });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setRoots({ state: "failed", sites: null, answers: null, key: atlasIds });
      });
    return () => ctl.abort();
  }, [enabled, atlasIds, roots.key]);

  const rows = useMemo(() => {
    const list = analysePair(v4?.results, v6?.results, {
      index: enabled ? ixp.index : null,
      rootSites: enabled ? roots.sites : null,
      rootAnswers: enabled ? roots.answers : null,
      anchorPings: enabled ? anchorPings : null,
      excludeKeys: excludeKeys instanceof Set ? excludeKeys : null,
      paths,
    });
    const rank = (r) => (r.reading ? ORDER[r.reading.level || r.reading.verdict] ?? 9 : r.place.misplaced ? 0 : 1);
    return list.map((r, i) => ({ ...r, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  }, [v4, v6, enabled, ixp.index, roots.sites, roots.answers, anchorPings, excludeKeys, paths]);

  if (!rows.length) return null;

  // Ask the probes to ping a few anchors of RIPE Atlas: new measurements, so only when the visitor asks.
  const anchorsCount = isAtlas ? 3 + WORLD_POINTS.length : 3 + WORLD_POINTS_SHORT.length;
  const canPingAnchors = !busy && anchState !== "running" && (isAtlas ? Boolean(getTurnstileToken && atlasIds) : Boolean(v4?.id || v6?.id));
  // Bring this box back into view when the pings end, wherever the page went meanwhile.
  const showBox = () => {
    try {
      boxRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      // ignore
    }
  };
  async function runAnchors() {
    anchorsAbort.current?.abort();
    const ctl = new AbortController();
    anchorsAbort.current = ctl;
    const say = (msg) => {
      if (!ctl.signal.aborted) setAnch({ state: "running", pings: null, msg, pair: pairKey });
    };
    say("choosing the anchors");
    try {
      const list = await loadAnchors();
      if (!list) throw new Error("RIPE Atlas did not give the list of the anchors.");
      const countries = [...new Set(rows.map((r) => String(r.probe?.country ?? r.probe?.country_code ?? "").toUpperCase()).filter(Boolean))];
      const chosen = pickAnchors(list, countries, 3, isAtlas ? WORLD_POINTS : WORLD_POINTS_SHORT);
      if (!chosen.length) throw new Error("No anchor could be chosen.");
      let pings;
      if (isAtlas) {
        say("human verification (if it asks for you, the check is next to the Run button)");
        // the page stays here: the results come in this box
        const turnstileToken = await getTurnstileToken(ctl.signal, { scroll: false });
        say(`pinging ${chosen.length} anchors`);
        pings = await pingAnchorsAtlas({ probeIds: atlasIds.split(","), anchors: chosen, turnstileToken, atlasKey, signal: ctl.signal, onProgress: say });
      } else {
        say(`pinging ${chosen.length} anchors`);
        pings = await pingAnchorsGlobalping({ measurementId: v4?.id || v6?.id, anchors: chosen, signal: ctl.signal, onProgress: say });
      }
      if (!ctl.signal.aborted) {
        setAnch({ state: "done", pings, msg: `${chosen.length} anchors pinged: the result for each probe is in the Place column below (press it for the figures)`, pair: pairKey });
        showBox();
      }
    } catch (e) {
      if (!ctl.signal.aborted) {
        setAnch({ state: "failed", pings: null, msg: String(e?.message || "The anchors could not be pinged."), pair: pairKey });
        showBox();
      }
    }
  }

  const c = aggregateReadings(rows);
  const h = paths ? headline(c) : null;
  const left = [
    c.far ? `${c.far} ${c.far === 1 ? "is" : "are"} far from the target on both families` : "",
    c.unknown ? `${c.unknown} did not reach the target on both families` : "",
    c.misplaced ? `${c.misplaced} ${c.misplaced === 1 ? "is" : "are"} not where ${c.misplaced === 1 ? "it is" : "they are"} said to be` : "",
  ].filter(Boolean);

  const refs = [
    paths ? "the exchange points that a path crosses, whose sites are known (PeeringDB)" : "",
    isAtlas ? "the instances of the DNS root servers that answer the probes in the built-in measurements of RIPE Atlas" : "",
    anchorPings || !enabled ? `the anchors of RIPE Atlas${anchorPings ? " that the probes pinged" : ", when you ask the probes to ping them"}` : "",
  ].filter(Boolean);
  const refsText = refs.length > 1 ? `${refs.slice(0, -1).join("; ")}; and ${refs[refs.length - 1]}` : refs[0];
  const loading = enabled && ((paths && ixp.state === "idle") || (Boolean(atlasIds) && roots.key !== atlasIds));
  const failed = [
    paths && ixp.state === "failed" ? "PeeringDB did not give the list of the exchange points (it limits how often an address can ask for it)" : "",
    isAtlas && roots.key === atlasIds && roots.state === "failed" ? "RIPE Atlas did not give the answers of the root servers" : "",
  ].filter(Boolean);

  let placeLine;
  if (!enabled) {
    placeLine = `Each probe can be checked against ${refsText}: a round trip to one of them shorter than light in fibre allows from the place of the probe proves that the probe is elsewhere. ${paths ? "PeeringDB and RIPE Atlas are" : "RIPE Atlas is"} asked from your browser, and ${paths ? "see" : "sees"} your address.`;
  } else if (loading) {
    placeLine = "Checking where the probes are…";
  } else if (!c.checked) {
    placeLine = `The place of the probes could not be checked${anchorPings ? "" : " yet"}: ${failed.length ? `${failed.join("; ")}.` : "no reference point could be used for these probes."}${anchorPings ? "" : " The anchors of RIPE Atlas can be pinged from them."}`;
  } else {
    placeLine = `${c.checked} of the ${plural(c.probes, "probe", "probes")} could be checked against ${refsText}${
      c.misplaced ? `, and ${plural(c.misplaced, "is", "are")} not where ${c.misplaced === 1 ? "it is" : "they are"} said to be` : `, and ${c.checked === 1 ? "it is" : "all are"} where ${c.checked === 1 ? "it is" : "they are"} said to be`
    }.${failed.length ? ` ${failed.join("; ")}.` : ""}`;
  }

  const showTable = paths || (enabled && !loading);
  const withPoints = enabled && !loading ? rows.filter((r) => r.place.points.length).map((r) => r.key) : [];
  const allOpen = withPoints.length > 0 && withPoints.every((k) => open.has(k));
  const linkButton = { padding: 0, border: 0, background: "none", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" };
  const cols = paths ? 6 : 3;

  return (
    <div ref={boxRef} style={{ marginBottom: 16, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10, scrollMargin: 16 }}>
      <h3 style={{ margin: "0 0 8px 0" }}>{paths ? "Trombone routing and probe locations" : "Probe locations"}</h3>

      {h ? (
        <div style={{ ...TONES[h.tone], color: "#111", padding: 10, borderRadius: 10, marginBottom: 10 }} role="note">
          <div style={{ fontWeight: 700 }}>{h.title}</div>
          <div style={{ marginTop: 2, fontSize: 13 }}>
            {h.text}
            {left.length ? ` Not read: ${left.join("; ")}.` : ""}
          </div>
        </div>
      ) : null}

      <div style={{ fontSize: 13, marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ flex: "1 1 320px" }}>{placeLine}</span>
        {enabled ? (
          <label style={{ fontSize: 12, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked onChange={() => toggle(false)} style={{ marginRight: 6 }} />
            Check the place of the probes
          </label>
        ) : (
          <button type="button" onClick={() => toggle(true)} style={{ padding: "4px 10px", borderRadius: 10, font: "inherit", fontSize: 12 }}>
            Check where the probes are
          </button>
        )}
      </div>

      {enabled ? (
        <div style={{ fontSize: 12, marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={runAnchors} disabled={!canPingAnchors} style={{ padding: "4px 10px", borderRadius: 10, font: "inherit", fontSize: 12 }}>
            {anchState === "done" ? "Ping the anchors again" : "Ping the anchors of RIPE Atlas"}
          </button>
          <span style={{ flex: "1 1 320px", opacity: anchState === "idle" ? 0.85 : 1, fontWeight: anchState === "idle" ? 400 : 700, color: anchState === "failed" ? "#b91c1c" : "inherit" }} role="status">
            {anchState === "running"
              ? `${anch.msg}…`
              : anchState === "failed"
                ? anch.msg
                : anchState === "done"
                  ? `${anch.msg}.`
                  : isAtlas
                    ? `The probes ping up to ${anchorsCount} anchors, three in their countries and one near each of eleven points of the world: new measurements on RIPE Atlas, which take a minute or two.`
                    : `The same probes ping up to ${anchorsCount} anchors, three in their countries and four in the world: ${anchorsCount} more measurements on Globalping.`}
          </span>
        </div>
      ) : null}

      {showTable ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={head}>#</th>
                <th style={head}>Probe</th>
                {paths ? <th style={head} title="The round trip to the target, from the first public address of the path">IPv4 net</th> : null}
                {paths ? <th style={head} title="The round trip to the target, from the first public address of the path">IPv6 net</th> : null}
                {paths ? <th style={head}>Reading</th> : null}
                <th style={head}>
                  Place
                  {withPoints.length > 1 ? (
                    <button type="button" onClick={() => setOpen(new Set(allOpen ? [] : withPoints))} style={{ ...linkButton, marginLeft: 8, fontWeight: 400, textDecoration: "underline" }}>
                      {allOpen ? "hide all details" : "show all details"}
                    </button>
                  ) : null}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const out = r.place.misplaced;
                const shown = enabled && !loading && r.place.points.length > 0 && open.has(r.key);
                const mark = <span style={{ fontWeight: 400, opacity: 0.7 }}>{shown ? "▾ " : "▸ "}</span>;
                return [
                  <tr key={r.key} style={out ? { background: "#fffbeb" } : undefined}>
                    <td style={cell}>{i + 1}</td>
                    <td style={cell}>
                      {probeLabel(r.probe)}
                      {r.probe?.network ? <span style={{ opacity: 0.7 }}> · {r.probe.network}</span> : r.probe?.asn ? <span style={{ opacity: 0.7 }}> · AS{r.probe.asn}</span> : null}
                    </td>
                    {paths ? <td style={cell}>{fmtMs(r.n4)}</td> : null}
                    {paths ? <td style={cell}>{fmtMs(r.n6)}</td> : null}
                    {paths ? <td style={cell}>{readingCell(r)}</td> : null}
                    <td style={cell}>
                      {!enabled || loading ? (
                        <span style={{ opacity: 0.6 }}>-</span>
                      ) : out ? (
                        <button type="button" onClick={() => flip(r.key)} aria-expanded={shown} style={{ ...linkButton, fontWeight: 700, color: "#92400e" }}>
                          {mark}not where it is said to be
                        </button>
                      ) : r.place.checked ? (
                        <button
                          type="button"
                          onClick={() => flip(r.key)}
                          aria-expanded={shown}
                          title={`${plural(r.place.checked, "reference point", "reference points")}, none of them too fast for the place: press for the figures`}
                          style={linkButton}
                        >
                          {mark}consistent ({r.place.checked})
                        </button>
                      ) : (
                        <span style={{ opacity: 0.7 }}>{r.placed ? "no reference point" : "no coordinates"}</span>
                      )}
                    </td>
                  </tr>,
                  out ? (
                    <tr key={`${r.key}-proof`} style={{ background: "#fffbeb" }}>
                      <td style={cell} />
                      <td style={cell} colSpan={cols - 1}>
                        {misplacedText(r, isAtlas)}
                        {paths ? " Its delays are not read as a trombone." : ""}
                      </td>
                    </tr>
                  ) : null,
                  shown ? (
                    <tr key={`${r.key}-points`} style={out ? { background: "#fffbeb" } : { background: "#f9fafb" }}>
                      <td style={cell} />
                      <td style={cell} colSpan={cols - 1}>
                        <PlaceDetails row={r} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <details style={{ marginTop: 10, fontSize: 12 }}>
        <summary style={{ cursor: "pointer" }}>How this is read</summary>
        {paths ? (
          <p style={{ margin: "8px 0 0 0" }}>
            A trombone is a path between two points that are near each other which goes far away and comes back. Light in fibre covers about 200 km
            in a millisecond (two thirds of its speed in vacuum, the speed of Internet), so a round trip of t ms proves that the target is within
            t/2 × 200 km. This page reaches the same target twice from the same probe: when one family gets there within {LONG_DELAY_MS} ms (net of
            the delay before the first public address, which is the access network of the probe) and the other needs {TROMBONE_MS} ms or more,
            distance cannot explain the slower one. Either its path goes elsewhere and comes back, or the name is served to that family from
            elsewhere (an anycast or a CDN with fewer sites on one family): it is a lead to follow in the hops, not a proof. When neither family is
            near, the target may simply be far, and nothing is said. A probe whose trace stops before the target is not read.
          </p>
        ) : null}
        <p style={{ margin: "8px 0 0 0" }}>
          The reading supposes that each probe is where it is said to be. Globalping places a probe by the address it connects from, and the hosts
          of RIPE Atlas place theirs on a map;{" "}
          <a href="https://doi.org/10.1145/3777912.3839804" target="_blank" rel="noopener noreferrer">
            Izhikevich and others
          </a>{" "}
          (IMC 2026) found with the round trips to the DNS root servers that 2.4% of the probes of RIPE Atlas could not be where they were said
          to be. The same rule is applied here with three kinds of points whose place is known: the exchange points that a traceroute crosses (a
          hop on the LAN of an exchange is on the other side of its switch; margin 100 km) and, for the probes of RIPE Atlas, the instances of the
          root servers that answer <code>hostname.bind</code> (margin 300 km, because the place of an instance is the one of its city); and, on
          request, the anchors of RIPE Atlas, probes in data centres whose places are checked, which the probes of the measurement ping
          (margin 100 km).
          Queues, slow answers and tunnels only add time, so they never make a probe look misplaced. The method comes from{" "}
          <a href="https://aspa.ping6.it/guide.html#probe-place" target="_blank" rel="noopener noreferrer">
            ASPA Explorer
          </a>
          .
        </p>
      </details>
    </div>
  );
}

export default memo(PathChecks);
