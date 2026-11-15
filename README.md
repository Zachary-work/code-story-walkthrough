# Code Story Walkthrough

Review a change as stories instead of file by file. Each story starts at an entry point (a route,
an event handler, a command) and follows the calls down to the code that changed.

Two parts work together through files in `.stories/`:

- **The VS Code extension** shows the stories in a panel beside the editor, keeps the editor on the
  step you are reading, and lets you leave review comments in the gutter.
- **The `code-stories` agent skill** (in `skill/code-stories/`) teaches an AI agent such as Claude
  Code to write the stories from a diff and to answer your comments.

## How it flows

1. Ask your agent: **"Create code stories for this branch"**. It writes the stories into a folder
   of their own, `.stories/<branch>/stories.json`. Ask again after more work on the same branch and
   it refreshes that same set; work on another branch gets another set (see [Story sets](#story-sets)).
2. Run **Code Stories: Open Story Panel**. Pick a story, then step through it. Clicking a line,
   an arrow in the sequence diagram or a class opens that file at that line in the editor.
   The overview also accounts for every changed file. Files that are on no story's path are listed
   under **Changes not in a story**, grouped by the reason they were left out; click one to see its
   diff. A changed file that the stories file does not mention at all is flagged as missing.
3. To comment, select lines in the editor and use the plus in the gutter.
   - **Comment locally** saves to `comments.json` next to the stories, for your agent.
   - **Comment on PR** posts a review comment to the linked GitHub pull request (needs the
     [`gh` CLI](https://cli.github.com), signed in).
4. Ask your agent: **"Read and address my review comments"**. It replies in each thread and either
   makes the change, declines with a reason, or answers the question. The thread updates in place.
5. Mark each story reviewed. A story's mark is cleared only if that story's content changes.

## Try it

```
npm install
npm run compile
```

Press F5 in VS Code ("Run Extension (example workspace)"). It opens `example/`, which has two
stories and two comments. Run **Code Stories: Open Story Panel**.

To build an installable `.vsix`: `npm run package`.

## Install the skill

Run **Code Stories: Install Agent Skill** and choose where it goes (`.claude/skills` in the
workspace, `.agents/skills`, or `~/.claude/skills`). Or copy `skill/code-stories/` there yourself.

The skill includes three scripts the agent runs with Node:

- `scripts/sets.mjs` lists the story sets and prints the folder a set is written to.
- `scripts/validate.mjs` checks `stories.json`: structure, that every quoted line matches the file
  at that line number, and that every changed file is in a story or listed as "not in a story"
  with a reason.
- `scripts/comments.mjs` lists waiting comments and records replies.

The file formats are documented in `skill/code-stories/references/schema.md`.

## Story sets

Each change keeps its stories and review comments in its own folder, so two changes you work on
in parallel never overwrite each other:

```
.stories/
  feature-promo-codes/     stories.json, comments.json
  fix-tax-rounding/        stories.json, comments.json
```

- The set is named after the branch. On the default branch (`main`), where unrelated changes
  follow each other, the agent names the set after the change, and asks you when it cannot tell
  whether new work is a follow-up to an existing set.
- The panel shows the set for the branch you have checked out and follows you when you switch
  branches. If the branch has no set yet, it shows another one and says which branch that one
  was written for.
- With more than one set, the overview has a **Story set** picker and a **Delete set** button
  (it goes to the trash). **Code Stories: Switch Story Set** does the same from the command palette.
- Opening any set's `stories.json` opens the panel on that set.
- A `.stories/stories.json` from an earlier version still works, as the set called `default`.

## Notes

- `.stories/` is review state for your working copy. Add it to `.gitignore` unless you want to
  share the stories with the PR.
- Lines are found by their text as well as their number, so the editor and comment threads follow
  code that has moved a little. If `HEAD` no longer matches the commit the stories were written
  for, the panel says so.
