# Batch image download (gallery scraper)

```webbrain-skill
{
  "summary": "Download many images from a gallery or image page in batches into the working directory, without re-asking for each file.",
  "modes": ["act"],
  "intents": ["batch_image_download", "bulk_image_save", "gallery_download", "save_all_images"]
}
```

Use this skill when the user asks to download images from a page in bulk — "把这个页面里的图都下载下来", "把相册前 50 张保存到本地", "download all images from this gallery", and similar. It turns a long, repetitive download job into one paced, tracked run.

## Where files land (read this first)

- **If the `[WORKING DIRECTORY]` note is present in your system prompt**, the user has granted a local working directory, and it is THE destination for these downloads. Every batch goes through the `workspace_download` tool, which writes the bytes straight into that directory. NEVER use `download_files` (the browser Downloads folder) for an image batch while a working directory exists — it is blocked by the runtime anyway.
- **Default subfolder**: create a NEW subfolder inside the working directory for the job, named after the page title (sanitize it: strip characters that are invalid in file names, collapse spaces, trim to a reasonable length). You may confirm this name with the user in one short line — but if the user simply said "download the images" without naming a folder, do not stop and wait for confirmation: use the page-title name and proceed.
- **If no `[WORKING DIRECTORY]` note is present**, do not ask the user to type or confirm a parent folder path. Tell them once to click the folder button in the WebBrain side panel header to pick the folder, then proceed with `workspace_download`. Only if the user explicitly refuses to pick a folder may you fall back to `download_files` (which lands in the browser's download directory).

## Default behavior: pattern first — never scroll the whole page

When the user says "download the images on this page", they mean get the images, not watch you scroll through every item. Follow this order every time:

1. Extract once with `extract_data` (or `get_accessibility_tree` / `read_page` if unavailable).
2. Inspect a handful of the discovered URLs and look for the naming pattern — most galleries are `xxx-1.jpg` … `xxx-48.jpg`, `page-01.png` …, or an index inside the path.
3. As soon as a pattern covers most of the images, stop investigating: verify one or two sample indices (one from the middle, the last one), generate the complete URL list from the pattern, and hand it to `workspace_download` in ONE call.
4. Scroll further ONLY when the gallery clearly lazy-loads on scroll or the pattern breaks. Never scroll to "confirm" images the pattern already covers — that burns steps and changes nothing.

## Workflow

1. **Scope.** Ask `clarify` only when the scope is genuinely unknown (which gallery, how many, what to name the folder). For small galleries (≤ 20 images) just start. Default folder name = page title.
2. **Discover image URLs.**
   - Prefer `extract_data` with a schema that collects all `img`/`a[href]`/`meta[property="og:image"]` URL candidates. Fall back to `get_accessibility_tree` / `read_page` when `extract_data` is unavailable or returns nothing.
   - Resolve every candidate to an absolute URL. When `srcset` exists, pick the largest listed size. Prefer full-resolution URLs over thumbnails (strip `_thumb`, `-300x200`, `w=...` style suffixes only when the original URL is verifiable — when in doubt keep the URL as found).
   - Follow the pattern-first rule above: find the naming pattern from the first pass and generate the whole list instead of extracting every image individually.
3. **Handle lazy/infinite galleries (the only reason to scroll).** If a pass yields few URLs and the page visibly lazy-loads, use `scroll` + `wait_for_stable`, then extract again and append only URLs you have not seen. Stop as soon as a pattern emerges, after one full pass yields no new URLs, or when the agreed count is reached.
4. **Download in batches.** `workspace_download` accepts at most 3 concurrent / 50 total URLs per call, plus a `subfolder` that is created on demand. Send ≤ 50 URLs per call with `subfolder: '<page-title>'`, then continue with the next batch. Use the `urls` array form (never one call per image).
5. **Track progress.** After each batch, record the running count and the last processed index/URL in your scratchpad (`scratchpad_write`, one line per fact). Re-read your scratchpad before each new batch so a long run survives context compaction.
6. **Verify and retry.** After the run, verify with `workspace_list({ path: '<subfolder>' })` that the expected number of files landed in the working directory. Retry a failed URL once; after that mark it `failed` and move on — do not loop on the same URL.
7. **Report.** Finish with a short summary: how many images were downloaded, into which subfolder of the working directory, and how many failed and why (403/404/timeout).

## Rules

- The working directory is the destination — every image batch goes through `workspace_download` INTO it. Never claim the browser cannot write to local disk: `workspace_download` fetches the bytes and writes them directly into the working directory.
- **Pattern first.** Find the URL naming pattern from the first extraction pass, then batch-generate the full list. Do not scroll through and screenshot every image to "verify" it — one middle + one last sample is enough proof that the pattern holds.
- Only download images the user asked for from the page they pointed at. Do not crawl to other domains or follow pagination beyond the same gallery unless the user said so.
- Do not ask the user whether the site or image type is "supported" before trying — extract, download, and report what actually succeeded or failed.
- Do not download obvious non-image resources (scripts, stylesheets, HTML pages) even when the selector matches them — filter by extension, MIME hints, or `img`/`picture` context.
- Deduplicate by final absolute URL before downloading; keep the first occurrence.
- Skip data/blob URLs unless `download_resource_from_page` is available for that element; prefer the element selector tool for blob-backed viewers.
- If a site returns 401/403 for most files, stop after the first batch and tell the user the site blocks direct downloads — do not burn through the whole list.
- Never invent URLs. If extraction finds nothing, read the page structure once more, then report what you found instead of guessing.
- Local downloads are fast and invisible to the user; a short summary at the end is enough — do not narrate every file.
