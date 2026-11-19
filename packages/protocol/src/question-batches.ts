import { z } from 'zod';

const str = z.string().min(1).max(65536);

export const questionBatchInputSchemas = {
  /** The user only; answers several open questions of one lead's plan, each as its own answer, and wakes the lead once. Refused as a whole when any question is missing or already answered. */
  'lead.questions.answer_batch': z.strictObject({
    project_id: str,
    lead_session_id: str.describe('The lead whose plan holds the questions.'),
    answers: z
      .array(
        z.strictObject({
          question_id: str,
          answer: str,
          /** A relayed worker question only: question text to the answer, as approval.respond takes it. */
          answers: z.record(str, str).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  /** The user only; drops the deadline of an open question, so its recommended answer never applies on its own. */
  'lead.question.keep_open': z.strictObject({
    project_id: str,
    lead_session_id: str.describe('The lead whose plan holds the question.'),
    question_id: str,
  }),
};
