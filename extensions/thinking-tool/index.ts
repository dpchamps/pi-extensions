/**
 * thinking tool extension — calls VibeThinker-3B for reasoning tasks
 *
 * This extension registers a tool that can be called by the pi agent to get
 * reasoning assistance from the VibeThinker-3B model running at a custom endpoint.
 *
 * Usage: The agent calls the "think" tool with a reasoning prompt, gets back
 * the full reasoning trace and answer, and can incorporate it into the context.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_ENDPOINT = "http://192.168.0.40:8000/v1";
const DEFAULT_MODEL_ID = "WeiboAI/VibeThinker-3B";

interface ThinkingConfig {
  endpoint: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

function loadConfig(): ThinkingConfig {
  // Try to load config from environment or use defaults
  return {
    endpoint: process.env.VIBETHINKER_ENDPOINT || DEFAULT_ENDPOINT,
    modelId: process.env.VIBETHINKER_MODEL_ID || DEFAULT_MODEL_ID,
    maxTokens: Number.parseInt(process.env.VIBETHINKER_MAX_TOKENS || "8192"),
    temperature: Number.parseFloat(process.env.VIBETHINKER_TEMPERATURE || "0.6"),
    topP: Number.parseFloat(process.env.VIBETHINKER_TOP_P || "0.95"),
  };
}

interface ThinkingResponse {
  choices: Array<{
    message: {
      content: string;
      reasoning?: string;
      reasoning_content?: string;
      thinking?: string;
    };
  }>;
}

/**
 * Calls the VibeThinker-3B API with a reasoning prompt
 * and returns the full reasoning trace and answer.
 */
async function callVibeThinker(
  config: ThinkingConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ reasoning: string; answer: string }> {
  const { endpoint, modelId, maxTokens, temperature, topP } = config;

  // Build the OpenAI-compatible request
  const requestBody: {
    model: string;
    messages: { role: "user"; content: string }[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    thinking?: { type: "enabled"; budget_tokens?: number };
  } = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: temperature,
    top_p: topP,
    stream: false,
  };

  // Add thinking config if available
  if (temperature === 1.0 && topP === 0.95) {
    // Enable thinking mode for reasoning tasks
    requestBody.thinking = {
      type: "enabled",
      budget_tokens: 16384, // 16K tokens for reasoning
    };
  }

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: signal ?? AbortSignal.timeout(120000), // 2 minute timeout
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`VibeThinker API error: ${response.status} ${errorText}`);
  }

  const result = await response.json() as ThinkingResponse;

  // Parse the response - handle both standard and thinking format
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error("Unexpected response format from VibeThinker");
  }

  // Extract reasoning and answer
  // VibeThinker returns reasoning in the "reasoning" field or in the message
  let reasoning = "";
  let answer = message.content || "";

  if (message.reasoning) {
    reasoning = message.reasoning;
    // Some formats might have both reasoning and answer
    if (message.reasoning_content) {
      answer = message.reasoning_content;
    }
  } else if (message.thinking) {
    // Alternative format with thinking field
    reasoning = message.thinking;
  }

  // Try to extract reasoning from message content if it's formatted
  // VibeThinker often wraps reasoning in <thinking> or similar tags
  if (!reasoning && answer) {
    // Check for common reasoning markers
    const reasoningMatch = answer.match(/<thinking>([\s\S]*?)<\/thinking>[\s\S]*?(?:<answer>([\s\S]*?)<\/answer>|$)/i);
    if (reasoningMatch) {
      reasoning = reasoningMatch[1] || "";
      answer = reasoningMatch[2] || answer;
    }
  }

  return { reasoning, answer };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerTool({
    name: "think",
    label: "Thinking Tool",
    description:
      "Call VibeThinker-3B for reasoning tasks. Use this for complex reasoning, " +
      "math problems, coding challenges, or any task that requires careful " +
      "step-by-step analysis. The model returns full reasoning traces.",
    promptSnippet: "Use the think tool for reasoning tasks",
    promptGuidelines: [
      "Use the think tool for complex reasoning, math problems, or coding challenges.",
      "The model returns full reasoning traces that you can incorporate into your answer.",
      "VibeThinker-3B is optimized for verifiable tasks with clear correctness signals.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The reasoning prompt to send to VibeThinker. Be specific and include all necessary context.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const result = await callVibeThinker(config, params.prompt, signal);

        // Format the output with reasoning trace
        const output = `## Reasoning Process
${result.reasoning}

## Answer
${result.answer}`;

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            endpoint: config.endpoint,
            model: config.modelId,
            hasReasoning: !!result.reasoning,
          },
        };
      } catch (err: any) {
        throw new Error(`Thinking tool failed: ${err.message}`);
      }
    },
  });

  // Log initialization
  console.log(`Thinking tool initialized: ${config.modelId} at ${config.endpoint}`);
}
