# Evidence check

You check that each evidence file shows what its log line says. `<evidence directory>` is the folder that holds this file.

1. Your `Evidence log:` line names the logs you check, comma-separated, in the run folder. Check them one at a time, each by these steps. A log's check file is `check-<session id>.jsonl` for `evidence-<session id>.jsonl`, and `evidence-check.jsonl` for `evidence.jsonl`. Empty it if it exists from an earlier check. Never read the log itself: run `node '<evidence directory>/scripts/listing.mjs' '<run folder>' <log>` once. It prints each line with a `file`, and under each text file its first 1500 characters.
2. For each line in the listing, one row, a raw text file too (a console, a network log, a response saved with a bug): a raw file whose note claims nothing beyond what it is gets `matches` with why `raw capture`. A line with no row is reported as not checked, and a checker is sent again for it.
   - A file that is missing: write no row for it; the report names it. A text file: judge it from the listing. Read the file only when the listing says it was cut. A picture or GIF: open `<run folder>/<file>` with your tool that shows an image file, up to five pictures in one message (each call is paid for with everything opened so far), then write their rows in one call. If that does not show its frames, and for a video, use ffmpeg only if `ffmpeg -version` runs: `ffmpeg -i '<file>' -vf fps=1 '<temp folder>/f-%03d.png'`, with a temp folder from `mktemp -d`. If you cannot view the file, write `unclear` with `why` `cannot view <ext>`.
   - Read the line's `note` and, when the listing gives one, the case's `expect`. Also compare it with each line in the listing with `role` `raw` and the same claim and case, or the same bug.
   - Pick the verdict:
     - `matches`: the file shows what the note says, and agrees with the raw file. `<redacted>` in a log line, note or text file agrees with any value in that place.
     - `mismatch`: it shows something else. For example, the screenshot shows the state before the click finished, the picture says "Sent" and the raw response is a 500, or the note says no message showed and a frame shows one.
     - `not-shown`: a value or state that `expect` (with no `expect`, the note) names is nowhere in the file: off screen, in another tab or window, or after the recording ends. It proves nothing, and puts no doubt on the case's other files. A note value `expect` does not ask for that the file does not show: name it in `why`, and it does not change the verdict.
     - `unclear`: it is in the file, but you cannot read it (too small, blurred). A note that claims text a bubble, dialog or banner covers is `mismatch`.
   - A text file (`raw` or `measure`) of a claim's case that shows a value its `expect` names, where that value is one no screen shows (a status code, a stored value, an email, a size in px): add `"proves": true` to its `matches` row. Never for what a person sees on the page: that stays the picture's to show.
   - Write rows with `node '<evidence directory>/scripts/log.mjs' '<run folder>' <check file> '<row>' ['<row>' ...]`, several rows per call. Give `file` as the listing has it; the script adds its `sha256`:
     ```json
     {"file": "evidence/C5-c.gif", "verdict": "matches", "why": "last frame shows \"Daily invite limit reached.\""}
     ```
3. Never edit, recapture, rename or delete evidence, and never edit an evidence log. Write each file's row once: `log.mjs` refuses a second. Write nothing in the run folder except your check file.
4. Never judge whether the app is right. An error on screen that the note names is `matches`.
5. In `why`, never copy a password, token, cookie, key or account email from a file: name what it is instead ("the raw body has the full address").

Return at most 10 lines: each `mismatch` and `not-shown` with its file and why. If there is none, say so.
