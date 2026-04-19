import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";

const client = new Anthropic();
const limit = pLimit(5); // Max 5 concurrent Haiku calls

// Haiku pricing: $1/M input, $5/M output
const HAIKU_INPUT_COST = 1.0 / 1_000_000;
const HAIKU_OUTPUT_COST = 5.0 / 1_000_000;

export interface AiFilterResult {
  items: Record<string, any>[];
  cost_usd: number;
}

export async function aiFilter(
  items: Record<string, any>[],
  filterPrompt: string,
): Promise<AiFilterResult> {
  let totalCost = 0;

  const results = await Promise.all(
    items.map((item) =>
      limit(async () => {
        try {
          const { pass, cost } = await filterItem(item, filterPrompt);
          totalCost += cost;
          return pass ? item : null;
        } catch (err) {
          console.warn("AI filter failed for item, including it:", err);
          return item; // Fail-safe: include on error
        }
      })
    )
  );

  return {
    items: results.filter((item): item is Record<string, any> => item !== null),
    cost_usd: totalCost,
  };
}

async function filterItem(
  item: Record<string, any>,
  filterPrompt: string,
): Promise<{ pass: boolean; cost: number }> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 10,
    messages: [
      {
        role: "user",
        content: `You are a filter. Given the item below, decide if it passes the filter criteria.

Filter criteria: ${filterPrompt}

Item:
${JSON.stringify(item, null, 2)}

Respond with exactly "yes" or "no". Nothing else.`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "";
  const cost =
    (response.usage.input_tokens * HAIKU_INPUT_COST) +
    (response.usage.output_tokens * HAIKU_OUTPUT_COST);

  return { pass: text.startsWith("yes"), cost };
}
