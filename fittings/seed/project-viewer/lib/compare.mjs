// Join what the code says against what the run did.
//
// Three buckets, and the reason each is scoped the way it is:
//
//   deadCode        exports nothing references. Static evidence only, and stated as
//                   candidates — the scan cannot see a dynamic import or a symbol
//                   reached by name through a string.
//
//   unexercised     ROUTE FILES no capture ever resolved. Scoped to route files on
//                   purpose: route resolution is the only thing the runtime half
//                   actually observes, so it is the only absence it is entitled to
//                   report. Listing every unvisited helper as "never observed" would
//                   be reporting a blindness as a finding — the instrument never
//                   watched helpers in the first place.
//
//   inconsistencies the same exported name in more than one place. The weakest of
//                   the three, and labelled as a question rather than a defect.
//
// Pure. The caller supplies the sha and the timestamp, so the same inputs always
// produce the same report.

import { deadCandidates, duplicateNames, isFrameworkEntry } from "./static-scan.mjs";

const LIST_CAP = 200;

/** Every file any capture proved was executed, as a Set of repo-relative paths. */
export function observedFiles(captures) {
  const out = new Set();
  for (const capture of captures ?? []) {
    for (const event of capture?.events ?? []) {
      if (event.type !== "route") continue;
      if (event.file) out.add(event.file);
      // A redirect stub is executed too — it is what sent the reader onward. The hop
      // field is `file`; an earlier version read `from` and so quietly counted no
      // stub as observed, which would have listed every redirect page as untested.
      for (const hop of event.via ?? []) if (hop.file) out.add(hop.file);
    }
  }
  return out;
}

/** Every file the viewer currently shows code from, across all manifests. */
export function narratedFiles(flows) {
  const out = new Set();
  for (const flow of flows ?? []) {
    for (const state of flow?.states ?? []) {
      for (const step of state?.steps ?? []) {
        const file = step?.sample?.file ?? step?.diffSample?.file;
        if (file) out.add(file);
      }
    }
  }
  return out;
}

export function buildCompareReport({
  scan,
  captures = [],
  flows = [],
  files = [],
  sha = null,
  generatedAt = null,
} = {}) {
  if (!scan || !Array.isArray(scan.symbols)) throw new Error("buildCompareReport needs a scan");

  const observed = observedFiles(captures);
  const narrated = narratedFiles(flows);

  const candidates = deadCandidates(scan);
  const dead = candidates.map((d) => ({
    file: d.file,
    line: d.line,
    symbol: d.symbol,
    note: noteFor(d),
  }));

  // Route files, from the file list rather than from the scan, because a route file
  // may export nothing this scanner recognises and still be a page.
  const routeFiles = files.filter(
    (f) => isFrameworkEntry(f) && /(?:^|\/)(?:src\/)?app\//.test(f) && !/\.config\./.test(f)
  );
  // With no captures at all, NOTHING may be reported as never-observed. Every page
  // would qualify, and each entry would be a claim about a run that never happened —
  // an absence of observation dressed up as an observation of absence. The bucket
  // stays empty and the blind-spot note says why.
  const unexercised =
    (captures ?? []).length === 0
      ? []
      : routeFiles
          .filter((f) => !observed.has(f))
          .map((f) => ({
            file: f,
            symbol: "",
            note: narrated.has(f)
              ? "the viewer narrates this page, but no captured run ever landed on it"
              : "no captured run ever landed on this page",
          }))
          .sort((a, b) => a.file.localeCompare(b.file));

  const inconsistencies = duplicateNames(scan).map((d) => ({
    file: d.places[0].file,
    line: d.places[0].line,
    symbol: d.symbol,
    note: `also exported from ${d.places
      .slice(1)
      .map((p) => p.file)
      .join(", ")} — same job twice, or two different jobs with one name?`,
  }));

  const report = {
    schemaVersion: 1,
    sha,
    generatedAt,
    stats: {
      filesScanned: scan.scanned ?? 0,
      exportsFound: scan.symbols.length,
      routeFiles: routeFiles.length,
      // Counted from what was actually observed, not as "total minus unexercised":
      // with no captures the bucket is empty by policy, and that subtraction would
      // have reported every page as observed.
      routeFilesObserved: routeFiles.filter((f) => observed.has(f)).length,
      capturesUsed: (captures ?? []).length,
      // Split out, because the two are different questions and the totals otherwise
      // read as one big pile of deletable code.
      deadValueExports: candidates.filter((c) => !c.typeOnly).length,
      deadTypeExports: candidates.filter((c) => c.typeOnly).length,
    },
    // Where the scan is blind. Printed rather than omitted, so nobody reads a short
    // dead-code list as proof of a tidy codebase.
    blindSpots: [
      ...(scan.opaqueReexports ?? []).map((f) => `${f} re-exports with \`export *\`, so its exports were not enumerated`),
      ...((captures ?? []).length === 0
        ? ["no runtime captures were available, so the unexercised bucket is empty by default, not by evidence"]
        : coverageCaveat(captures)),
    ],
    // Dead-code candidates grouped by area. Without this, a repo that vendors thirty
    // packages plus an archive of old run output produces one flat list of hundreds
    // and the reader cannot tell that most of it is in a directory nobody ships.
    byArea: countByArea(dead),
    deadCode: cap(dead),
    unexercised: cap(unexercised),
    inconsistencies: cap(inconsistencies),
  };
  report.truncated = {
    deadCode: Math.max(0, dead.length - report.deadCode.length),
    unexercised: Math.max(0, unexercised.length - report.unexercised.length),
    inconsistencies: Math.max(0, inconsistencies.length - report.inconsistencies.length),
  };
  report.markdown = compareMarkdown(report);
  return report;
}

