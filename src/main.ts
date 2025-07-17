import {
  App,
  Plugin,
  ItemView,
  TFile,
  WorkspaceLeaf,
  Notice,
} from "obsidian";

const VIEW_TYPE_RAG_CHAT = "rag-chat-view";

// === Ollama config ===
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL = "mxbai-embed-large";
const OLLAMA_LLM_MODEL = "llama3";
const MAX_CONTEXT_TOKENS = 700;

// Plugin main
export default class RAGChatPlugin extends Plugin {
  async onload() {
    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RAGChatView(leaf, this)
    );
    this.addCommand({
      id: "open-rag-chat",
      name: "Open RAG Chat",
      callback: () => this.activateView(),
    });
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async activateView() {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getLeaf(false);
    if (!leaf) {
      new Notice("Could not open RAG Chat panel.");
      return;
    }
    await leaf.setViewState({
      type: VIEW_TYPE_RAG_CHAT,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async searchNotes(query: string): Promise<{ file: TFile; snippet: string }[]> {
    const STOP_WORDS = new Set([
      "what", "are", "the", "is", "of", "on", "to", "in", "and", "or",
      "a", "an", "for", "this", "that", "with",
    ]);
    const keywords = query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word && !STOP_WORDS.has(word));

    const files = this.app.vault.getMarkdownFiles();
    const results: { file: TFile; snippet: string }[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const contentLower = content.toLowerCase();
      if (keywords.some((word) => contentLower.includes(word))) {
        let firstIdx = -1;
        for (const word of keywords) {
          const idx = contentLower.indexOf(word);
          if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
            firstIdx = idx;
          }
        }
        const snippet = content
          .slice(Math.max(0, firstIdx - 50), firstIdx + 150)
          .replace(/\n+/g, " ");
        results.push({ file, snippet });
      }
    }
    return results;
  }
}

// === Ollama Helpers ===

async function ollamaEmbed(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: text }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  return data.embedding || data.embeddings?.[0];
}

async function ollamaEmbedBatch(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: texts }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  if (!Array.isArray(data.embeddings)) {
    throw new Error("Expected 'embeddings' to be an array.");
  }
  return data.embeddings;
}

async function ollamaChat(context: string, query: string): Promise<string> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_LLM_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant for an Obsidian vault. Only answer using the context provided.",
        },
        { role: "user", content: `Context:\n${context}\n\nQuery: ${query}` },
      ],
    }),
  });
  const raw = await resp.text();
  const data = safeParseOllamaJson(raw);
  return data.message?.content || data.response || "[no response]";
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const aMag = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const bMag = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (aMag * bMag + 1e-8);
}

function safeParseOllamaJson(raw: string): any {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Invalid response: JSON object not found.");
  }
  const jsonFragment = raw.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonFragment);
  } catch (err) {
    console.error("Failed to parse Ollama JSON extract:", jsonFragment);
    throw new Error("Ollama response could not be parsed as JSON.");
  }
}

// === Sidebar Chat View ===

class RAGChatView extends ItemView {
  plugin: RAGChatPlugin;
  chatContainer!: HTMLDivElement;
  inputEl!: HTMLTextAreaElement;
  isProcessing = false;

