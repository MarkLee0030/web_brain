# Batch image download (gallery scraper)

```webbrain-skill
{
  "summary": "Download many images from a gallery or image page to the user's download directory, in batches, without re-asking for each file.",
  "modes": ["act"],
  "intents": ["batch_image_download", "bulk_image_save", "gallery_download", "save_all_images"]
}
```

Use this skill when the user asks to download images from a page in bulk — "把这个页面里的图都下载下来", "把相册前 50 张保存到本地", "download all images from this gallery", and similar. It turns a long, repetitive download job into one paced, tracked run.

## Where files land

Files are saved through the `download_files` tool into the browser's download location:

- If the user set **Settings → Display → Download directory**, files go into that folder (relative folders sit inside the browser/OS Downloads folder; absolute paths like `D:/images` are used as-is). The folder must already exist.
- Otherwise files land in the default Downloads folder.
- Confirm the target location with the user once at the start when it matters. Never move files afterwards yourself — if the user needs a different final location, ask them to set the download directory first, then start the run.

## Workflow

1. **Scope first.** Ask `clarify` only when the scope is genuinely unknown: which page/gallery, roughly how many images, and the target folder. For small galleries (≤ 20 images) just start. For large ones (> 50), state the expected count and continue unless the user set a different limit.
2. **Discover image URLs.**
   - Prefer `extract_data` with a schema that collects all `img`/`a[href]`/`meta[property="og:image"]` URL candidates.
   - Fall back to `get_accessibility_tree` / `read_page` when `extract_data` is unavailable or returns nothing.
   - Resolve every candidate to an absolute URL. When `srcset` exists, pick the largest listed size. Prefer full-resolution URLs over thumbnails (strip `_thumb`, `-300x200`, `w=...` style suffixes only when the original URL is verifiable — when in doubt keep the URL as found).
3. **Handle lazy/infinite galleries.** Many image sites load items on scroll. Between extraction passes, use `scroll` and `wait_for_stable`, then extract again and append only URLs you have not seen. Stop after one full pass yields no new URLs, or when the agreed count is reached.
4. **Download in batches.** `download_files` accepts at most 3 concurrent / 50 total URLs per call. Send ≤ 30 URLs per call, then continue with the next batch. Use the `urls` array form (not one call per image). For a single file that needs a specific name, use the `url` + `filename` form.
5. **Track progress.** After each batch, record the running count and the last processed index/URL in your scratchpad (`scratchpad_write`, one line per fact). For itemized galleries use `progress_update` with one row per image (`processed` / `failed` / `skipped`). Re-read your scratchpad before each new batch so a long run survives context compaction.
6. **Verify and retry.** After each batch, cross-check with `list_downloads` if any result reports failure. Retry a failed URL once; after that mark it `failed` and move on — do not loop on the same URL.
7. **Report.** Finish with a short summary: how many images were downloaded, to which folder, how many failed and why (403/404/timeout), and the download IDs are already in your scratchpad.

## Rules

- Never claim the browser cannot write to local disk. Downloads go through the browser's download system via `download_files` and land in the user's configured download directory — that IS a local disk write. If the user names a specific target folder (for example D:/Photo/XXX), tell them once to set that folder in Settings → Display → Download directory (it must already exist), then proceed with the download; do not dump a URL list and hand the work back to the user.
- Only download images the user asked for from the page they pointed at. Do not crawl to other domains or follow pagination beyond the same gallery unless the user said so.
- Do not ask the user whether the site or image type is "supported" before trying — extract, download, and report what actually succeeded or failed.
- Do not download obvious non-image resources (scripts, stylesheets, HTML pages) even when the selector matches them — filter by extension, MIME hints, or `img`/`picture` context.
- Deduplicate by final absolute URL before downloading; keep the first occurrence.
- Skip data/blob URLs unless `download_resource_from_page` is available for that element; prefer the element selector tool for blob-backed viewers.
- If a site returns 401/403 for most files, stop after the first batch and tell the user the site blocks direct downloads — do not burn through the whole list.
- Never invent URLs. If extraction finds nothing, read the page structure once more, then report what you found instead of guessing.
- Local downloads are fast and invisible to the user; a short summary at the end is enough — do not narrate every file.
