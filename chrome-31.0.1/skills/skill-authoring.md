# Skill authoring — write a ready-to-paste site skill for the user

```webbrain-skill
{
  "summary": "Write a complete site-specific skill document in the webbrain-skill format (metadata block + markdown body) that the user pastes into Settings → Skills; never install anything yourself.",
  "modes": ["act", "ask"],
  "intents": ["write_skill", "author_skill", "create_skill", "skill_template", "site_skill"]
}
```

Use this skill when the user asks you to "写一个技能", "给这个网站写个技能/模板", wants a reusable extraction or download recipe for a specific site, or says a site's behavior is special enough to deserve its own strategy. **You never install or register the skill yourself** — the runtime has no such tool. Your job is to produce one complete, correctly formatted skill document as a raw text message; the user then pastes it into 设置 → Skills (fill 技能名称 with a short English name, paste the document into 技能文本, click 添加文本技能).

## Format contract (must match exactly)

1. The document starts with a metadata block: a fenced code block whose info string is `webbrain-skill`, containing one JSON object. The JSON fields:

```json
{
  "summary": "one sentence, max 200 characters, action-oriented — this is what the skill catalog shows",
  "modes": ["act"],
  "intents": ["example_gallery_extract"]
}
```

- `summary`: required, single line, ≤200 characters. Describe what the skill does AND when to use it, e.g. "Extract and batch-download gallery images from example.com, including lazy-loaded pages and CDN naming patterns".
- `modes`: subset of ["ask", "act", "dev"]. Extraction/download recipes use ["act"]; read-only research recipes may include "ask".
- `intents`: up to 6 semantic routing hints, lowercase, only letters/digits/underscore/hyphen, ≤40 characters each (e.g. "example_gallery_extract", "example_article_text"). They are meaning hints, not literal keywords.

2. After the metadata block, write the plain-markdown body with these sections:
- `## When to use` — the concrete situations that trigger this skill.
- `## Site facts` — the site's quirks the model must know: URL patterns, pagination style, lazy loading, image CDN domains, anti-hotlink or blocker behavior, required login or CAPTCHA flow.
- `## Workflow` — numbered steps using ONLY tools that exist in this runtime. Never invent tools: no Playwright, no Selenium, no shell, no Python.
- `## Rules` — short imperative hard rules.

## Content rules for generated skills (this runtime's conventions)

- **Working directory is the destination.** When the `[WORKING DIRECTORY]` note is present, downloads go through `workspace_download` (the `download_files` family is blocked by the runtime), defaulting to a NEW subfolder named after the page title. Batch downloads are pattern-first: extract once, find the URL naming pattern (`xxx-1.jpg` … `xxx-48.jpg`), verify one middle + one last sample, then hand the generated list to `workspace_download` in one call — never scroll the whole page to "confirm" what the pattern covers.
- **Archives**: move a downloaded zip/7z/rar into the task subfolder first (`workspace_copy_in` from a whitelisted staging directory when the download landed there), then unpack with `workspace_extract` (zip/7z/rar/tar/gz/xz/bz2 supported; password-protected archives cannot be unpacked).
- **Blocker sites**: when direct fetches are blocked and only a virtual click on the page's own download button works, the file lands in a whitelisted staging folder (e.g. Chrome's Downloads). Use `workspace_whitelist_list` to see granted folders, `workspace_copy_in({dir, path, destPath, move})` to pull the file into the working directory, then `list_downloads` is NOT needed for the copy itself.
- Never claim the browser cannot write to local disk — the workspace tools write directly to the user's working directory.
- Keep the whole document under ~2500 words: a skill is a focused recipe, not documentation. Rules imperative and short, workflow steps concrete with exact tool names and arguments.
- Do not copy code from the page into the skill verbatim beyond a tiny regex/selector example; describe the pattern instead.

## Output form

Reply with the complete document as the raw text of your message — do NOT wrap the whole skill in an outer code fence (the `webbrain-skill` metadata block is already a fence; a second outer fence would break copy-paste). End your reply with one short line telling the user where to paste it: 设置 → Skills → 技能名称 → 技能文本 → 添加文本技能.
