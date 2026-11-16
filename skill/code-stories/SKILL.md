---
name: code-stories
description: Write and maintain code stories for the Code Story Walkthrough VS Code extension, and answer the reviewer's comments from it. Use when the user asks to create, generate or refresh stories for a branch, pull request or diff ("create code stories for this branch", "turn this PR into stories"), or to read, address or reply to their review comments ("read and address my review comments"), or mentions story sets, .stories/, stories.json or comments.json.
---

# Code stories

The Code Story Walkthrough extension lets a person review a change as a set of stories. A story
starts at an entry point (a route, an event handler, a command) and follows the calls down to the
code that changed, so the reviewer reads the change in the order it runs instead of file by file.

You have two jobs, both done by reading and writing files in `.stories/` at the workspace root.
Each change has its own folder there, called a story set, so stories for unrelated changes never
overwrite each other:

| The user asks to... | You do | File |
| --- | --- | --- |
| create or refresh stories | [Write stories](#write-stories) | `.stories/<set>/stories.json` |
| read or address review comments | [Address comments](#address-comments) | `.stories/<set>/comments.json` |

The exact file formats are in `references/schema.md`. Read it before writing either file.
The scripts are in this skill's `scripts/` directory; run them with `node` from the workspace root.

## Choose the story set

Do this first, before writing stories. Run `node <skill>/scripts/sets.mjs list`. It prints the
current branch and every existing set with its title, the branch it was written on, and the
files its stories cover.

- **The user names a set** ("refresh the promo-codes stories", "create stories called
  checkout-refactor"): use that one. `node <skill>/scripts/sets.mjs path <name>` prints its folder.
- **On a feature branch:** the set is named after the branch, and `sets.mjs path` prints its
  folder. If it exists, this is follow-up work: refresh it in place. If it does not, create it.
- **On the default branch** (`main`, `master`), unrelated changes follow each other on one
  branch, so the branch cannot name the set. Name it after the change instead, in kebab-case
  (`sets.mjs path promo-codes`). When sets written on this branch already exist:
  - Refresh an existing set if the user says this is a follow-up, or if the work clearly
    continues it: the same feature, and the changed files overlap the files that set covers.
  - Create a new set if the change is clearly something else.
  - If you cannot tell, ask the user: "Is this a follow-up to <title>, or a new change?" Do not
    guess. A wrong guess overwrites stories they may still be reviewing.
- **Never** write to another change's set, and do not use the name `default`. A
  `.stories/stories.json` directly in `.stories/` is the old single-file layout: treat it as the
  set called `default`, and refresh it only if the user asks for that.

Refreshing a set means rewriting its `stories.json` for the change as it is now, keeping story
and step `id`s where the story is still the same one, and leaving its `comments.json` alone.

## Write stories

1. **Find the change.** Use the base the user names. Otherwise use the PR's base branch
   (`gh pr view --json baseRefName`), otherwise `main` or `master`. Compare from the merge base:
   `git merge-base <base> HEAD`, then `git diff <merge-base>` (this includes uncommitted work).
   Record `base`, `head`, `baseSha` (the merge base) and `headSha` (`git rev-parse HEAD`).
   `head` must be the current branch name exactly (`git branch --show-current`): the extension
   uses it to show this set when that branch is checked out.

2. **Read the changed code, and its callers.** For each changed function, find what calls it and
   keep going up until you reach an entry point: an HTTP route, a message or event handler, a CLI
   command, a scheduled job, a UI event handler, or a public API of a library. Read the real
   files. Do not guess call paths from names.

3. **Group the change into stories.** One story is one behaviour a user or caller would notice,
   with one entry point and one call path. Write its `goal` as the outcome, in plain language
   ("A shopper can enter a promo code at checkout and see the discounted total before paying"),
   not as a description of the code. A typical PR has two to six stories. A changed method may
   appear in more than one story when two paths run through it.

4. **Write the steps.** Each step is exactly one unit of code on the path, in call order,
   starting with the entry point. A reviewer reads a step as "this function, and what changed in
   it", so a step must never mix lines from two units.
   - The unit is whatever the language calls one callable: a function, a method, a constructor,
     a getter or setter, a closure or callback (an event handler, a route handler passed inline),
     a SQL procedure, a template or component. For a script with code at the top level, the unit
     is one contiguous block that does one thing.
   - Every line of a step lies inside that one unit. If you want to show lines from a second
     function, that is a second step.
   - A call inside the same class or file is still a call. When `Cart.total` calls
     `Cart.applyDiscount`, write two steps, the second one called from the first. Do not fold
     the callee's lines into the caller's step. The diagram draws it as a call from the class
     to itself.
   - A callback defined inline inside another function is its own unit once it does real work.
     The outer function's step shows where the callback is registered; the callback's step shows
     its body. Name it for what it handles (`showUnstoried handler`, `onSave callback`).
   - Name the step after the unit: `Class.method`, `module.function`, or a short label for a
     callback or a top-level block (`validate.mjs: changed-file check`).
   - If two changed functions are not on the same call path, they do not share a step, and
     usually not a story either.
   - Include unchanged methods that sit between the entry point and the change. Show only a few
     lines of them: the signature, and the line that makes the next call, marked
     `call`.
   - For changed methods, show every added or modified line (`add`), the removed lines (`del`),
     and enough `context` lines to read them. Unchanged stretches may be left out; changed lines
     may not. A changed line that no step shows is outside every story, and the panel reports it
     to the reviewer as "not seen". If a changed function is on no story's path, it needs a
     story of its own.
   - The kind of each line must agree with the diff. A line that is new or modified in this
     change is `add`, even when it is the function's signature or the line that calls the next
     step. For an added line that makes the next call, write `"kind": "add", "calls": true`.
     `context` and `call` are only for lines the change did not touch. The validator checks
     this against `git diff`.
   - A function the change deleted is a step too, when removing it changes the behaviour the
     story is about. Set `"removed": true` and `"changed": true`, give `file` as the path it
     had, and make every line `{ "line": null, "was": <line number in the base version>,
     "kind": "del", "text": ... }`, opening with its signature. Read it with
     `git show <merge-base>:<path>`.
   - Every step opens with the signature of its unit, changed or not: the line that declares
     the function, method, constructor or getter, or the line that defines the callback
     (`router.post('/quote', async (req, res) => {`). Mark it `context` when it did not change.
     Only the unit's own doc comment or decorators may come before it, and only when they
     changed. If the signature spans several lines, show all of them. A top-level block has no
     signature; open with its first line.
   - The panel marks every place where the excerpt leaves lines out ("12 lines not shown"), so
     the reader does not take two separate blocks for one. Keep each block readable on its own,
     and do not skip just one or two lines: include them as `context` instead.
   - `text` must be copied from the file as it is now, for every line except `del` lines. Copy
     the whole line, with its leading whitespace. Never trim the indentation: without it the
     panel shows the body of an `if` or a loop flush with the line above, and the code is hard
     to read. `del` lines keep the indentation they had too. The validator rejects a step whose
     lines lost their indentation. Line numbers are 1-based and refer to the current file.
   - Set `focusLine` to the line the editor should land on: the first changed line, or the
     `call` line in an unchanged step.
   - Give changed steps a one-sentence `summary` of what the change does there.

5. **Add a sample to each step.** A sample is a concrete input and output for that method, so
   the reviewer can see real values move through the path. Use the same scenario in every step
   of a story so the values line up.
   - `input` and `output` are JSON with actual values. Each is a string that holds JSON,
     formatted with two-space indentation (`JSON.stringify(value, null, 2)`).
     - `input` is a JSON object. For a function, it has one key per parameter, by name:
       `{ "code": "SPRING15", "subtotal": 120 }`. For an HTTP entry point, it is the request:
       `{ "method": "POST", "path": "/api/checkout/quote", "body": { "cartId": "c_8841" } }`.
       For an event or a command, it is the payload or the arguments.
     - `output` is what the function returns, as JSON. For an HTTP entry point:
       `{ "status": 200, "body": { ... } }` with the real body. When the function returns
       nothing, give what it changed: `{ "saved": { "code": "SPRING15", "uses": 1 } }`. When it
       throws in this scenario: `{ "throws": { "type": "PromoExpiredError", "message": "SPRING15 ended on 2025-06-30" } }`.
     - Write every value out. Do not describe a value: not "non-empty summary", "mocked
       object", "a valid cart", "..." or `<Cart>`. Give the summary text, the fields of the
       object, the cart with its items. For a mock, give the data it returns in this scenario.
     - Give an object by its data fields. Leave out fields that do not matter to this step
       instead of abbreviating them; a field you show has its real value.
   - Prefer values from an existing test. Set `source` to `"test"` and name the test in `test`.
   - If no test covers it, derive values from the types and the upstream samples, set `source`
     to `"generated"`, and say so in `note`. Never name a test that does not exist. Generated
     values are still concrete: pick realistic ones and keep them the same down the path.
   - Explanations go in `note`, not in `input` or `output`.

6. **Name the tests, and say where to look closely.** Both go on the story.
   - `tests`: the tests that exercise this story, each with `name`, `file`, `line` and `steps`
     (the ids of the steps it covers). Find them by searching the test files for calls into the
     story's functions. Include tests the change added and existing ones that still cover the
     path. List only tests that exist. If a story has none, leave `tests` empty: the panel
     tells the reviewer the story is untested, which is what they need to know.
   - Test files that the change touched and that you list here do not go in `unstoried`; a test
     file no story names does, with its reason.
   - `risks`: zero to three things per story that deserve a careful look, each `{ "text",
     "step" }` pointing at the step it is about. Write what you were least sure of: an edge
     case that is not handled, behaviour the request did not specify, a race, a migration that
     cannot be undone, a changed default. One or two plain sentences, stating the concern, not
     reassurance. Leave it empty when there is nothing; do not invent concerns.

7. **Account for everything else.** List the changed files (`git diff --name-only <merge-base>`,
   plus untracked files from `git status`). Every one must be in a story or in
   `unstoried.files`, so nothing in the change goes unseen. The panel shows the unstoried files
   in their own section, grouped by `reason`, and flags any changed file you left out of both.
   - A file belongs in `unstoried` when it is on no story's call path: formatting, dependency
     bumps, renames, generated files, configuration, documentation, assets, fixtures.
   - `reason` is required. It answers "why is this not in a story?" in one short sentence, not
     "what is this file?". Write "Lockfile regenerated by the dependency bump; no code reads
     it", not "Lockfile".
   - Give files that are left out for the same reason the exact same `reason` text, so the
     panel shows them as one group.
   - If a file does change behaviour, it does not belong here. Put it in a story, or write a
     new story for it.
   - `unstoried.summary` is one sentence describing these files as a whole.

8. **Validate, then fix.** Run `node <skill>/scripts/validate.mjs` (add `--set <name>` when the
   set is not named after the branch). It prints which set it checked. It checks the structure,
   that every line's text matches the file at that line number, that each line's kind agrees
   with the diff, that the tests you named exist, and that every changed file is accounted for.
   It also prints how many changed lines the steps show and warns about each file with changed
   lines in no step. Fix every error and re-run until it passes. Treat warnings as work to do:
   aim for every changed line of a storied file to be shown.

9. **Tell the user** how many stories you wrote, which set they are in and whether you created
   or refreshed it, and to run "Code Stories: Open Story Panel" in VS Code. If `.stories/` is not ignored by git, mention that they may want to add it to
   `.gitignore`.

When refreshing existing stories after the code changed, keep story and step `id`s stable where
the story is still the same one. The extension forgets a story's "reviewed" mark only when that
story's content changes.

## Address comments

The reviewer leaves comments in the editor. Local comments are saved to `comments.json` in the
story set they were reading, for you. Your reply appears in the same thread in their editor as
soon as you write it.

1. **List what is waiting.** Run `node <skill>/scripts/comments.mjs list`. It works on the set
   that belongs to the current branch and says which one; add `--set <name>` (to `list` and to
   `reply`) for another set. It prints each local,
   unresolved comment whose status is `waiting`, with the file, the lines, the code there now and
   the whole thread. Only these are yours. Leave comments with `"source": "pr"` alone: they belong
   to the pull request on GitHub.

2. **Handle each comment on its merits.** Read the code it points at and the last message in the
   thread, then pick one outcome:
   - `changed`: the comment asks for a change and it is right. Make the change, run the relevant
     tests, and reply with what you changed and where.
   - `declined`: you are not making the change. Reply with the reason, pointing at the code or
     the story goal that supports it. Declining with a clear reason is a good answer; do not
     make a change you believe is wrong just because it was asked for.
   - `answered`: the comment is a question and needs no change. Answer it, citing file and line.

   If a comment is ambiguous, reply with your question and use `answered`; the reviewer's next
   reply sets it back to `waiting`.

3. **Reply through the script**, one comment at a time:
   `node <skill>/scripts/comments.mjs reply <id> <changed|declined|answered> "<your reply>"`.
   Pass `-` instead of the text to read a long reply from stdin. Keep replies short and specific:
   two or three sentences, naming the file, line or test. Do not set `resolved`; resolving a
   thread is the reviewer's call.

4. **Keep the stories true.** If you changed code, line numbers and excerpts in
   that set's `stories.json` may now be wrong. Update the affected steps (and `headSha` if you
   committed), then run `node <skill>/scripts/validate.mjs` until it passes.

5. **Summarise for the user**: how many comments you changed, declined and answered, and
   anything they need to decide.
