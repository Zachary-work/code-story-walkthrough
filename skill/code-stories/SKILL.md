---
name: code-stories
description: Write and maintain code stories for the Code Story Walkthrough VS Code extension, and answer the reviewer's comments from it. Use when the user asks to create, generate or refresh stories for a branch, pull request or diff ("create code stories for this branch", "turn this PR into stories"), or to read, address or reply to their review comments ("read and address my review comments"), or mentions .stories/stories.json or .stories/comments.json.
---

# Code stories

The Code Story Walkthrough extension lets a person review a change as a set of stories. A story
starts at an entry point (a route, an event handler, a command) and follows the calls down to the
code that changed, so the reviewer reads the change in the order it runs instead of file by file.

You have two jobs, both done by reading and writing files in `.stories/` at the workspace root:

| The user asks to... | You do | File |
| --- | --- | --- |
| create or refresh stories | [Write stories](#write-stories) | `.stories/stories.json` |
| read or address review comments | [Address comments](#address-comments) | `.stories/comments.json` |

The exact file formats are in `references/schema.md`. Read it before writing either file.
The scripts are in this skill's `scripts/` directory; run them with `node` from the workspace root.

## Write stories

1. **Find the change.** Use the base the user names. Otherwise use the PR's base branch
   (`gh pr view --json baseRefName`), otherwise `main` or `master`. Compare from the merge base:
   `git merge-base <base> HEAD`, then `git diff <merge-base>` (this includes uncommitted work).
   Record `base`, `head`, `baseSha` (the merge base) and `headSha` (`git rev-parse HEAD`).

2. **Read the changed code, and its callers.** For each changed function, find what calls it and
   keep going up until you reach an entry point: an HTTP route, a message or event handler, a CLI
   command, a scheduled job, a UI event handler, or a public API of a library. Read the real
   files. Do not guess call paths from names.

3. **Group the change into stories.** One story is one behaviour a user or caller would notice,
   with one entry point and one call path. Write its `goal` as the outcome, in plain language
   ("A shopper can enter a promo code at checkout and see the discounted total before paying"),
   not as a description of the code. A typical PR has two to six stories. A changed method may
   appear in more than one story when two paths run through it.

4. **Write the steps.** Each step is one method on the path, in call order, starting with the
   entry point.
   - Include unchanged methods that sit between the entry point and the change. Show only a few
     lines of them: the signature if it helps, and the line that makes the next call, marked
     `call`.
   - For changed methods, show the added lines (`add`), the removed lines (`del`), and enough
     `context` lines to read them. This is an excerpt, not the whole method.
   - `text` must be copied from the file as it is now, for every line except `del` lines. Leading
     indentation may be trimmed. Line numbers are 1-based and refer to the current file.
   - Set `focusLine` to the line the editor should land on: the first changed line, or the
     `call` line in an unchanged step.
   - Give changed steps a one-sentence `summary` of what the change does there.

5. **Add a sample to each step.** A sample is a concrete input and output for that method, so
   the reviewer can see real values move through the path. Use the same scenario in every step
   of a story so the values line up.
   - Prefer values from an existing test. Set `source` to `"test"` and name the test in `test`.
   - If no test covers it, derive values from the types and the upstream samples, set `source`
     to `"generated"`, and say so in `note`. Never name a test that does not exist.

6. **Account for everything else.** Changed files that do not affect behaviour (formatting,
   dependency bumps, renames, generated files) go in `unstoried.files` with a short reason.
   Every changed file must be in a story or in `unstoried`, so nothing in the change goes unseen.

7. **Validate, then fix.** Run `node <skill>/scripts/validate.mjs`. It checks the structure, that
   every line's text matches the file at that line number, and that every changed file is
   accounted for. Fix every error and re-run until it passes. Treat warnings as things to look at.

8. **Tell the user** how many stories you wrote and to run "Code Stories: Open Story Panel" in
   VS Code. If `.stories/` is not ignored by git, mention that they may want to add it to
   `.gitignore`.

When refreshing existing stories after the code changed, keep story and step `id`s stable where
the story is still the same one. The extension forgets a story's "reviewed" mark only when that
story's content changes.

## Address comments

The reviewer leaves comments in the editor. Local comments are saved to `.stories/comments.json`
for you. Your reply appears in the same thread in their editor as soon as you write it.

1. **List what is waiting.** Run `node <skill>/scripts/comments.mjs list`. It prints each local,
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
   `.stories/stories.json` may now be wrong. Update the affected steps (and `headSha` if you
   committed), then run `node <skill>/scripts/validate.mjs` until it passes.

5. **Summarise for the user**: how many comments you changed, declined and answered, and
   anything they need to decide.
