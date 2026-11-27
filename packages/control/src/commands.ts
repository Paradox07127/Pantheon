import { runtimeReviewHandlers } from './runtime-review.js';
import { memoryHandlers, memoryPreparers } from './memory.js';
import { projectIntroPreparers } from './project-intro.js';
import { baselinePreparers } from './baseline.js';
import { environmentCheckHandlers } from './environment-check.js';
import { branchLandingHandlers, branchLandingPreparers } from './branch-landing.js';
import { conductorPreparers } from './conductor.js';
import { changeStoryHandlers } from './change-story.js';
import type { Handlers, Preparers } from './context.js';
import { residentHandlers } from './resident.js';
import { routineHandlers } from './routines.js';
import { projectFactHandlers } from './project-facts.js';
import { projectHandlers, projectPreparers } from './project.js';
import { prepareResolve, sessionHandlers } from './session.js';
import { workbenchSessionHandlers } from './workbench-session.js';
import { approvalHandlers } from './approvals.js';
import { prepareRangeReview, prepareReviewRequest, reviewHandlers } from './review.js';
import { settingProposalPreparers } from './setting-proposal.js';
import { projectPlanPreparers } from './project-plan.js';
import { workflowPolicyHandlers } from './workflow-policy.js';
import { inPlaceSessionHandlers } from './in-place-session.js';
import { visualHandlers } from './visual.js';
import { appSettingsHandlers } from './app-settings.js';
import { deviceHandlers } from './devices.js';
import { projectBriefHandlers } from './project-brief.js';
import { briefProseHandlers } from './project-brief-prose.js';
import { personalKeyHandlers } from './personal-keys.js';

export const handlers: Handlers = {
  ...memoryHandlers,
  ...projectHandlers,
  ...residentHandlers,
  ...routineHandlers,
  ...projectFactHandlers,
  ...environmentCheckHandlers,
  ...branchLandingHandlers,
  ...changeStoryHandlers,
  ...sessionHandlers,
  ...runtimeReviewHandlers,
  ...workbenchSessionHandlers,
  ...approvalHandlers,
  ...reviewHandlers,
  ...workflowPolicyHandlers,
  ...inPlaceSessionHandlers,
  ...appSettingsHandlers,
  ...deviceHandlers,
  ...projectBriefHandlers,
  ...briefProseHandlers,
  ...personalKeyHandlers,
  ...visualHandlers,
};

export const preparers: Preparers = {
  ...memoryPreparers,
  ...projectPreparers,
  ...baselinePreparers,
  ...projectIntroPreparers,
  ...branchLandingPreparers,
  ...conductorPreparers,
  ...settingProposalPreparers,
  ...projectPlanPreparers,
  'review.request': prepareReviewRequest,
  'review.range': prepareRangeReview,
  'session.resolve': prepareResolve,
};
