# Code Story Walkthrough

Review a change as stories instead of file by file. Each story starts at an entry point (a route,
an event handler, a command) and follows the calls down to the code that changed.

Two parts work together through files in `.stories/`:

- **The VS Code extension** shows the stories in a panel beside the editor, keeps the editor on the
  step you are reading, and lets you leave review comments in the gutter.
- **The `code-stories` agent skill** (in `skill/code-stories/`) teaches an AI agent such as Claude
  Code to write the stories from a diff and to answer your comments.

## How it flows

1. Ask your agent: **"Create code stories for this branch"**. It writes `.stories/stories.json`.
2. Run **Code Stories: Open Story Panel**. Pick a story, then step through it. Clicking a line,
   an arrow in the sequence diagram or a class opens that file at that line in the editor.
3. To comment, select lines in the editor and use the plus in the gutter.
   - **Comment locally** saves to `.stories/comments.json` for your agent.
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

The skill includes two scripts the agent runs with Node:

- `scripts/validate.mjs` checks `stories.json`: structure, that every quoted line matches the file
  at that line number, and that every changed file is in a story or listed as "not in a story".
- `scripts/comments.mjs` lists waiting comments and records replies.

The file formats are documented in `skill/code-stories/references/schema.md`.

## Notes

- `.stories/` is review state for your working copy. Add it to `.gitignore` unless you want to
  share the stories with the PR.
- Lines are found by their text as well as their number, so the editor and comment threads follow
  code that has moved a little. If `HEAD` no longer matches the commit the stories were written
  for, the panel says so.