  constructor(leaf: WorkspaceLeaf, plugin: RAGChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RAG_CHAT;
  }
  getDisplayText(): string {
    return "RAG Chat";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen() {
  const container = this.containerEl;
  container.empty();

  container.setAttr("style",
    "height: 100%; width: 100%; min-width: 200px; display: flex; flex-direction: column; overflow: hidden;"
  );

  const outerContainer = container.createDiv("rag-chat-outer");
  outerContainer.setAttr("style",
    "display: flex; flex-direction: column; flex: 1 1 0; height: 100%; width: 100%; background: var(--background-primary);"
  );

  // Chat messages - add bottom padding larger than input height to avoid overlap
  this.chatContainer = outerContainer.createDiv("rag-chat-messages");
  this.chatContainer.setAttr(
    "style",
    "flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--divider-color); padding: 16px 16px 80px 16px; box-sizing: border-box; border-radius: 8px 8px 0 0;" +
    "background-color: var(--background-modifier-hover); font-size: 15px; min-height: 0; width: 100%;"
  );

  // Input container shifted up by 5% of height (approx)
  const inputContainer = outerContainer.createDiv();
  inputContainer.setAttr("style",
    "display: flex; flex-shrink: 0; gap: 8px; align-items: flex-end;" +
    "width: 100%; box-sizing: border-box; padding: 12px; background: var(--background-primary); border-top: 1px solid var(--divider-color);" +
    "transform: translateY(-5%);"
  );

    // Input expands to fill available width, button stays visible
    this.inputEl = inputContainer.createEl("textarea", { placeholder: "Ask a question..." });
    this.inputEl.setAttr("rows", "1");
    this.inputEl.setAttr("style",
      "flex: 1 1 0; min-width: 0; resize: none; max-height: 120px;" +
      "padding: 10px 12px; font-size: 15px; border-radius: 6px;" +
      "border: 1px solid var(--interactive-accent); overflow-y: auto;" +
      "font-family: var(--font-monospace); color: var(--text-normal); box-sizing: border-box;"
    );

    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
      this.inputEl.style.overflowY = this.inputEl.scrollHeight > 120 ? "auto" : "hidden";
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit();
      }
    });

    const sendButton = inputContainer.createEl("button", { text: "Send" });
    sendButton.setAttr("style", `
      flex-shrink: 0;
      height: 100%;
      padding: 0px 18px;
      border-radius: 6px;
      border: none;
      background-color: var(--interactive-accent);
      color: var(--text-on-interactive-accent);
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
      transition: background-color 0.2s;
      user-select: none;
      max-height: 44px;
      min-width: 64px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `);
    sendButton.onmouseenter = () => { sendButton.style.backgroundColor = "var(--interactive-accent-pressed)"; };
    sendButton.onmouseleave = () => { sendButton.style.backgroundColor = "var(--interactive-accent)"; };
    sendButton.onclick = () => this.handleSubmit();
  }

  addMessage(role: "user" | "rag", text: string) {
    const msg = this.chatContainer.createDiv();
    msg.setAttr("style",
      `margin-bottom: 14px; padding: 14px 20px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; user-select: text;` +
      `width: 100%; box-sizing: border-box; font-size: 15px; line-height: 1.45;` +
      `color: var(--text-normal); background-color: ${
        role === "user" ? "var(--background-primary)" : "var(--background-secondary-alt)"
      }; border: 1px solid var(--divider-color);` +
      `align-self: ${role === "user" ? "flex-end" : "flex-start"};`
    );
    msg.createSpan({ text });
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  approximateTokenCount(text: string): number {
    return text.trim().split(/\s+/).length;
  }

  buildContextWithTokenLimit(
    rankedSnippets: { file: TFile; snippet: string; sim: number }[]
  ): string {
    let tokenCount = 0;
    const chunks: string[] = [];

    for (const r of rankedSnippets) {
      const snippetTokens = this.approximateTokenCount(r.snippet) + 20;
      if (tokenCount + snippetTokens > MAX_CONTEXT_TOKENS) break;
      tokenCount += snippetTokens;
      chunks.push(`File: ${r.file.basename}\n${r.snippet}`);
    }
    return chunks.join("\n\n");
  }

  async handleSubmit() {
    if (this.isProcessing) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    this.addMessage("user", query);
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.isProcessing = true;
    try {
      const results = await this.plugin.searchNotes(query);
      if (results.length === 0) {
        this.addMessage("rag", "no matching notes found.");
        this.isProcessing = false;
        return;
      }

      this.addMessage("rag", "generating response...");
      const queryEmbedding = await ollamaEmbed(query);
      const snippets = results.map((r) => r.snippet);
      const snippetEmbeddings = await ollamaEmbedBatch(snippets);

      const ranked = results
        .map((res, i) => ({
          ...res,
          sim: cosineSimilarity(queryEmbedding, snippetEmbeddings[i]),
        }))
        .sort((a, b) => b.sim - a.sim);

      const context = this.buildContextWithTokenLimit(ranked);
      const answer = await ollamaChat(context, query);

      this.chatContainer.lastChild?.remove(); // remove loading message
      this.addMessage("rag", answer.trim());
    } catch (err: any) {
      this.chatContainer.lastChild?.remove();
      this.addMessage("rag", `❌ Error: ${String(err.message || err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async onClose() {}
}
