---
name: duty-image
description: Produce an image from a text prompt. The image-production duty — no image path existed in the composition before, so this is the simplest HONEST working path: invoke an image-capable model the operative can already reach (the gemini runtime, or an image MCP tool) with the prompt and save the result to the artifact store. Use when a change or task needs a generated image (a diagram, an illustration, a mockup asset) from a description.
---

# Image duty

Fulfil the **image** duty: turn a text prompt into an image file and hand back its
path. Keep this simple and honest — it is a documented working path, not an
automated generation service.

## The path

1. **Pick an image-capable model the operative can reach.**
   - **Default: the gemini runtime.** The `gemini` CLI ships with the
     gemini-runtime fitting. Use an image-generation model (e.g. an Imagen model) —
     the general text model (`gemini-2.5-flash`) does not generate images, so name
     an image model explicitly.
   - **Alternative: an image MCP tool.** If the running composition exposes an
     image-generation MCP tool, call that instead.
2. **Send the prompt.** Pass the user's description through to the chosen model.
   Example shape (adjust the model/flags to the installed CLI version):

   ```
   gemini generate-image --model <image-model> \
     --prompt "<the image description>" \
     --out ~/.garrison/files/<slug>.png
   ```

3. **Save to the artifact store.** Write the image into the artifact store — the
   file-browser root, `~/.garrison/files` by default — with a descriptive name.
   Return the saved path (and a `garrison://file-browser/...` link when surfacing
   it in a channel) as the duty's output.

## Honesty

- This duty depends on an image-capable model being configured and reachable. If
  none is (only text models are available), **say so plainly and stop** — do not
  fabricate a file or claim an image was produced.
- Do not build a heavy generation pipeline here. One prompt in, one saved image
  out, through whatever image-capable model the composition already provides.
