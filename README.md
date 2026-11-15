# Code Story Walkthrough

Review a change as stories instead of file by file. Each story starts at an entry point (a route,
an event handler, a command) and follows the calls down to the code that changed.

Two parts work together through files in `.stories/`:

- **The editor plugin**, for VS Code or IntelliJ, shows the stories in a panel beside the editor,
  keeps the editor on the step you are reading, and lets you leave review comments in the gutter.
  Both editors read the same files, so a team can mix them on one review.
- **The `code-stories` agent skill** (in `skill/code-stories/`) teaches an AI agent such as Claude
  Code to write the stories from a diff and to answer your comments.

## How it flows

1. Ask your agent: **"Create code stories for this branch"**. It writes the stories into a folder
   of their own, `.stories/<branch>/stories.json`. Ask again after more work on the same branch and
   it refreshes that same set; work on another branch gets another set (see [Story sets](#story-sets)).
2. Run **Code Stories: Open Story Panel**. The overview has four counters, and each one is a tab:
   - **Stories reviewed** lists the stories, with what each one still needs from you.
   - **Lines not seen** accounts for every changed line: how many a story shows, how many are in
     the stories' tests, how many are in files left out with a reason, and which ones are shown
     nowhere. Click a file to see those lines in the diff.
   - **Tests** lists the tests each story names, and the stories that have none.
   - **Comments** holds your review threads and the pull request link.

   Open a story and step through it. Its tabs are **Steps** (one function at a time, the others
   folded to a line), **Look closely** (what the agent was least sure about), **Tests**,
   **Diagram** and **Comments**. Clicking a line opens that file at that line in the editor.
   A step tells you when its code no longer matches the file, when its excerpt leaves out
   changed lines, when it has no test, and when it shows code the change removed.
3. To comment, select lines in the editor and use the plus in the gutter.
   - **Comment locally** saves to `comments.json` next to the stories, for your agent.
   - **Comment on PR** posts a review comment to the linked GitHub pull request (needs the
     [`gh` CLI](https://cli.github.com), signed in).
4. Ask your agent: **"Read and address my review comments"**. It replies in each thread and either
   makes the change, declines with a reason, or answers the question. The thread updates in place.
5. Mark each story reviewed. If a story changes afterwards, for example because the agent fixed
   something you commented on, it shows as **Changed since review**: the steps that changed are
   marked, and the lines you have not read carry a bar. Code that only moved does not count.
6. **Copy review summary** on the overview gives you the state of the review as text.

## Try it

```
npm install
npm run compile
```

Press F5 in VS Code ("Run Extension (example workspace)"). It opens `example/`, which has two
stories and two comments. Run **Code Stories: Open Story Panel**.

To build an installable `.vsix`: `npm run package`.

## IntelliJ

The plugin in `intellij/` works in IntelliJ-based IDEs, 2026.3 or later. It needs Node.js on your
PATH, because it runs the same review logic as the VS Code extension.

```
npm install
npm run compile
cd intellij
gradlew buildPlugin
```

Gradle needs Java 25. To build against an IDE you already have instead of downloading one, add
`-PlocalIde="<path to the IDE>"`. Install `intellij/build/distributions/code-story-walkthrough-<version>.zip`
with **Settings > Plugins > gear icon > Install Plugin from Disk**.

- The **Code Stories** tool window, on the right, is the story panel.
- **Tools > Code Stories** has Open Story Panel, Next Step, Previous Step and Add Review Comment.
- To comment, select lines, right-click and choose **Add Review Comment (Code Stories)**. A
  thread shows as a speech-bubble icon in the gutter; click it to read, reply or resolve.

## How the code is shared

| Part | Where | Used by |
| --- | --- | --- |
| Review logic: story sets, reviewed marks, line coverage, comments, git | `src/core/` (no editor imports) | both |
| Panel UI | `media/panel.js`, `media/panel.css` | both |
| Agent skill and its scripts | `skill/code-stories/` | both |
| VS Code layer: webview host, editor, comment threads, commands | `src/*.ts` | VS Code |
| IntelliJ layer: tool window, editor, gutter comments, actions | `intellij/src/` | IntelliJ |

VS Code loads the core directly. IntelliJ runs it as a background Node process
(`src/core/server.ts`) and exchanges one JSON message per line with it; the header of that file
lists the messages.

## Install the skill

Run **Code Stories: Install Agent Skill** and choose where it goes (`.claude/skills` in the
workspace, `.agents/skills`, or `~/.claude/skills`). Or copy `skill/code-stories/` there yourself.

The skill includes three scripts the agent runs with Node:

- `scripts/sets.mjs` lists the story sets and prints the folder a set is written to.
- `scripts/validate.mjs` checks `stories.json` against the working tree and `git diff`: structure,
  that every quoted line matches the file at that line number, that no changed line is passed
  off as unchanged, that the tests it names exist, and that every changed file is in a story or
  left out with a reason. It reports how many changed lines the steps show.
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
