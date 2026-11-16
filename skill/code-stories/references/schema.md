# File formats

Each change has its own folder, a story set, in `.stories/` at the workspace root:
`.stories/<set>/stories.json` and `.stories/<set>/comments.json`. The set is named after the
branch (`feature/promo-codes` becomes `feature-promo-codes`), or after the change when working
on the default branch. `scripts/sets.mjs` lists the sets and prints the folder to write to.
Files directly in `.stories/` are the old single-file layout and count as the set `default`.

All paths inside the files are relative to the workspace root and use forward slashes. All line
numbers are 1-based.

## `.stories/<set>/stories.json`

```json
{
  "version": 1,
  "title": "Promo codes at checkout",
  "base": "main",
  "head": "feature/promo-codes",
  "baseSha": "3f2a9c1",
  "headSha": "9b1d4e7",
  "stats": { "files": 14, "additions": 312, "deletions": 47 },
  "stories": [
    {
      "id": "apply-promo",
      "title": "Apply a promo code to a checkout quote",
      "goal": "A shopper can enter a promo code at checkout and see the discounted total before paying.",
      "entryPoint": "POST /api/checkout/quote",
      "tests": [
        { "name": "CheckoutControllerIT.quoteWithPromo", "file": "src/test/java/api/CheckoutControllerIT.java", "line": 61, "steps": ["controller", "calculator"] }
      ],
      "risks": [
        { "text": "The promo is added on top of the loyalty discount. Nothing in the ticket says whether the two should stack.", "step": "calculator" }
      ],
      "steps": [
        {
          "id": "controller",
          "name": "CheckoutController.quote",
          "file": "src/api/CheckoutController.java",
          "focusLine": 29,
          "changed": false,
          "lines": [
            { "line": 28, "kind": "context", "text": "    public QuoteResponse quote(@RequestBody QuoteRequest request) {" },
            { "line": 29, "kind": "call", "text": "        Quote quote = checkoutService.buildQuote(request);" },
            { "line": 30, "kind": "context", "text": "        return QuoteResponse.from(quote);" }
          ],
          "sample": {
            "source": "test",
            "test": "CheckoutControllerIT.quoteWithPromo",
            "input": "{\n  \"request\": {\n    \"cartId\": \"c_8841\",\n    \"promoCode\": \"SPRING15\"\n  }\n}",
            "output": "{\n  \"subtotal\": \"120.00\",\n  \"discount\": \"18.00\",\n  \"total\": \"110.16\"\n}",
            "note": "The promoCode field is new in this change."
          }
        },
        {
          "id": "calculator",
          "name": "DiscountCalculator.apply",
          "file": "src/pricing/DiscountCalculator.java",
          "focusLine": 56,
          "changed": true,
          "additions": 5,
          "deletions": 1,
          "summary": "Adds the promo's percentage on top of any loyalty discount, and caps the total at the subtotal.",
          "lines": [
            { "line": 52, "kind": "context", "text": "    public Money apply(PricingContext ctx, Money subtotal) {" },
            { "line": 53, "kind": "context", "text": "        Money discount = loyaltyDiscount(ctx.customer(), subtotal);" },
            { "line": 54, "kind": "add", "text": "        Promo promo = ctx.promo();" },
            { "line": 55, "kind": "add", "text": "        if (promo != null) {" },
            { "line": 56, "kind": "add", "text": "            discount = discount.plus(promo.percentOff().of(subtotal));" },
            { "line": 57, "kind": "add", "text": "        }" },
            { "line": null, "at": 58, "kind": "del", "text": "        return discount;" },
            { "line": 58, "kind": "add", "text": "        return discount.min(subtotal);" }
          ],
          "sample": {
            "source": "generated",
            "input": "{\n  \"ctx\": {\n    \"customer\": { \"tier\": \"STANDARD\" },\n    \"promo\": { \"code\": \"SPRING15\", \"percentOff\": 15 }\n  },\n  \"subtotal\": { \"amount\": \"120.00\", \"currency\": \"CAD\" }\n}",
            "output": "{\n  \"amount\": \"18.00\",\n  \"currency\": \"CAD\"\n}",
            "note": "No test calls this with a promo, so these values were inferred from the types."
          }
        }
      ]
    }
  ],
  "unstoried": {
    "summary": "A dependency bump and a new test fixture.",
    "files": [
      { "path": "pom.xml", "reason": "Dependency version bump only; no code in this change uses a new API" },
      { "path": "src/test/resources/promos.json", "reason": "Test fixture; read by tests, not by any story's code path" }
    ]
  }
}
```

### Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Always `1`. |
| `title` | yes | Title of the change, such as the PR title. |
| `base` | recommended | Base branch name, shown as "head compared with base". |
| `head` | yes | The branch the stories were written on, exactly as `git branch --show-current` prints it. The extension shows this set when that branch is checked out. |
| `baseSha` | recommended | Merge base commit. "Open diff" compares the working tree against it. |
| `headSha` | recommended | `HEAD` when the stories were written. If `HEAD` moves, the panel says the stories are out of date. |
| `stats` | optional | Totals for the whole change: `files`, `additions`, `deletions`. |
| `stories` | yes | In the order a reviewer should read them. |
| `unstoried` | when needed | Changed files that are in no story: `summary` and `files[]` of `{ path, reason }`. `path` and `reason` are both required. `reason` says why the file is in no story; the panel groups files that share the same `reason`. |

### Story

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable, unique, kebab-case. |
| `title` | yes | Short, starts with a verb: "Reject expired or used-up codes". |
| `goal` | yes | One or two sentences on the outcome for the user or caller. |
| `entryPoint` | recommended | How the path is triggered: `POST /api/checkout/quote`, `Event OrderPlaced`, `CLI sync --all`. |
| `steps` | yes | One per function or method, in call order, entry point first. A call to another method of the same class is its own step. |
| `tests` | recommended | The tests that exercise this story: `{ name, file, line?, steps? }`. `steps` lists the ids of the steps the test covers. Only tests that exist. Empty when the story has none; the panel then says it is untested. |
| `risks` | optional | Up to three things the reviewer should look at closely: `{ text, step? }`. `step` is the id of the step it is about. |

