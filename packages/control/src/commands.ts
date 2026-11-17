import { runtimeReviewHandlers } from './runtime-review.js';
import { memoryHandlers } from './memory.js';
import { projectIntroPreparers } from './project-intro.js';
import { baselineHandlers, baselinePreparers } from './baseline.js';
import { changeStoryHandlers } from './change-story.js';
import { rangeStoryHandlers, rangeStoryPreparers } from './range-story.js';
import type { Handlers, Preparers } from './context.js';
import { projectFactHandlers } from './project-facts.js';
import { projectBoardHandlers } from './project-board.js';
import { projectHandlers } from './project.js';
import { prepareResolve, sessionHandlers } from './session.js';
import { workbenchSessionHandlers } from './workbench-session.js';
import { approvalHandlers } from './approvals.js';
import { prepareReviewRequest, reviewHandlers } from './review.js';
import { prepareBoardSync, prepareTaskReport, taskTrackingHandlers } from './task-tracking.js';
import { taskDispatchHandlers } from './task-dispatch.js';
import { leadInboxHandlers } from './lead-inbox.js';
import { workflowEngineHandlers } from './workflow-engine.js';
import { routingHandlers } from './routing-table.js';
import { workflowPolicyHandlers } from './workflow-policy.js';
import { improvementHandlers } from './improvements.js';
import { inPlaceSessionHandlers } from './in-place-session.js';
import { visualHandlers } from './visual.js';
import { themeHandlers } from './theme.js';
import { styleHandlers } from './user-style.js';
import { appSettingsHandlers } from './app-settings.js';
import { deviceHandlers } from './devices.js';
import { externalEventHandlers } from './external-events.js';

export const handlers: Handlers = {
  ...memoryHandlers,
  ...projectHandlers,
  ...projectFactHandlers,
  ...projectBoardHandlers,
  ...baselineHandlers,
  ...changeStoryHandlers,
  ...rangeStoryHandlers,
  ...sessionHandlers,
  ...runtimeReviewHandlers,
  ...workbenchSessionHandlers,
  ...approvalHandlers,
  ...reviewHandlers,
  ...taskTrackingHandlers,
  ...taskDispatchHandlers,
  ...leadInboxHandlers,
  ...workflowPolicyHandlers,
  ...routingHandlers,
  ...workflowEngineHandlers,
  ...improvementHandlers,
  ...inPlaceSessionHandlers,
  ...appSettingsHandlers,
  ...deviceHandlers,
  ...externalEventHandlers,
  ...visualHandlers,
  ...themeHandlers,
  ...styleHandlers,
};

export const preparers: Preparers = {
  ...baselinePreparers,
  ...projectIntroPreparers,
  ...rangeStoryPreparers,
  'task.report': prepareTaskReport,
  'board.sync': prepareBoardSync,
  'review.request': prepareReviewRequest,
  'session.resolve': prepareResolve,
};
