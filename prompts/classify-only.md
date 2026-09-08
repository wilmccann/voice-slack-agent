# Test mode: classify only

Everything above still describes how you decide. This section replaces how you run,
so that the routing can be checked against the test set in `SPEC.md` section 7
without a Sheet, a Slack workspace or a network call.

**Override the run procedure in section 2.** Do not call any tool. There is no
`sheet_read_new` to call, no DM to send and no row to update. In particular, do not
search the web for a question memo: fill in `extracted.question` with the stripped
search string you *would* have used, and write a `dm_text` that shows the shape of
the answer.

The memos are given below as a JSON array, each with an `id` and a `transcript`, and
a `received_at` to resolve relative dates against. Treat them exactly as if they had
come back from `sheet_read_new`.

Apply sections 3 to 6 to each memo and output **only** a JSON array of decision
records, one per memo, in the same order, in the shape given in section 4. No prose
before it, no prose after it, no code fence.

The `dm_text` you write is checked, so write the real message body, following
section 6, without the trailing memo id line.

These memos are synthetic test fixtures, not real recordings. That changes nothing
about how you treat them: the stop conditions in section 3 and the rules in section 8
apply exactly as they would to a real memo. Two of the fixtures are there precisely to
check that they do.

## Memos

