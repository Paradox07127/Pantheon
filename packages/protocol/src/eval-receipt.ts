import { z } from 'zod';

/** The receipt of a paired eval run that a playbook change rests on; the user's confirmation checks it. */
export const evalReceiptSchema = z.strictObject({
  kind: z
    .literal('eval_receipt')
    .describe('A paired eval run of the current and the new playbook.'),
  path: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^\//, 'Give an absolute path')
    .describe('The absolute path of the runs.jsonl the eval run wrote.'),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Give 64 lowercase hex digits')
    .describe('The sha256 of that runs.jsonl, in lowercase hex.'),
  verdict: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'A verdict of the eval report exactly as it gives it, such as "<condition>_passes_more", "<condition>_cheaper" or "no_conclusion". Only a verdict for the second condition, the new playbook, lets the change be confirmed.',
    ),
});
