#!/usr/bin/env node
/**
 * Variant A — CLI-shape skill.
 *
 * The Operative invokes this script via the Bash tool. The script imports
 * the SDK and runs query() with cwd set to a target project. This is the
 * most fitting-consistent shape — every existing skill (tier-classifier,
 * documents, projects-index) follows this pattern.
 *
 * Usage:
 *   node variant-a-cli-shape.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeTempProject, cleanup, readReadme } from "./_temp.mjs";

const PROMPT = `Append a single line to README.md that says exactly:
"This file was edited by the variant-a sub-agent."
Then stop. Do not edit any other files.`;

const SYSTEM_PROMPT = `You are a coding sub-agent. You make small, targeted file
edits as instructed and then stop. You report what you did in one sentence.`;

async function main() {
  const projectDir = await makeTempProject("variant-a");
  console.log(`[variant-a] target project: ${projectDir}`);

  const before = await readReadme(projectDir);
  console.log(`[variant-a] README.md before:\n${before}`);

  const start = Date.now();
  let chunkCount = 0;
  let firstChunkAt = null;
  let toolUses = [];
  let finalText = "";
  let resultSubtype = null;
  let costUsd = null;

  for await (const event of query({
    prompt: PROMPT,
    options: {
      cwd: projectDir,
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      model: "sonnet",
      maxTurns: 5
    }
  })) {
    if (event.type === "assistant" && event.message?.content) {
      const blocks = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          chunkCount++;
          if (firstChunkAt === null) firstChunkAt = Date.now() - start;
          finalText += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push({ name: block.name, input: block.input });
        }
      }
    } else if (event.type === "result") {
      resultSubtype = event.subtype;
      costUsd = event.total_cost_usd ?? null;
    }
  }

  const totalMs = Date.now() - start;
  const after = await readReadme(projectDir);
  console.log(`[variant-a] README.md after:\n${after}`);

  const fileChanged = before !== after;
  const success = resultSubtype === "success" && fileChanged;

  console.log(JSON.stringify({
    variant: "a-cli-shape",
    success,
    file_changed: fileChanged,
    result_subtype: resultSubtype,
    total_ms: totalMs,
    first_chunk_ms: firstChunkAt,
    chunks: chunkCount,
    tool_uses: toolUses.map(t => t.name),
    cost_usd: costUsd,
    final_text_chars: finalText.length
  }, null, 2));

  await cleanup(projectDir);
  process.exit(success ? 0 : 1);
}

main().catch(error => {
  console.error(`[variant-a] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
