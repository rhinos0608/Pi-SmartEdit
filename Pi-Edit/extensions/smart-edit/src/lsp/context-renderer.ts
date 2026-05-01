/**
 * Context Renderer — Formats semantic retrieval results into Markdown.
 *
 * Enforces token budgets and organizes items by their relationship to the target.
 */

export interface ContextItem {
  symbolName: string;
  relationship: "definition" | "typeDefinition" | "implementation" | "reference" | "hover";
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  score: number;
  excerptKind: "hover" | "signature" | "skeleton" | "body" | "reference";
  text: string;
  truncated: boolean;
}

export interface ContextRendererDetails {
  tokenCount: number;
  warnings: string[];
  omittedDefinitions?: number;
  omittedReferences?: number;
}

export interface RenderOptions {
  maxTokens: number;
  cwd: string;
}

/**
 * Renders a set of ContextItems into a compact Markdown summary.
 */
export function renderSemanticContext(
  targetInfo: { path: string; range: { startLine: number; endLine: number }; source: string },
  items: ContextItem[],
  options: RenderOptions,
): { markdown: string; details: ContextRendererDetails } {
  const warnings: string[] = [];
  let tokenCount = 0;
  let markdown = `### Semantic context for \`${targetInfo.path}:${targetInfo.range.startLine}-${targetInfo.range.endLine}\`\n\n`;
  markdown += `Target resolved via: \`${targetInfo.source}\`\n\n`;

  tokenCount += estimateTokens(markdown);

  // Group items by relationship
  const groups: Record<string, ContextItem[]> = {
    definition: [],
    typeDefinition: [],
    implementation: [],
    reference: [],
    hover: [],
  };

  for (const item of items) {
    groups[item.relationship].push(item);
  }

  const sections = [
    { title: "Definitions", key: "definition" },
    { title: "Type Definitions", key: "typeDefinition" },
    { title: "Implementations", key: "implementation" },
    { title: "References/Examples", key: "reference" },
    { title: "Hover Info", key: "hover" },
  ];

  let omittedCounts: Record<string, number> = {
    definition: 0,
    typeDefinition: 0,
    implementation: 0,
    reference: 0,
    hover: 0,
  };

  for (const section of sections) {
    const sectionItems = groups[section.key];
    if (sectionItems.length === 0) continue;

    let sectionMarkdown = `#### ${section.title}\n`;
    let itemsRendered = 0;

    for (const item of sectionItems.sort((a, b) => b.score - a.score)) {
      const itemMarkdown = renderItem(item, options.cwd);
      const itemTokens = estimateTokens(itemMarkdown);

      if (tokenCount + itemTokens > options.maxTokens) {
        omittedCounts[section.key] += (sectionItems.length - itemsRendered);
        break;
      }

      sectionMarkdown += itemMarkdown;
      tokenCount += itemTokens;
      itemsRendered++;
    }

    if (itemsRendered > 0) {
      markdown += sectionMarkdown + "\n";
    }
  }

  if (Object.values(omittedCounts).some(c => c > 0)) {
    let footer = "\n---\n**Note:** Some items were omitted due to token budget limits:\n";
    if (omittedCounts.definition) footer += `- ${omittedCounts.definition} definitions\n`;
    if (omittedCounts.typeDefinition) footer += `- ${omittedCounts.typeDefinition} type definitions\n`;
    if (omittedCounts.implementation) footer += `- ${omittedCounts.implementation} implementations\n`;
    if (omittedCounts.reference) footer += `- ${omittedCounts.reference} references/examples\n`;
    
    markdown += footer;
    tokenCount += estimateTokens(footer);
  }

  return {
    markdown,
    details: {
      tokenCount,
      warnings,
      omittedDefinitions: omittedCounts.definition + omittedCounts.typeDefinition + omittedCounts.implementation,
      omittedReferences: omittedCounts.reference,
    },
  };
}

function renderItem(item: ContextItem, cwd: string): string {
  const relPath = item.uri.startsWith("file://") 
    ? item.uri.slice(7).replace(cwd, "").replace(/^\//, "")
    : item.uri;
  
  const rangeStr = `${item.range.start.line + 1}:${item.range.start.character}-${item.range.end.line + 1}:${item.range.end.character}`;
  
  let md = `- **${item.symbolName}** (\`${relPath}:${rangeStr}\`)\n`;
  
  // Use code blocks for snippets, except for hover (which is often already markdown)
  if (item.excerptKind === "hover") {
    md += `  ${item.text.split("\n").join("\n  ")}\n`;
  } else {
    // Detect language from URI for code block
    const ext = item.uri.split(".").pop() || "text";
    const lang = ext === "ts" ? "ts" : ext === "js" ? "js" : ext === "py" ? "python" : "text";
    
    md += `  \`\`\`${lang}\n  ${item.text.split("\n").join("\n  ")}\n  \`\`\`\n`;
  }
  
  return md;
}

/**
 * Estimate tokens based on characters. LSP-RAG spec uses length / 4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
