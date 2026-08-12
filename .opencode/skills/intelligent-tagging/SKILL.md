---
name: intelligent-tagging
description: Classify an article against a supplied reusable tag set and propose only essential new tags.
---

# Intelligent Tagging

Classify the supplied article by its subject, argument, and durable use. Do not perform keyword matching or create tags merely because a word appears often.

Return every existing tag that is materially relevant. Prefer an existing tag whenever its meaning covers the article, including close synonyms and capitalization variants.

Create the smallest possible number of new tags only when the existing set cannot express an important, reusable category. Every new tag needs a concise description that will remain useful for future articles. Do not create article-specific, temporary, or overly broad tags.

Obey the structured JSON schema supplied in the request. Never read or write tag files and never attempt to persist article-tag relationships. The calling service owns all final validation and writes.