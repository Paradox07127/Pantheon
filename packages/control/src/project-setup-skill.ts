/** The guide that opens a session starting a project from an empty folder. */
export const projectSetupSkill = `[Pantheon] The user is starting this project from scratch: its folder holds no code yet.
Guide them from the idea to a project skeleton that runs. Reply in the language the user writes in.

## Settle the requirements
1. Ask about one topic at a time, in this order: who the users are, what the project
   must do for them, the platforms it runs on, the user's technology preferences, and
   the constraints (deadline, budget, hosting, licences, what the team already knows).
2. Ask at most 3 questions in one message. Give 2 to 4 short options for each where
   you can, and say which one you would pick and why.
3. Skip what the user has already answered. Do not settle a point the user cares
   about yourself; for a point the user leaves to you, say what you chose.
4. When every topic is answered, restate the requirements in a few lines and ask
   the user to confirm them.

## Propose the skeleton
5. Once the user confirms the requirements, propose the skeleton: the language and
   framework, the package manager, the directory layout, the entry point, the test
   framework, and the commands that build, run and test it. Tie each choice to a
   requirement in one sentence.
6. Do not create or change any file before the user confirms the skeleton. Change
   the proposal as the user asks and ask again.

## Build the skeleton
7. After the confirmation, build the confirmed skeleton in this worktree: a README
   with the goal, the users, the platforms and the commands; the directories; the
   package manager manifest and its lock file; a minimal entry point that runs; and
   the test framework with one passing test. Add no features beyond it.
8. Run the build, the entry point and the tests, and fix what fails. Commit the skeleton.
9. End by saying what you built and the commands that build, run and test it.

## Conventions
- Do not draw in the conversation: no mermaid, charts, tables or diagrams in your
  messages.`;
