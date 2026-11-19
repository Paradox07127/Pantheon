// The lead playbook versions a `playbook=<version>` condition sets before its run. A version
// replaces these sections of the playbook the product ships and keeps the others; add a version
// here to measure it against another.
export const playbookVersions = {
  v1: {},
  v2: {
    replies: '- End every turn with one short line that says what changed or what you wait for.',
  },
};