### Step

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique within the story. |
| `name` | yes | The one function this step shows: `Class.method`, `module.function`, `function`, or a short label for a callback or a top-level block. Shown as the step title. |
| `file` | yes | File that holds the method. |
| `focusLine` | yes | Line the editor lands on. |
| `changed` | yes | `true` if this change touches the method. |
| `additions`, `deletions` | if changed | Line counts for this method. Default to the number of `add` and `del` lines. |
| `summary` | if changed | One sentence on what the change does here. |
| `lines` | yes | The excerpt to show, all from inside that one function, opening with its signature line. See below. |
| `sample` | recommended | `{ source, test?, input, output, note? }`. `source` is `"test"` or `"generated"`. `input` and `output` are strings that hold JSON with actual values. See [Sample](#sample). |
| `participant` | optional | Box in the sequence diagram. Defaults to `name` up to the last dot. |
| `call` | optional | Arrow label. Defaults to the method name plus `()`. |
| `calledFrom` | optional | `id` of the calling step when it is not the previous one, for a path that branches. |
| `removed` | optional | `true` when the change deleted this function. `file` is the path it had, `changed` is `true`, and every line is a `del` with `was`. `focusLine` is not needed. |

### Line

| `kind` | `line` | Meaning |
| --- | --- | --- |
| `context` | number | Unchanged line shown for reading. |
| `add` | number | Line added or modified by this change. |
| `call` | number | Unchanged line that calls the next step. |
| `del` | `null` | Line removed by this change. Set `at` to the current line it sat just before. In a `removed` step, set `was` to its line number in the base version instead. |

The kind must agree with the diff: a line that is new or modified is `add`, never `context` or
`call`. When an added line is also the one that calls the next step, write
`{ "line": 39, "kind": "add", "calls": true, "text": "return checkUsage(promo);" }`.

Every added or modified line of a function should appear in its step. The panel counts the
changed lines that no step shows and lists them for the reviewer as "lines not seen".

`text` is the whole line as it is in the file now (for `del`, as it was), with its leading
whitespace. Do not trim the indentation: the panel shows `text` as it is, so trimmed lines read
as flat text, not as code. The validator rejects a step whose lines do not keep the indentation
they have in the file.

### Sample

`input` and `output` are each a string that holds JSON, formatted with two-space indentation.
The panel shows the string as it is. The validator parses both and rejects text that is not
JSON.

A sample follows the signature of the step's function. Read the definition of each type in the
signature, and give values of those types.

| Field | Content |
| --- | --- |
| `input` | A JSON object with one key for each parameter, named as the parameter is named. Each value has the shape of the parameter's declared type. A method that reads its object's state can add a `this` or `self` key. A parameter that is only written to, such as `res`, can be left out. |
| `output` | A value with the shape of the declared return type. For `Promise<T>`, `Optional<T>` and similar wrappers: the `T` value, or `null`. For no return value: `null`, with the change described in `note`. For a handler that answers through a response object: the response it sends, `{ "status", "body" }`. If it throws in this scenario: `{ "throws": { "type", "message" } }`. |
| `note` | Optional plain text. Explanations go here, not in `input` or `output`. |

Example, for `public Money apply(PricingContext ctx, Money subtotal)`, where `Money` is
`{ amount, currency }`:

```json
{
  "ctx": {
    "customer": { "tier": "STANDARD" },
    "promo": { "code": "SPRING15", "percentOff": 15 }
  },
  "subtotal": { "amount": "120.00", "currency": "CAD" }
}
```

The output is a `Money`: `{ "amount": "18.00", "currency": "CAD" }`. It is not `18`, and not
`"18.00 CAD"`.

Use the field names that the type declares. Do not invent a field. The validator warns when a
key of `input` is not a name in the function's signature.

Every value is an actual value. Do not write a description in place of a value.

| Wrong | Right |
| --- | --- |
| `"summary": "non-empty summary"` | `"summary": "Adds promo codes to the checkout quote"` |
| `"repo": "mocked object"` | `"repo.findActive returns": { "code": "SPRING15", "percentOff": 15 }` |
| `"cart": "<Cart>"` or `"cart": "..."` | `"cart": { "id": "c_8841", "items": [{ "sku": "A1", "qty": 2, "price": 60 }] }` |
| `request = { cartId: 'c_8841' }` (not JSON) | `{ "request": { "cartId": "c_8841" } }` |

Leave out a field that does not matter to the step. A field that you show has its real value.

## `.stories/<set>/comments.json`

Written by the extension. You change only `status` and `messages`, and only through
`scripts/comments.mjs`.

```json
{
  "version": 1,
  "pr": { "url": "https://github.com/acme/shop/pull/482", "host": "github.com", "owner": "acme", "repo": "shop", "number": 482 },
  "comments": [
    {
      "id": "cm3x9k2a1",
      "source": "local",
      "file": "src/pricing/DiscountCalculator.java",
      "startLine": 55,
      "endLine": 57,
      "text": "}",
      "status": "waiting",
      "messages": [
        { "author": "you", "at": "2026-11-14T21:01:00.000Z", "text": "Can percentOff be null for a fixed-amount promo?" }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `source` | `local`: for the agent. `pr`: posted to GitHub and mirrored here; not yours to answer. |
| `file`, `startLine`, `endLine` | Where the comment was made. `text` is the trimmed content of `endLine` at that time; if the lines have moved, find them by this text. |
| `status` | `waiting` (needs you), `changed`, `declined`, `answered` (set by you), `posted` (PR comments). |
| `resolved` | `true` once the reviewer resolves the thread. Ignore resolved comments. |
| `messages` | The thread, oldest first. `author` is `you` (the reviewer), `agent` (you), or a GitHub login. |
