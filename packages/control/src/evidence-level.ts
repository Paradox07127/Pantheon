import { runtimeIndependence } from './runtime-vendor.js';

/** What backs a plan item as done; absent while it neither landed nor was accepted. */
export function planItemEvidence(facts: {
  landed: boolean;
  /** The user accepted the item. */
  accepted: boolean;
  /** The landed session's last gate run before it landed; absent when none ran. */
  gate?: 'passed' | 'failed' | 'skipped';
  /** The newest review of the landed session. */
  review?: {
    failed: boolean;
    to_sha?: string;
    verdicts: { runtime: string; verdict: 'pass' | 'fail' }[];
  };
  /** The commit the session had when it landed (session.merged head_sha). */
  landed_head?: string;
  /** The runtime of the session that landed; best-of-N passes only that one. */
  writer?: string;
}):
  | {
      level: 'report' | 'gate' | 'reviewed' | 'accepted';
      reviewer?: 'other_vendor' | 'other_runtime';
    }
  | undefined {
  if (facts.accepted) return { level: 'accepted' };
  if (!facts.landed) return undefined;
  const writer = facts.writer;
  // A review vouches only for the commit that landed, not for one made after it.
  const independent =
    facts.review &&
    !facts.review.failed &&
    facts.review.to_sha !== undefined &&
    facts.review.to_sha === facts.landed_head &&
    writer
      ? facts.review.verdicts
          .filter((given) => given.verdict === 'pass')
          .map((given) => runtimeIndependence([writer], given.runtime))
          .filter((independence) => independence !== 'same_runtime')
      : [];
  if (independent.length)
    return {
      level: 'reviewed',
      reviewer: independent.includes('other_vendor') ? 'other_vendor' : 'other_runtime',
    };
  return facts.gate === 'passed' ? { level: 'gate' } : { level: 'report' };
}
