# File formats

Both files live in `.stories/` at the workspace root. All paths are relative to the workspace
root and use forward slashes. All line numbers are 1-based.

## .stories/stories.json

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
      "steps": [
        {
          "id": "controller",
          "name": "CheckoutController.quote",
          "file": "src/api/CheckoutController.java",
          "focusLine": 29,
          "changed": false,
          "lines": [
            { "line": 28, "kind": "context", "text": "public QuoteResponse quote(@RequestBody QuoteRequest request) {" },
            { "line": 29, "kind": "call", "text": "Quote quote = checkoutService.buildQuote(request);" },
            { "line": 30, "kind": "context", "text": "return QuoteResponse.from(quote);" }
          ],
          "sample": {
            "source": "test",
            "test": "CheckoutControllerIT.quoteWithPromo",
            "input": "POST /api/checkout/quote\n{ \"cartId\": \"c_8841\", \"promoCode\": \"SPRING15\" }",
            "output": "200 OK\n{ \"subtotal\": \"120.00\", \"discount\": \"18.00\", \"total\": \"110.16\" }",
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
            { "line": 53, "kind": "context", "text": "Money discount = loyaltyDiscount(ctx.customer(), subtotal);" },
            { "line": 54, "kind": "add", "text": "Promo promo = ctx.promo();" },
            { "line": 55, "kind": "add", "text": "if (promo != null) {" },
            { "line": 56, "kind": "add", "text": "    discount = discount.plus(promo.percentOff().of(subtotal));" },
            { "line": 57, "kind": "add", "text": "}" },
            { "line": null, "at": 58, "kind": "del", "text": "return discount;" },
            { "line": 58, "kind": "add", "text": "return discount.min(subtotal);" }
          ],
          "sample": {
            "source": "generated",
            "input": "subtotal = 120.00 CAD\nctx.promo = Promo { percentOff: 15 }",
            "output": "Money 18.00 CAD",
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
| `base`, `head` | recommended | Branch names, shown as "head compared with base". |
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
| `steps` | yes | One per method, in call order, entry point first. |

### Step

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique within the story. |
| `name` | yes | `Class.method`, `module.function` or `function`. Shown as the step title. |
| `file` | yes | File that holds the method. |
| `focusLine` | yes | Line the editor lands on. |
| `changed` | yes | `true` if this change touches the method. |
| `additions`, `deletions` | if changed | Line counts for this method. Default to the number of `add` and `del` lines. |
| `summary` | if changed | One sentence on what the change does here. |
| `lines` | yes | The excerpt to show. See below. |
| `sample` | recommended | `{ source, test?, input, output, note? }`. `source` is `"test"` or `"generated"`. `input` and `output` are plain text; use `\n` for line breaks. |
| `participant` | optional | Box in the sequence diagram. Defaults to `name` up to the last dot. |
| `call` | optional | Arrow label. Defaults to the method name plus `()`. |
| `calledFrom` | optional | `id` of the calling step when it is not the previous one, for a path that branches. |

### Line

| `kind` | `line` | Meaning |
| --- | --- | --- |
| `context` | number | Unchanged line shown for reading. |
| `add` | number | Line added or modified by this change. |
| `call` | number | Unchanged line that calls the next step. |
| `del` | `null` | Line removed by this change. Set `at` to the current line it sat just before. |

`text` is the line as it is in the file now (for `del`, as it was), with leading indentation
optionally trimmed. Keep relative indentation inside a block so the excerpt reads as code.

## .stories/comments.json

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
