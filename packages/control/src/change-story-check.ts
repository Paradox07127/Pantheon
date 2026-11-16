import type {
  LandingItem,
  StoryAnchor,
  StoryCard,
  StoryCardInput,
  StoryDiagram,
  StoryEvidence,
  StoryResult,
  StorySide,
  StorySubmission,
} from '@pantheon/domain';
import type { LandingDiff } from '@pantheon/protocol';

type StoryTask = { acceptance: readonly string[] };

export interface StoryCheckInput {
  diff: LandingDiff;
  task: StoryTask;
  gates: NonNullable<LandingItem['gate_results']>;
  submission: StorySubmission;
  /** File text at a commit; null when the file does not exist there. */
  show: (sha: string, file: string) => string | null;
}

function structureErrors(at: string, diagram: StoryDiagram): string[] {
  const errors: string[] = [];
  if (diagram.type === 'flow') {
    const ids = new Set<string>();
    for (const node of diagram.nodes) {
      if (ids.has(node.id)) errors.push(`${at} flow node id ${node.id} is used more than once.`);
      ids.add(node.id);
      if (!diagram.lanes.includes(node.lane))
        errors.push(`${at} flow node ${node.id} is in lane ${node.lane}, which is not in lanes.`);
    }
    const sides = new Map(diagram.nodes.map((node) => [node.id, node.side]));
    for (const edge of diagram.edges)
      for (const end of [edge.from, edge.to]) {
        const side = sides.get(end);
        if (!ids.has(end))
          errors.push(
            `${at} flow edge ${edge.from} -> ${edge.to} names ${end}, which is not a node id.`,
          );
        else if (side !== 'both' && side !== edge.side)
          errors.push(
            `${at} flow edge ${edge.from} -> ${edge.to} is on side ${edge.side}, but node ${end} is only on side ${side}.`,
          );
      }
  }
  if (diagram.type === 'ui') {
    const ids = new Set<string>();
    for (const region of diagram.regions) {
      if (ids.has(region.id))
        errors.push(`${at} ui region id ${region.id} is used more than once.`);
      ids.add(region.id);
    }
    for (const region of diagram.regions)
      if (region.parent !== undefined && !ids.has(region.parent))
        errors.push(
          `${at} ui region ${region.id} has parent ${region.parent}, which is not a region id.`,
        );
  }
  return errors;
}

function submissionErrors(
  diff: LandingDiff,
  task: StoryTask,
  submission: StorySubmission,
): string[] {
  const known = new Set(diff.hunks.map((hunk) => hunk.id));
  const errors: string[] = [];
  const unknown = (where: string, ids: string[]) => {
    for (const id of ids)
      if (!known.has(id)) errors.push(`${where} cites ${id}, which is not a hunk in the diff.`);
  };
  if (submission.overall.before.length !== submission.overall.after.length)
    errors.push(
      `overall.before has ${submission.overall.before.length} entries but overall.after has ${submission.overall.after.length}; they must pair up.`,
    );
  unknown('noise', submission.noise);
  const noise = new Set(submission.noise);
  submission.cards.forEach((card, index) => {
    const at = `card ${index}`;
    const own = new Set(card.hunks);
    unknown(`${at} hunks`, card.hunks);
    card.how.forEach((step, stepIndex) => {
      unknown(`${at} how[${stepIndex}]`, step.hunks);
      for (const id of step.hunks)
        if (known.has(id) && !own.has(id))
          errors.push(`${at} how[${stepIndex}] cites ${id}, which is not in the card's hunks.`);
    });
    unknown(`${at} tests`, card.tests);
    for (const id of card.tests)
      if (known.has(id) && !own.has(id))
        errors.push(`${at} tests cites ${id}, which is not in the card's hunks.`);
    for (const item of card.acceptance)
      if (item >= task.acceptance.length)
        errors.push(
          `${at} acceptance cites ${item}, but the task has ${task.acceptance.length} acceptance items.`,
        );
    for (const id of card.hunks)
      if (noise.has(id)) errors.push(`${at} hunks cites ${id}, which is also in noise.`);
    if (card.diagram) errors.push(...structureErrors(at, card.diagram));
  });
  return errors;
}

function evidence(
  diff: LandingDiff,
  card: StoryCardInput,
  gates: StoryCheckInput['gates'],
): StoryEvidence[] {
  const files = new Set(card.tests.map((id) => diff.hunks.find((hunk) => hunk.id === id)!.file));
  const needles = [...files].flatMap((file) => [file, file.slice(file.lastIndexOf('/') + 1)]);
  const names = (text: string) => needles.some((needle) => text.includes(needle));
  const found = new Map<string, StoryEvidence>();
  const add = (entry: StoryEvidence) =>
    found.set(JSON.stringify([entry.source, entry.id, entry.label]), entry);
  if (!needles.length) return [];
  for (const gate of gates)
    if (gate.state !== 'skipped' && names(gate.output))
      add({
        source: 'gate',
        id: gate.name,
        label: gate.argv.join(' '),
        status: gate.exit_code === 0 && !gate.timed_out ? 'passed' : 'failed',
      });
  return [...found.values()];
}

type Element = { key: string; quotes: string[]; valid: boolean };