function cap(list) {
  return list.slice(0, LIST_CAP);
}

/**
 * Say which repair this candidate is asking for, because they are not the same job.
 * A function its own module calls is alive and only its `export` is surplus; a
 * function nothing calls at all is the deletable case. Collapsing the two into "dead
 * code" is how a report gets someone to delete something that was in use.
 */
export function noteFor(d) {
  if (d.typeOnly) {
    return (
      `exported ${d.kind} with no importer — types leave no runtime trace, so this is an ` +
      "API-surface question rather than dead weight"
    );
  }
  if (d.usedInternally && d.testOnly) {
    return `${d.kind} used inside its own file and imported only by tests — the export may be there for the test alone`;
  }
  if (d.usedInternally) {
    return `${d.kind} used inside its own file but imported nowhere — the export is surplus, the code is not`;
  }
  if (d.testOnly) {
    return `${d.kind} referenced only by tests — either the feature went away and its test survived, or the export exists for the test alone`;
  }
  return `${d.kind} nothing references, in this file or any other`;
}

/**
 * The caveat that stops the unexercised bucket from libelling the test suite.
 *
 * A page absent from every capture may be thoroughly tested by a spec that was never
 * captured. Reporting 123 unobserved pages after capturing one spec out of twenty-two
 * reads as "this app is barely tested", which would be a false claim about someone
 * else's work. So the report states how narrow its evidence was.
 */
export function coverageCaveat(captures) {
  const specs = [...new Set((captures ?? []).map((c) => c?.test?.file).filter(Boolean))];
  if (!specs.length) return [];
  const shown = specs.slice(0, 3).join(", ");
  return [
    `the ${captures.length} capture(s) came from ${specs.length} spec file(s) (${shown}${
      specs.length > 3 ? `, +${specs.length - 3} more` : ""
    }). A page missing from the observed list may be covered by a spec that was never captured, ` +
      "not by no spec at all — capture more before reading this as a coverage gap.",
  ];
}

/** Dead-code candidate counts per area, deepest useful grouping being two segments. */
export function countByArea(items) {
  const counts = new Map();
  for (const item of items) {
    const parts = String(item.file ?? "").split("/");
    const area = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? "";
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

/**
 * The copy-pasteable block. Written for someone pasting it into an issue or a chat,
 * so it leads with the caveat: this is a list to check, not a list to action.
 */
export function compareMarkdown(report) {
  const lines = [];
  const short = String(report.sha ?? "").slice(0, 8);
  lines.push(`## Static vs runtime — ${short || "unknown sha"}`);
  lines.push("");
  lines.push(
    `Scanned ${report.stats.filesScanned} source files (${report.stats.exportsFound} exports) against ` +
      `${report.stats.capturesUsed} runtime capture(s). ` +
      `${report.stats.routeFilesObserved}/${report.stats.routeFiles} route files were observed executing.`
  );
  lines.push("");
  if (report.stats.deadTypeExports) {
    lines.push(
      `Of ${report.stats.deadValueExports + report.stats.deadTypeExports} unreferenced exports, ` +
        `${report.stats.deadValueExports} are values (functions, classes, constants) and ` +
        `${report.stats.deadTypeExports} are TypeScript types. The values are listed first: ` +
        "deleting a type changes nothing that ships."
    );
    lines.push("");
  }
  lines.push("**Everything below is a candidate.** Nothing here is evidence that code is unused —");
  lines.push("a dynamic import, a symbol reached by string name, or a route only a human visits");
  lines.push("all look identical to deletion-safe from a static scan. Verify before removing.");

  const section = (title, items, extra) => {
    if (!items.length) return;
    lines.push("");
    lines.push(`### ${title} (${items.length}${extra ? `, ${extra}` : ""})`);
    for (const i of items) {
      lines.push(`- \`${i.file}${i.line ? `:${i.line}` : ""}\`${i.symbol ? ` — \`${i.symbol}\`` : ""} — ${i.note}`);
    }
  };

  // Where the candidates are, before what they are. A reader who sees that most of
  // them sit in an archive directory can stop reading, which is the useful outcome.
  if (report.byArea?.length > 1) {
    const total = report.byArea.reduce((n, a) => n + a.count, 0);
    lines.push("");
    lines.push(`### Where the ${total} dead-code candidates are`);
    for (const a of report.byArea.slice(0, 12)) lines.push(`- \`${a.area}\` — ${a.count}`);
    if (report.byArea.length > 12) lines.push(`- …and ${report.byArea.length - 12} other areas`);
  }

  section(
    "Dead-code candidates",
    report.deadCode,
    report.truncated?.deadCode ? `${report.truncated.deadCode} more not listed` : null
  );
  section(
    "Pages never observed executing",
    report.unexercised,
    report.truncated?.unexercised ? `${report.truncated.unexercised} more not listed` : null
  );
  section(
    "Same name in more than one place",
    report.inconsistencies,
    report.truncated?.inconsistencies ? `${report.truncated.inconsistencies} more not listed` : null
  );

  if (report.blindSpots?.length) {
    lines.push("");
    lines.push("### What this scan could not see");
    for (const b of report.blindSpots) lines.push(`- ${b}`);
  }

  return `${lines.join("\n")}\n`;
}
