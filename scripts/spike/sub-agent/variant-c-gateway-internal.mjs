#!/usr/bin/env node
/**
 * Variant C — Gateway-internal sub-agent.
 *
 * Inside a single Node process, run two query() calls back-to-back with
 * different cwd / system prompts. The "parent" represents the operative;
 * the "sub-agent" represents a coding session in a project folder.
 *
 * Goal: verify that running a sub-query() in the same process does NOT
 * pollute the parent's context. We:
 *   1. Open a parent session, give it a memorable identity claim, end turn.
 *   2. Open a sub-agent query() in a different cwd, edit a file, end.
 *   3. Resume the parent session, ask "what's your identity?". Confirm
 *      the parent's answer references the original identity, not the
 *      sub-agent's coding-flavored prompt.
 *
 * Usage:
 *   node variant-c-gateway-internal.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeTempProject, cleanup, readReadme } from "./_temp.mjs";

const PARENT_SYSTEM_PROMPT = `You are Quill, a poetry-loving conversational
assistant. When asked who you are, you always say "I am Quill, a
poetry-loving assistant." Keep replies under 30 words.`;

const SUBAGENT_SYSTEM_PROMPT = `You are a coding sub-agent. You make
small, targeted file edits as instructed and then stop. You report
what you did in one sentence.`;

const SUBAGENT_PROMPT = `Append a single line to README.md that says
exactly:
"This file was edited by the variant-c sub-agent."
Then stop. Do not edit any other files.`;

async function runQuery({ prompt, options, label }) {
  let finalText = "";
  let toolUses = [];
  let resultSubtype = null;
  let sessionId = null;

  for await (const event of query({ prompt, options })) {
    if (event.type === "system" && event.subtype === "init") {
      sessionId = event.session_id ?? sessionId;
    } else if (event.type === "assistant" && event.message?.content) {
      const blocks = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) finalText += block.text;
        if (block.type === "tool_use") toolUses.push(block.name);
      }
    } else if (event.type === "result") {
      resultSubtype = event.subtype;
      sessionId = event.session_id ?? sessionId;
    }
  }

  return { finalText: finalText.trim(), toolUses, resultSubtype, sessionId };
}

async function main() {
  const projectDir = await makeTempProject("variant-c");
  console.log(`[variant-c] target project: ${projectDir}`);

  // STEP 1: Open the parent session with a memorable identity.
  console.log(`[variant-c] STEP 1: parent identity-claim turn`);
  const parentTurn1 = await runQuery({
    prompt: "Hello! Please confirm your name and role.",
    options: {
      systemPrompt: PARENT_SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      model: "sonnet",
      maxTurns: 2
    },
    label: "parent-1"
  });
  console.log(`[variant-c] parent turn-1 reply: ${parentTurn1.finalText}`);
  console.log(`[variant-c] parent session id: ${parentTurn1.sessionId}`);

  // STEP 2: Run the sub-agent in a different cwd, with a different
  // system prompt. We do this in the SAME node process to test isolation.
  console.log(`[variant-c] STEP 2: sub-agent coding turn (different cwd, different prompt)`);
  const before = await readReadme(projectDir);
  const subTurn = await runQuery({
    prompt: SUBAGENT_PROMPT,
    options: {
      cwd: projectDir,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      model: "sonnet",
      maxTurns: 5
    },
    label: "sub"
  });
  const after = await readReadme(projectDir);
  console.log(`[variant-c] sub-agent reply: ${subTurn.finalText}`);
  console.log(`[variant-c] sub-agent tools: ${subTurn.toolUses.join(", ")}`);
  console.log(`[variant-c] file changed: ${before !== after}`);

  // STEP 3: Resume the parent session, probe identity.
  console.log(`[variant-c] STEP 3: parent identity-probe turn (resumed)`);
  const parentTurn2 = await runQuery({
    prompt: "Quick check: who are you?",
    options: {
      systemPrompt: PARENT_SYSTEM_PROMPT,
      resume: parentTurn1.sessionId,
      permissionMode: "bypassPermissions",
      model: "sonnet",
      maxTurns: 2
    },
    label: "parent-2"
  });
  console.log(`[variant-c] parent turn-2 reply: ${parentTurn2.finalText}`);

  const isolationHeld = /quill/i.test(parentTurn2.finalText) &&
    !/coding sub-agent/i.test(parentTurn2.finalText);

  console.log(JSON.stringify({
    variant: "c-gateway-internal",
    file_changed: before !== after,
    sub_agent_result: subTurn.resultSubtype,
    parent_identity_preserved: isolationHeld,
    parent_turn1_text: parentTurn1.finalText,
    parent_turn2_text: parentTurn2.finalText,
    sub_agent_text: subTurn.finalText,
    sub_agent_tools: subTurn.toolUses
  }, null, 2));

  await cleanup(projectDir);
  process.exit(isolationHeld && before !== after ? 0 : 1);
}

main().catch(error => {
  console.error(`[variant-c] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