function diagramView(
  diff: LandingDiff,
  card: StoryCardInput,
  spec: StoryDiagram,
  text: (sha: string, file: string) => string | null,
): StoryCard['diagram'] {
  const at = (anchor: { file: string; quote: string }, shas: string[]) => {
    for (const sha of shas) if (!text(sha, anchor.file)?.includes(anchor.quote)) return false;
    return true;
  };
  const shas = (side: StorySide) =>
    side === 'before'
      ? [diff.from_sha]
      : side === 'after'
        ? [diff.to_sha]
        : [diff.from_sha, diff.to_sha];
  const anchored = (key: string, side: StorySide, anchor?: StoryAnchor): Element => ({
    key,
    quotes: anchor ? [anchor.quote] : [],
    valid: anchor !== undefined && at(anchor, shas(side)),
  });
  const elements: Element[] = [];
  if (spec.type === 'flow')
    for (const node of spec.nodes) elements.push(anchored(node.id, node.side, node.anchor));
  if (spec.type === 'ui')
    for (const region of spec.regions)
      elements.push(anchored(region.id, region.side, region.anchor));
  if (spec.type === 'decision')
    for (const [index, row] of spec.rows.entries()) {
      const anchors: [StoryAnchor, string][] = [];
      if (row.before_anchor) anchors.push([row.before_anchor, diff.from_sha]);
      if (row.after_anchor) anchors.push([row.after_anchor, diff.to_sha]);
      let valid = anchors.length > 0;
      for (const [anchor, sha] of anchors) if (!at(anchor, [sha])) valid = false;
      elements.push({ key: String(index), quotes: anchors.map(([anchor]) => anchor.quote), valid });
    }
  if (spec.type === 'type')
    for (const [index, field] of spec.fields.entries())
      elements.push({
        key: String(index),
        quotes: [field.quote],
        valid: at({ file: spec.file, quote: field.quote }, shas(field.side)),
      });
  const inferred = elements.filter((element) => !element.valid).map((element) => element.key);
  if (inferred.length * 2 > elements.length) return undefined;
  const hunks: Record<string, string> = {};
  const own = card.hunks.map((id) => diff.hunks.find((hunk) => hunk.id === id)!);
  for (const element of elements) {
    if (!element.valid) continue;
    const hunk = own.find((candidate) =>
      element.quotes.some((quote) => candidate.text.includes(quote)),
    );
    if (hunk) hunks[element.key] = hunk.id;
  }
  return { spec, inferred, hunks };
}

/** Checks a model's interpretation against the diff it was given; nothing it claims is trusted. */
export function checkStory(
  input: StoryCheckInput,
): { ok: true; result: StoryResult } | { ok: false; errors: string[] } {
  const { diff, task, gates, submission } = input;
  const errors = submissionErrors(diff, task, submission);
  if (errors.length) return { ok: false, errors };
  const shown = new Map<string, string | null>();
  const text = (sha: string, file: string) => {
    const key = JSON.stringify([sha, file]);
    if (!shown.has(key)) shown.set(key, input.show(sha, file));
    return shown.get(key)!;
  };
  const cards: StoryCard[] = [];
  for (const [index, { diagram, ...card }] of submission.cards.entries()) {
    const shared_with = submission.cards
      .map((other, otherIndex) =>
        otherIndex !== index && other.hunks.some((id) => card.hunks.includes(id)) ? otherIndex : -1,
      )
      .filter((otherIndex) => otherIndex >= 0);
    const view = diagram && diagramView(diff, card, diagram, text);
    cards.push({
      ...card,
      // Without acceptance items there is no task scope to fall outside of.
      out_of_scope: task.acceptance.length > 0 && card.acceptance.length === 0,
      evidence: evidence(diff, card, gates),
      ...(view && { diagram: view }),
      shared_with,
    });
  }
  const claimed = new Set([...submission.noise, ...submission.cards.flatMap((card) => card.hunks)]);
  const cited = new Set(submission.cards.flatMap((card) => card.acceptance));
  return {
    ok: true,
    result: {
      overall: submission.overall,
      cards,
      noise: submission.noise,
      uninterpreted: diff.hunks.filter((hunk) => !claimed.has(hunk.id)).map((hunk) => hunk.id),
      hunk_total: diff.hunks.length,
      unmatched_acceptance: task.acceptance
        .map((_, index) => index)
        .filter((index) => !cited.has(index)),
    },
  };
}

/** A patch of only the given hunks, for `git apply -R` on to_sha. */
export function cardPatch(diff: LandingDiff, hunkIds: string[]): string {
  const chosen = new Set(hunkIds);
  const lines: string[] = [];
  for (const file of diff.files) {
    const hunks = diff.hunks.filter((hunk) => hunk.file === file.path && chosen.has(hunk.id));
    if (!hunks.length) continue;
    const old = file.old_path ?? file.path;
    lines.push(`diff --git a/${old} b/${file.path}`);
    // git apply refuses a /dev/null side without the mode line.
    if (file.status === 'added') lines.push('new file mode 100644');
    if (file.status === 'deleted') lines.push('deleted file mode 100644');
    if (file.status === 'renamed') lines.push(`rename from ${old}`, `rename to ${file.path}`);
    lines.push(
      file.status === 'added' ? '--- /dev/null' : `--- a/${old}`,
      file.status === 'deleted' ? '+++ /dev/null' : `+++ b/${file.path}`,
    );
    for (const hunk of hunks) lines.push(hunk.header, hunk.text);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
